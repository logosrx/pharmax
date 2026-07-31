import { describe, expect, it } from "vitest";

import { signWebhookPayload, verifyWebhookSignature } from "./signature.js";

const SECRET = "pxw_test-secret-for-signature-unit-tests-000000";
const BODY = JSON.stringify({ id: "d-1", type: "order.shipped.v1", data: { orderId: "o-1" } });

describe("signWebhookPayload / verifyWebhookSignature", () => {
  it("round-trips a valid signature", () => {
    const now = 1_800_000_000;
    const header = signWebhookPayload({ secret: SECRET, timestamp: now, body: BODY });
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature({ secret: SECRET, header, body: BODY, nowSeconds: now })).toBe(
      true
    );
  });

  it("rejects a tampered body", () => {
    const now = 1_800_000_000;
    const header = signWebhookPayload({ secret: SECRET, timestamp: now, body: BODY });
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        header,
        body: BODY.replace("o-1", "o-2"),
        nowSeconds: now,
      })
    ).toBe(false);
  });

  it("rejects the wrong secret", () => {
    const now = 1_800_000_000;
    const header = signWebhookPayload({ secret: SECRET, timestamp: now, body: BODY });
    expect(
      verifyWebhookSignature({ secret: "pxw_other", header, body: BODY, nowSeconds: now })
    ).toBe(false);
  });

  it("rejects a stale timestamp outside tolerance (replay window)", () => {
    const signedAt = 1_800_000_000;
    const header = signWebhookPayload({ secret: SECRET, timestamp: signedAt, body: BODY });
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        header,
        body: BODY,
        nowSeconds: signedAt + 301,
      })
    ).toBe(false);
    // Boundary: exactly at tolerance still verifies.
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        header,
        body: BODY,
        nowSeconds: signedAt + 300,
      })
    ).toBe(true);
  });

  it("rejects a FORGED timestamp (t moved, MAC unchanged)", () => {
    const signedAt = 1_800_000_000;
    const header = signWebhookPayload({ secret: SECRET, timestamp: signedAt, body: BODY });
    const forged = header.replace(`t=${signedAt}`, `t=${signedAt + 100}`);
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        header: forged,
        body: BODY,
        nowSeconds: signedAt + 100,
      })
    ).toBe(false);
  });

  it("rejects malformed headers", () => {
    const now = 1_800_000_000;
    for (const header of ["", "garbage", "t=,v1=", "t=123", "v1=abc", "t=abc,v1=def"]) {
      expect(verifyWebhookSignature({ secret: SECRET, header, body: BODY, nowSeconds: now })).toBe(
        false
      );
    }
  });
});
