import { describe, expect, it } from "vitest";

import { redactAndCap, redactPhiPatterns } from "./redact.js";

describe("redactPhiPatterns", () => {
  it("redacts the shape that motivated this module", () => {
    // Verbatim from the 2026 incident-response tabletop: a carrier API
    // error echoing the addressee. This exact string was transmitted to
    // Sentry unredacted before 2026-08-20, because it is under the
    // 500-character cap that was the only control on this path.
    const carrierError = "Failed to create label for Jane Smith, 123 Main St, Springfield IL 62701";
    const out = redactPhiPatterns(carrierError);

    expect(out).not.toContain("123 Main St");
    expect(out).toContain("[address]");
  });

  it.each([
    ["ssn", "SSN 123-45-6789 on file", "[ssn]", "123-45-6789"],
    ["zip+4", "ships to 62701-1234", "[zip]", "62701-1234"],
    ["email", "notify jane.doe@example.com now", "[email]", "jane.doe@example.com"],
    ["phone", "call (555) 867-5309 today", "[phone]", "867-5309"],
    ["parenthesised phone", "at (555) 867-5309.", "[phone]", "555"],
    ["street address", "at 400 Oak Avenue today", "[address]", "400 Oak Avenue"],
    ["iso date", "born 1962-07-04 in Ohio", "[date]", "1962-07-04"],
    ["us date", "dated 7/4/1962 exactly", "[date]", "7/4/1962"],
  ])("redacts %s", (_label, input, token, leaked) => {
    const out = redactPhiPatterns(input);
    expect(out).toContain(token);
    expect(out).not.toContain(leaked);
  });

  it("leaves an ISO timestamp intact, because it is debugging value and never a birth date", () => {
    const out = redactPhiPatterns("failed at 2026-08-20T14:31:02.000Z");
    expect(out).toContain("2026-08-20T14:31:02.000Z");
  });

  it("does not reach into a UUID", () => {
    const uuid = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
    expect(redactPhiPatterns(`order ${uuid} failed`)).toContain(uuid);
  });

  it("produces a stable token, so redaction improves grouping rather than harming it", () => {
    // The objection this module had to answer: scrubbing exception text
    // "destroys the grouping fingerprint". It does the opposite —
    // variable content is exactly what should not be in a fingerprint.
    const a = redactPhiPatterns("Recipient jane@x.com not found");
    const b = redactPhiPatterns("Recipient bob@y.com not found");
    expect(a).toBe(b);
  });

  it("is idempotent, so a value redacted twice is unchanged", () => {
    const once = redactPhiPatterns("call 555-867-5309");
    expect(redactPhiPatterns(once)).toBe(once);
  });

  it("does not leak lastIndex between calls on the global regexes", () => {
    const input = "a@b.com and c@d.com";
    const first = redactPhiPatterns(input);
    const second = redactPhiPatterns(input);
    expect(second).toBe(first);
    expect(first).not.toContain("@");
  });

  it("leaves ordinary prose alone", () => {
    const prose = "Order advanced from PV1_IN_PROGRESS to PV1_APPROVED_READY_FOR_FILL";
    expect(redactPhiPatterns(prose)).toBe(prose);
  });
});

describe("redactAndCap", () => {
  it("redacts before capping, so a truncation point cannot split a match", () => {
    // The ordering bug this guards: cap first and "…123 Main St" can be
    // cut to "123 Mai", which no longer matches the address rule and
    // would transmit as-is. The address sits past the cap deliberately.
    const filler = "x".repeat(60);
    const text = `${filler} at 123 Main Street now`;
    const out = redactAndCap(text, 64);

    expect(out).not.toContain("123 Mai");
    expect(out).not.toContain("123 Main Street");
  });

  it("caps once the text is clean", () => {
    const out = redactAndCap("y".repeat(100), 20);
    expect(out).toHaveLength(21); // 20 + the ellipsis
    expect(out.endsWith("…")).toBe(true);
  });

  it("leaves short text uncapped and without an ellipsis", () => {
    expect(redactAndCap("short", 500)).toBe("short");
  });
});
