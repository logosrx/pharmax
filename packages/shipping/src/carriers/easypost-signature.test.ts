import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  EasyPostSignatureError,
  EasyPostWebhookConfigError,
  verifyEasyPostSignature,
} from "./easypost-signature.js";

const SECRET = "test_secret_value";

function signHex(body: string): string {
  return createHmac("sha256", SECRET).update(body, "utf8").digest("hex");
}

describe("verifyEasyPostSignature", () => {
  it("accepts a correctly signed payload", () => {
    const body = '{"id":"evt_1","description":"tracker.updated"}';
    const result = verifyEasyPostSignature({
      rawBody: body,
      signatureHeader: signHex(body),
      webhookSecret: SECRET,
    });
    expect(result.ok).toBe(true);
  });

  it("accepts the prefixed signature form", () => {
    const body = '{"x":1}';
    const result = verifyEasyPostSignature({
      rawBody: body,
      signatureHeader: `hmac-sha256-hex=${signHex(body)}`,
      webhookSecret: SECRET,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a wrong signature", () => {
    const result = verifyEasyPostSignature({
      rawBody: '{"x":1}',
      signatureHeader: "a".repeat(64),
      webhookSecret: SECRET,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(EasyPostSignatureError);
    }
  });

  it("rejects a missing signature header", () => {
    const result = verifyEasyPostSignature({
      rawBody: '{"x":1}',
      signatureHeader: "",
      webhookSecret: SECRET,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-hex signature", () => {
    const result = verifyEasyPostSignature({
      rawBody: '{"x":1}',
      signatureHeader: "not-a-hex-value",
      webhookSecret: SECRET,
    });
    expect(result.ok).toBe(false);
  });

  it("throws on missing secret (programmer error)", () => {
    expect(() =>
      verifyEasyPostSignature({
        rawBody: "{}",
        signatureHeader: "ab".repeat(32),
        webhookSecret: "",
      })
    ).toThrow(EasyPostWebhookConfigError);
  });

  it("rejects when body has been mutated", () => {
    const original = '{"id":"evt_1"}';
    const signature = signHex(original);
    const result = verifyEasyPostSignature({
      rawBody: '{"id":"evt_1"} ',
      signatureHeader: signature,
      webhookSecret: SECRET,
    });
    expect(result.ok).toBe(false);
  });
});
