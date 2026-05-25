// configureCrypto singleton contract tests.

import { afterEach, describe, expect, it } from "vitest";

import {
  configureCrypto,
  getCryptoConfiguration,
  resetCryptoConfigurationForTests,
} from "./configure.js";
import { LocalKmsAdapter } from "./local-kms-adapter.js";

afterEach(() => {
  resetCryptoConfigurationForTests();
});

describe("configureCrypto / getCryptoConfiguration", () => {
  it("throws CRYPTO_NOT_CONFIGURED until configureCrypto is called", () => {
    expect(() => getCryptoConfiguration()).toThrow(
      expect.objectContaining({ code: "CRYPTO_NOT_CONFIGURED" })
    );
  });

  it("returns the configured KMS adapter once wired", () => {
    const kms = new LocalKmsAdapter({ seed: "configure-test" });
    configureCrypto({ kms });
    expect(getCryptoConfiguration().kms).toBe(kms);
  });

  it("freezes the stored configuration (defense against late mutation)", () => {
    configureCrypto({ kms: new LocalKmsAdapter({ seed: "freeze-test" }) });
    const cfg = getCryptoConfiguration();
    expect(Object.isFrozen(cfg)).toBe(true);
  });

  it("resetCryptoConfigurationForTests restores the not-configured state", () => {
    configureCrypto({ kms: new LocalKmsAdapter({ seed: "reset-test" }) });
    resetCryptoConfigurationForTests();
    expect(() => getCryptoConfiguration()).toThrow(
      expect.objectContaining({ code: "CRYPTO_NOT_CONFIGURED" })
    );
  });
});
