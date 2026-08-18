import { Secret, TOTP } from "otpauth";
import { describe, expect, it } from "vitest";

import {
  buildTotpKeyUri,
  generateTotpCode,
  generateTotpSecretBase32,
  verifyTotpCode,
} from "./totp.js";

const ISSUER = "Pharmax";
const ACCOUNT = "operator-1";

/** Generate the code an authenticator app would show right now. */
function currentCode(secretBase32: string): string {
  const totp = new TOTP({
    issuer: ISSUER,
    label: ACCOUNT,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secretBase32),
  });
  return totp.generate();
}

describe("generateTotpSecretBase32", () => {
  it("returns a base32 secret and unique across calls", () => {
    const a = generateTotpSecretBase32();
    const b = generateTotpSecretBase32();
    expect(a).toMatch(/^[A-Z2-7]+$/);
    expect(a).not.toBe(b);
  });
});

describe("buildTotpKeyUri", () => {
  it("builds an otpauth:// provisioning URI carrying issuer + secret", () => {
    const secret = generateTotpSecretBase32();
    const uri = buildTotpKeyUri({ secretBase32: secret, issuer: ISSUER, accountName: ACCOUNT });
    expect(uri.startsWith("otpauth://totp/")).toBe(true);
    expect(uri).toContain(`secret=${secret}`);
    expect(uri).toContain(`issuer=${ISSUER}`);
  });
});

describe("generateTotpCode", () => {
  // `currentCode` above builds its own TOTP with the parameters spelled
  // out, so it stays an INDEPENDENT oracle: if generate and verify ever
  // drifted together onto the wrong algorithm or period, agreeing with
  // each other would not catch it, and agreeing with this would.
  it("matches a hand-built authenticator for the same secret", () => {
    const secret = generateTotpSecretBase32();
    expect(generateTotpCode({ secretBase32: secret, issuer: ISSUER, accountName: ACCOUNT })).toBe(
      currentCode(secret)
    );
  });

  it("produces a code this module's own verifier accepts", () => {
    const secret = generateTotpSecretBase32();
    const code = generateTotpCode({ secretBase32: secret, issuer: ISSUER, accountName: ACCOUNT });
    expect(code).toMatch(/^\d{6}$/);
    expect(
      verifyTotpCode({
        secretBase32: secret,
        issuer: ISSUER,
        accountName: ACCOUNT,
        token: code,
        window: 1,
      })
    ).toBe(true);
  });

  // The label and issuer are URI metadata, not HMAC inputs (RFC 6238
  // derives the code from secret + time only). This is what lets the
  // E2E harness generate from a secret alone, and what lets `SignIn`
  // verify with `accountName: userId` against a secret whose
  // provisioning URI was built with the user's EMAIL.
  it("ignores issuer and accountName, which are not HMAC inputs", () => {
    const secret = generateTotpSecretBase32();
    const withLabels = generateTotpCode({
      secretBase32: secret,
      issuer: "A",
      accountName: "a@example.test",
    });
    const withOthers = generateTotpCode({
      secretBase32: secret,
      issuer: "B",
      accountName: "b@example.test",
    });
    expect(withLabels).toBe(withOthers);
    expect(generateTotpCode({ secretBase32: secret })).toBe(withLabels);
  });
});

describe("verifyTotpCode", () => {
  it("accepts the current code", () => {
    const secret = generateTotpSecretBase32();
    const code = currentCode(secret);
    expect(
      verifyTotpCode({
        secretBase32: secret,
        issuer: ISSUER,
        accountName: ACCOUNT,
        token: code,
        window: 1,
      })
    ).toBe(true);
  });

  it("tolerates spaces in the submitted code", () => {
    const secret = generateTotpSecretBase32();
    const code = currentCode(secret);
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(
      verifyTotpCode({
        secretBase32: secret,
        issuer: ISSUER,
        accountName: ACCOUNT,
        token: spaced,
        window: 1,
      })
    ).toBe(true);
  });

  it("rejects a wrong code", () => {
    const secret = generateTotpSecretBase32();
    const wrong = currentCode(secret) === "000000" ? "111111" : "000000";
    expect(
      verifyTotpCode({
        secretBase32: secret,
        issuer: ISSUER,
        accountName: ACCOUNT,
        token: wrong,
        window: 1,
      })
    ).toBe(false);
  });

  it("rejects a non-6-digit input without throwing", () => {
    const secret = generateTotpSecretBase32();
    expect(
      verifyTotpCode({
        secretBase32: secret,
        issuer: ISSUER,
        accountName: ACCOUNT,
        token: "abc",
        window: 1,
      })
    ).toBe(false);
  });

  it("rejects a code generated against a different secret", () => {
    const a = generateTotpSecretBase32();
    const b = generateTotpSecretBase32();
    const codeForB = currentCode(b);
    expect(
      verifyTotpCode({
        secretBase32: a,
        issuer: ISSUER,
        accountName: ACCOUNT,
        token: codeForB,
        window: 1,
      })
    ).toBe(false);
  });
});
