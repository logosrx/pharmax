// PHI pattern redaction shared by the Node, browser, and Edge Sentry
// runtimes.
//
// The behaviour under test is the one the previous implementation
// declined to build: sweeping PHI shapes out of free text. The stated
// reason was that scrubbing messages "would destroy the grouping
// fingerprint", leaving call-site discipline as the only control. These
// tests pin the opposite — that STABLE tokens keep grouping intact and
// in fact tighten it, because the redacted part is the variable part.
//
// CLEAN ROOM / PHI: every fixture below is synthetic.

import { describe, expect, it } from "vitest";

import { buildBeforeSend, redactPhiPatterns, scrubBreadcrumb } from "./sentry-scrub-core.js";

const send = buildBeforeSend({ enabledInEnvironment: true });

function errorEventWith(value: string) {
  return { exception: { values: [{ type: "Error", value }] } } as never;
}

function valueOf(event: unknown): string {
  return (event as { exception: { values: Array<{ value: string }> } }).exception.values[0]!.value;
}

describe("redactPhiPatterns", () => {
  it("redacts an email address", () => {
    expect(redactPhiPatterns("Recipient jane.doe+rx@example.com not found")).toBe(
      "Recipient [email] not found"
    );
  });

  it("redacts US phone numbers in several formats", () => {
    for (const phone of ["555-867-5309", "(555) 867-5309", "555.867.5309", "+1 555 867 5309"]) {
      expect(redactPhiPatterns(`call ${phone} now`), phone).toBe("call [phone] now");
    }
  });

  it("redacts an SSN without letting the phone rule consume it first", () => {
    expect(redactPhiPatterns("ssn 123-45-6789 rejected")).toBe("ssn [ssn] rejected");
  });

  it("redacts a street address", () => {
    expect(redactPhiPatterns("Invalid address: 1211 N Franklin Street")).toBe(
      "Invalid address: [address]"
    );
  });

  it("redacts a bare date of birth", () => {
    expect(redactPhiPatterns("dob 1985-03-22 invalid")).toBe("dob [date] invalid");
    expect(redactPhiPatterns("dob 3/22/1985 invalid")).toBe("dob [date] invalid");
  });

  it("keeps ISO timestamps, which are debugging value and never a birth date", () => {
    const text = "failed at 2026-08-17T22:15:00Z";
    expect(redactPhiPatterns(text)).toBe(text);
  });

  it("redacts ZIP+4", () => {
    expect(redactPhiPatterns("zip 33602-1234 unroutable")).toBe("zip [zip] unroutable");
  });

  it("leaves text with no PHI shapes untouched", () => {
    const text = "ORDER_INVALID_TRANSITION: expected RELEASED, got TESTING";
    expect(redactPhiPatterns(text)).toBe(text);
  });

  it("does not mangle a UUID", () => {
    const text = "order 00000000-0000-4000-8000-000000000001 not found";
    expect(redactPhiPatterns(text)).toBe(text);
  });
});

describe("grouping stability", () => {
  // This is the crux of the original objection. If redaction produced
  // variable output it WOULD wreck the fingerprint; because the token
  // is stable, two messages that differ only in their PHI collapse to
  // one issue instead of two.
  it("collapses messages that differ only by the PHI they interpolate", () => {
    const a = redactPhiPatterns("Recipient alice@example.com not found");
    const b = redactPhiPatterns("Recipient bob@example.org not found");
    expect(a).toBe(b);
  });

  it("keeps genuinely different errors distinct", () => {
    const a = redactPhiPatterns("Recipient alice@example.com not found");
    const b = redactPhiPatterns("Recipient alice@example.com is unroutable");
    expect(a).not.toBe(b);
  });

  it("is idempotent, so a re-scrubbed event fingerprints identically", () => {
    const once = redactPhiPatterns("dob 1985-03-22 for jane@example.com");
    expect(redactPhiPatterns(once)).toBe(once);
  });
});

describe("beforeSend free-text handling", () => {
  it("redacts PHI out of the exception value", () => {
    const out = send(errorEventWith("FedEx rejected 1211 N Franklin Street for jane@x.com"), {});
    expect(valueOf(out)).toBe("FedEx rejected [address] for [email]");
  });

  it("still caps a runaway message", () => {
    const out = send(errorEventWith("x".repeat(900)), {});
    expect(valueOf(out).length).toBeLessThanOrEqual(501);
    expect(valueOf(out).endsWith("…")).toBe(true);
  });

  it("redacts before capping, so truncation cannot split a match", () => {
    // Put an email right at the boundary: capping first would leave a
    // half-redacted fragment in the payload.
    const out = send(errorEventWith(`${"x".repeat(480)} jane.doe@example.com tail`), {});
    expect(valueOf(out)).not.toContain("jane.doe");
    expect(valueOf(out)).not.toContain("example.com");
  });

  it("redacts allowlisted free-text metadata rather than trusting call sites", () => {
    const event = { extra: { errorMessage: "carrier rejected jane@example.com" } } as never;
    const out = send(event, {}) as unknown as { extra: Record<string, string> };
    expect(out.extra["errorMessage"]).toBe("carrier rejected [email]");
  });
});

describe("scrubBreadcrumb", () => {
  it("redacts PHI from a breadcrumb message", () => {
    const out = scrubBreadcrumb({ category: "xhr", message: "lookup for jane@example.com" });
    expect(out?.message).toBe("lookup for [email]");
  });

  it("still blanks console breadcrumbs wholesale", () => {
    const out = scrubBreadcrumb({ category: "console", message: "anything at all" });
    expect(out?.message).toBe("[Redacted]");
  });
});
