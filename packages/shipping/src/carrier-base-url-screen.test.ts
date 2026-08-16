// Stored-baseUrl screening tests.
//
// The scenario under test is the one the write-time guard cannot
// reach: a `carrier_credential` row that was written BEFORE
// `RegisterCarrierCredential` screened `baseUrl`, and which the read
// path still hands to a carrier client on every poller tick.
//
// All hosts below are RFC 2606 reserved names or reserved address
// blocks, and the userinfo placeholders are deliberately not
// key-shaped. No PHI, no real credentials, no real carrier hosts
// beyond the public API hostnames the clients already default to.

import { CarrierCredentialStatus, ShippingProvider } from "@pharmax/database";
import { describe, expect, it } from "vitest";

import {
  type CarrierBaseUrlFinding,
  screenStoredCarrierBaseUrl,
  type StoredCarrierCredentialRow,
  summarizeCarrierBaseUrlFindings,
} from "./carrier-base-url-screen.js";

const ORG_A = "00000000-0000-4000-8000-0000000000a1";
const ORG_B = "00000000-0000-4000-8000-0000000000b2";

const row = (overrides: Partial<StoredCarrierCredentialRow> = {}): StoredCarrierCredentialRow => ({
  id: "11111111-1111-4111-8111-000000000001",
  organizationId: ORG_A,
  provider: ShippingProvider.FEDEX,
  status: CarrierCredentialStatus.ACTIVE,
  baseUrl: null,
  createdAt: new Date("2026-05-01T00:00:00.000Z"),
  ...overrides,
});

describe("screenStoredCarrierBaseUrl — clean rows", () => {
  it("passes a row with no baseUrl override", () => {
    // No override means the client falls back to the carrier's own
    // default host, which is always a legitimate destination.
    expect(screenStoredCarrierBaseUrl(row({ baseUrl: null }))).toBeNull();
  });

  it("passes every base URL the carrier clients legitimately target", () => {
    for (const baseUrl of [
      "https://apis.fedex.com",
      "https://apis-sandbox.fedex.com",
      "https://onlinetools.ups.com",
      "https://wwwcie.ups.com",
      "https://api.easypost.com",
    ]) {
      expect(screenStoredCarrierBaseUrl(row({ baseUrl }))).toBeNull();
    }
  });
});

describe("screenStoredCarrierBaseUrl — pre-existing offending rows", () => {
  it("detects a private-network baseUrl stored before the write-time guard", () => {
    const finding = screenStoredCarrierBaseUrl(
      row({ baseUrl: "https://10.0.0.5", createdAt: new Date("2026-06-02T09:15:00.000Z") })
    );

    expect(finding).not.toBeNull();
    expect(finding).toMatchObject({
      credentialId: "11111111-1111-4111-8111-000000000001",
      organizationId: ORG_A,
      provider: ShippingProvider.FEDEX,
      status: CarrierCredentialStatus.ACTIVE,
      reason: "non_public_host",
      redactedBaseUrl: "https://10.0.0.5",
      createdAt: "2026-06-02T09:15:00.000Z",
    });
    expect(finding?.detail).toContain("RFC1918 private");
  });

  it("detects a link-local baseUrl — the cloud metadata service", () => {
    const finding = screenStoredCarrierBaseUrl(row({ baseUrl: "https://169.254.169.254" }));
    expect(finding?.reason).toBe("non_public_host");
    expect(finding?.detail).toContain("link-local");
  });

  it("detects an http:// baseUrl", () => {
    const finding = screenStoredCarrierBaseUrl(row({ baseUrl: "http://carrier.example.com" }));
    expect(finding?.reason).toBe("not_https");
    expect(finding?.redactedBaseUrl).toBe("http://carrier.example.com");
  });

  it("detects a loopback baseUrl written through a numeric spelling", () => {
    // The guard judges the WHATWG-parsed URL, so the decimal form
    // collapses to 127.0.0.1 before the address tables see it.
    const finding = screenStoredCarrierBaseUrl(row({ baseUrl: "https://2130706433" }));
    expect(finding?.reason).toBe("non_public_host");
    expect(finding?.detail).toContain("loopback");
  });

  it("detects a non-default port", () => {
    const finding = screenStoredCarrierBaseUrl(
      row({ baseUrl: "https://carrier.example.com:8443" })
    );
    expect(finding?.reason).toBe("non_default_port");
    expect(finding?.redactedBaseUrl).toBe("https://carrier.example.com:8443");
  });
});

