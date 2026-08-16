// audit-carrier-base-urls pure-layer tests.
//
// The verdict logic itself is pinned in
// `packages/shipping/src/carrier-base-url-screen.test.ts`. These
// tests cover what the SCRIPT adds on top: that a pre-existing
// offending row survives the batch pipeline into an emitted line,
// that the emitted line carries no secret, that the exit code is what
// a scheduled run depends on, and that CLI parsing holds.
//
// All fixtures are synthetic: RFC 2606 reserved names, reserved
// address blocks, and userinfo placeholders that are not key-shaped.

import { CarrierCredentialStatus, ShippingProvider } from "@pharmax/database";
import {
  summarizeCarrierBaseUrlFindings,
  type StoredCarrierCredentialRow,
} from "@pharmax/shipping";
import { describe, expect, it } from "vitest";

import {
  collectFindings,
  exitCodeForSummary,
  findingLine,
  parseCli,
  remediationNarrative,
  summaryLine,
} from "./audit-carrier-base-urls.js";

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

describe("collectFindings", () => {
  it("detects a pre-existing offending row among healthy ones", () => {
    // The whole point of the tool: the write path is screened now, so
    // the only offenders left are rows that predate the guard. This
    // is one of them, sitting in a page of clean rows.
    const findings = collectFindings([
      row({ id: "clean-default", baseUrl: null }),
      row({ id: "clean-explicit", baseUrl: "https://apis.fedex.com" }),
      row({
        id: "offender-private",
        organizationId: ORG_B,
        provider: ShippingProvider.UPS,
        baseUrl: "https://192.168.10.20",
      }),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      credentialId: "offender-private",
      organizationId: ORG_B,
      provider: ShippingProvider.UPS,
      reason: "non_public_host",
      dialledToday: true,
    });
  });

  it("returns nothing for a table with no offending rows", () => {
    expect(
      collectFindings([row({ baseUrl: null }), row({ baseUrl: "https://api.easypost.com" })])
    ).toEqual([]);
  });

  it("reports every distinct cause the guard can raise", () => {
    const findings = collectFindings([
      row({ id: "a", baseUrl: "http://carrier.example.com" }),
      row({ id: "b", baseUrl: "https://169.254.169.254" }),
      row({ id: "c", baseUrl: "https://carrier.example.com:8443" }),
      row({ id: "d", baseUrl: "https://placeholder-user:placeholder-pass@carrier.example.com" }),
      row({ id: "e", baseUrl: "not a url at all" }),
    ]);

    expect(findings.map((f) => f.reason)).toEqual([
      "not_https",
      "non_public_host",
      "non_default_port",
      "embedded_credentials",
      "unparseable",
    ]);
  });
});

describe("findingLine", () => {
  it("emits one parseable JSON object tagged as a finding", () => {
    const [finding] = collectFindings([row({ baseUrl: "https://10.0.0.5" })]);
    const parsed = JSON.parse(findingLine(finding!)) as Record<string, unknown>;

    expect(parsed).toMatchObject({
      kind: "finding",
      credentialId: "11111111-1111-4111-8111-000000000001",
      organizationId: ORG_A,
      provider: "FEDEX",
      status: "ACTIVE",
      dialledToday: true,
      reason: "non_public_host",
      redactedBaseUrl: "https://10.0.0.5",
      createdAt: "2026-05-01T00:00:00.000Z",
    });
  });

  it("is a single line, so stdout stays line-delimited JSON", () => {
    const [finding] = collectFindings([row({ baseUrl: "https://10.0.0.5" })]);
    expect(findingLine(finding!)).not.toContain("\n");
  });

  it("carries no credential from a userinfo-bearing stored URL", () => {
    // This is the property that makes the output ticket-safe. A row
    // written before the guard can hold its own credential in
    // userinfo, so printing baseUrl verbatim would leak a secret.
    const [finding] = collectFindings([
      row({ baseUrl: "https://placeholder-user:placeholder-pass@carrier.example.com/oauth/token" }),
    ]);
    const line = findingLine(finding!);

    expect(line).not.toContain("placeholder-user");
    expect(line).not.toContain("placeholder-pass");
    expect(line).not.toContain("/oauth/token");
    expect(line).toContain('"redactedBaseUrl":"https://carrier.example.com"');
  });

  it("carries no bearer token from a query string", () => {
    const [finding] = collectFindings([
      row({ baseUrl: "http://10.0.0.5/collect?token=placeholder-token" }),
    ]);
    expect(findingLine(finding!)).not.toContain("placeholder-token");
  });
});

describe("summaryLine", () => {
  it("emits one parseable JSON object tagged as a summary", () => {
    const findings = collectFindings([
      row({ id: "a", baseUrl: "https://10.0.0.5" }),
      row({
        id: "b",
        organizationId: ORG_B,
        baseUrl: "http://carrier.example.com",
        status: CarrierCredentialStatus.DISABLED,
      }),
    ]);
    const parsed = JSON.parse(summaryLine(summarizeCarrierBaseUrlFindings(findings))) as Record<
      string,
      unknown
    >;

    expect(parsed).toEqual({
      kind: "summary",
      total: 2,
      dialledToday: 1,
      organizationsAffected: 2,
      byReason: { non_public_host: 1, not_https: 1 },
    });
  });
});

describe("exitCodeForSummary", () => {
  it("exits 0 on a clean scan", () => {
    expect(exitCodeForSummary(summarizeCarrierBaseUrlFindings([]))).toBe(0);
  });

  it("exits 1 when anything was found, so a scheduled run alerts", () => {
    const findings = collectFindings([row({ baseUrl: "https://10.0.0.5" })]);
    expect(exitCodeForSummary(summarizeCarrierBaseUrlFindings(findings))).toBe(1);
  });

  it("exits 1 even when the only finding is a DISABLED row", () => {
    // The credential was still exposed and still needs rotating, so
    // a clean bill of health would be a false reassurance.
    const findings = collectFindings([
      row({ baseUrl: "https://10.0.0.5", status: CarrierCredentialStatus.DISABLED }),
    ]);
    expect(exitCodeForSummary(summarizeCarrierBaseUrlFindings(findings))).toBe(1);
  });
});

describe("remediationNarrative", () => {
  it("prescribes rotation before re-registration and never suggests this tool disables a row", () => {
    const findings = collectFindings([row({ baseUrl: "https://10.0.0.5" })]);
    const narrative = remediationNarrative(summarizeCarrierBaseUrlFindings(findings));

    expect(narrative).toContain("ROTATE");
    expect(narrative).toContain("RegisterCarrierCredential");
    expect(narrative.indexOf("ROTATE")).toBeLessThan(narrative.indexOf("RE-REGISTER"));
    expect(narrative).toContain("will not make that call for you");
  });

  it("says so plainly when nothing was found", () => {
    const narrative = remediationNarrative(summarizeCarrierBaseUrlFindings([]));
    expect(narrative).toBe("No stored carrier base URL fails the outbound-URL guard.");
  });
});

describe("parseCli", () => {
  it("defaults to scanning every organization", () => {
    expect(parseCli([])).toEqual({});
  });

  it("forwards --org", () => {
    expect(parseCli([`--org=${ORG_A}`])).toEqual({ organizationId: ORG_A });
  });

  it("strips the pnpm -- separator", () => {
    expect(parseCli(["--", `--org=${ORG_A}`])).toEqual({ organizationId: ORG_A });
  });

  it("surfaces usage on --help", () => {
    expect("error" in parseCli(["--help"])).toBe(true);
  });
});
