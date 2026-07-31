import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { FedExWebhookConfigError, verifyFedExSignature } from "./fedex-webhook-signature.js";

const SECRET = "portal-security-token";
const BODY = JSON.stringify({ trackResults: [{ trackingNumber: "794665654567" }] });

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("base64");
}

describe("verifyFedExSignature", () => {
  it("accepts a valid base64 HMAC-SHA256 signature", () => {
    const result = verifyFedExSignature({
      rawBody: BODY,
      signatureHeader: sign(BODY, SECRET),
      webhookSecret: SECRET,
    });
    expect(result.ok).toBe(true);
  });

  it("accepts a Buffer raw body", () => {
    const result = verifyFedExSignature({
      rawBody: Buffer.from(BODY, "utf8"),
      signatureHeader: sign(BODY, SECRET),
      webhookSecret: SECRET,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a signature produced with the wrong secret", () => {
    const result = verifyFedExSignature({
      rawBody: BODY,
      signatureHeader: sign(BODY, "wrong-token"),
      webhookSecret: SECRET,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects when the body was tampered with after signing", () => {
    const result = verifyFedExSignature({
      rawBody: BODY.replace("794665654567", "794665654568"),
      signatureHeader: sign(BODY, SECRET),
      webhookSecret: SECRET,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an empty signature header", () => {
    const result = verifyFedExSignature({
      rawBody: BODY,
      signatureHeader: "",
      webhookSecret: SECRET,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects garbage that decodes to zero bytes", () => {
    const result = verifyFedExSignature({
      rawBody: BODY,
      signatureHeader: "!!!!",
      webhookSecret: SECRET,
    });
    expect(result.ok).toBe(false);
  });

  it("throws FedExWebhookConfigError for a missing secret (programmer error)", () => {
    expect(() =>
      verifyFedExSignature({
        rawBody: BODY,
        signatureHeader: sign(BODY, SECRET),
        webhookSecret: "",
      })
    ).toThrow(FedExWebhookConfigError);
  });
});