describe("screenStoredCarrierBaseUrl — the finding is safe to paste into a ticket", () => {
  it("never echoes userinfo credentials from the stored URL", () => {
    // This is the case that makes redaction load-bearing rather than
    // cosmetic: a row written before the guard can carry its own
    // credential in userinfo, so printing `baseUrl` verbatim would
    // put a secret in the audit output.
    const finding = screenStoredCarrierBaseUrl(
      row({ baseUrl: "https://placeholder-user:placeholder-pass@carrier.example.com/oauth/token" })
    );

    expect(finding?.reason).toBe("embedded_credentials");
    expect(finding?.redactedBaseUrl).toBe("https://carrier.example.com");

    const serialized = JSON.stringify(finding);
    expect(serialized).not.toContain("placeholder-user");
    expect(serialized).not.toContain("placeholder-pass");
  });

  it("never echoes a path or query, which can carry a bearer token", () => {
    const finding = screenStoredCarrierBaseUrl(
      row({ baseUrl: "http://10.0.0.5/collect?token=placeholder-token" })
    );
    const serialized = JSON.stringify(finding);
    expect(serialized).not.toContain("placeholder-token");
    expect(serialized).not.toContain("/collect");
  });

  it("does not tokenize an unparseable stored value at all", () => {
    const finding = screenStoredCarrierBaseUrl(row({ baseUrl: "not a url at all" }));
    expect(finding?.reason).toBe("unparseable");
    expect(finding?.redactedBaseUrl).toBe("<unparseable>");
  });
});

describe("screenStoredCarrierBaseUrl — triage axis", () => {
  it("marks the ACTIVE row as dialled today", () => {
    // resolveShippingAdapter only ever selects the ACTIVE row, so
    // this is what separates "leaking on every tick right now" from
    // "already exposed, no longer being re-sent".
    const finding = screenStoredCarrierBaseUrl(
      row({ baseUrl: "https://10.0.0.5", status: CarrierCredentialStatus.ACTIVE })
    );
    expect(finding?.dialledToday).toBe(true);
  });

  it("still reports a DISABLED row, but not as dialled today", () => {
    const finding = screenStoredCarrierBaseUrl(
      row({ baseUrl: "https://10.0.0.5", status: CarrierCredentialStatus.DISABLED })
    );
    // Reported, because the credential was exposed and still needs
    // rotating — the row simply is not the one being re-dialled.
    expect(finding).not.toBeNull();
    expect(finding?.dialledToday).toBe(false);
  });
});

describe("summarizeCarrierBaseUrlFindings", () => {
  const finding = (overrides: Partial<CarrierBaseUrlFinding>): CarrierBaseUrlFinding => ({
    credentialId: "22222222-2222-4222-8222-000000000002",
    organizationId: ORG_A,
    provider: ShippingProvider.UPS,
    status: CarrierCredentialStatus.ACTIVE,
    dialledToday: true,
    reason: "non_public_host",
    detail: "Host is a non-public destination: RFC1918 private.",
    redactedBaseUrl: "https://10.0.0.5",
    createdAt: "2026-06-02T09:15:00.000Z",
    ...overrides,
  });

  it("counts totals, live rows, distinct orgs, and causes", () => {
    const summary = summarizeCarrierBaseUrlFindings([
      finding({}),
      finding({ organizationId: ORG_B, reason: "not_https" }),
      finding({
        organizationId: ORG_B,
        status: CarrierCredentialStatus.DISABLED,
        dialledToday: false,
        reason: "not_https",
      }),
    ]);

    expect(summary).toEqual({
      total: 3,
      dialledToday: 2,
      organizationsAffected: 2,
      byReason: { non_public_host: 1, not_https: 2 },
    });
  });

  it("summarizes an empty scan as a clean bill", () => {
    expect(summarizeCarrierBaseUrlFindings([])).toEqual({
      total: 0,
      dialledToday: 0,
      organizationsAffected: 0,
      byReason: {},
    });
  });
});
