import {
  configureCrypto,
  encryptField,
  LocalKmsAdapter,
  resetCryptoConfigurationForTests,
} from "@pharmax/crypto";
import { CarrierCredentialStatus, ShippingProvider } from "@pharmax/database";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ShippingAdapter } from "./carriers/shipping-adapter.js";
import {
  configureShipping,
  resetShippingConfigurationForTests,
  type CarrierCredentialContext,
} from "./configure.js";
import { resolveShippingAdapter, SHIPPING_CREDENTIAL_NOT_FOUND } from "./resolve-adapter.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CREDENTIAL_ID = "00000000-0000-4000-8000-0000000000a1";

const STUB_ADAPTER: ShippingAdapter = {
  providerName: "stub",
  purchaseLabel: async () => {
    throw new Error("not invoked by resolver tests");
  },
};

function buildTx(
  rows: Array<{ id: string; apiKeyEnc: unknown; webhookSecretEnc?: unknown }> | null
) {
  return {
    carrierCredential: {
      findFirst: vi.fn(async () => (rows === null ? null : (rows[0] ?? null))),
    },
  } as unknown as Parameters<typeof resolveShippingAdapter>[0]["tx"];
}

beforeEach(() => {
  configureCrypto({ kms: new LocalKmsAdapter({ seed: "resolve-adapter-test-seed" }) });
});

afterEach(() => {
  resetCryptoConfigurationForTests();
  resetShippingConfigurationForTests();
});

describe("resolveShippingAdapter", () => {
  it("decrypts the API key and passes it to the registered factory", async () => {
    const seen: CarrierCredentialContext[] = [];
    configureShipping({
      factories: {
        [ShippingProvider.EASYPOST]: (ctx) => {
          seen.push(ctx);
          return STUB_ADAPTER;
        },
      },
    });

    const apiKeyEnc = await encryptField({
      plaintext: "EZTK_real_api_key",
      binding: {
        tenantId: ORG_ID,
        table: "carrier_credential",
        column: "apiKey",
        recordId: CREDENTIAL_ID,
      },
    });

    const tx = buildTx([{ id: CREDENTIAL_ID, apiKeyEnc, webhookSecretEnc: null }]);

    const result = await resolveShippingAdapter({
      tx,
      organizationId: ORG_ID,
      provider: ShippingProvider.EASYPOST,
    });

    expect(result.adapter).toBe(STUB_ADAPTER);
    expect(result.credentialId).toBe(CREDENTIAL_ID);
    expect(seen[0]?.apiKey).toBe("EZTK_real_api_key");
    expect(seen[0]?.webhookSecret).toBeNull();
  });

  it("decrypts the optional webhook secret when present", async () => {
    const seen: CarrierCredentialContext[] = [];
    configureShipping({
      factories: {
        [ShippingProvider.EASYPOST]: (ctx) => {
          seen.push(ctx);
          return STUB_ADAPTER;
        },
      },
    });

    const apiKeyEnc = await encryptField({
      plaintext: "EZTK_real_api_key",
      binding: {
        tenantId: ORG_ID,
        table: "carrier_credential",
        column: "apiKey",
        recordId: CREDENTIAL_ID,
      },
    });
    const webhookSecretEnc = await encryptField({
      plaintext: "whsec_demo",
      binding: {
        tenantId: ORG_ID,
        table: "carrier_credential",
        column: "webhookSecret",
        recordId: CREDENTIAL_ID,
      },
    });

    const tx = buildTx([{ id: CREDENTIAL_ID, apiKeyEnc, webhookSecretEnc }]);
    await resolveShippingAdapter({
      tx,
      organizationId: ORG_ID,
      provider: ShippingProvider.EASYPOST,
    });
    expect(seen[0]?.webhookSecret).toBe("whsec_demo");
  });

  it("throws SHIPPING_CREDENTIAL_NOT_FOUND when no ACTIVE credential exists", async () => {
    configureShipping({
      factories: { [ShippingProvider.EASYPOST]: () => STUB_ADAPTER },
    });
    await expect(
      resolveShippingAdapter({
        tx: buildTx([]),
        organizationId: ORG_ID,
        provider: ShippingProvider.EASYPOST,
      })
    ).rejects.toMatchObject({ code: SHIPPING_CREDENTIAL_NOT_FOUND });
  });

  it("filters the findFirst to status=ACTIVE so DISABLED rows are invisible", async () => {
    configureShipping({
      factories: { [ShippingProvider.EASYPOST]: () => STUB_ADAPTER },
    });
    const apiKeyEnc = await encryptField({
      plaintext: "k",
      binding: {
        tenantId: ORG_ID,
        table: "carrier_credential",
        column: "apiKey",
        recordId: CREDENTIAL_ID,
      },
    });
    const tx = buildTx([{ id: CREDENTIAL_ID, apiKeyEnc }]);
    await resolveShippingAdapter({
      tx,
      organizationId: ORG_ID,
      provider: ShippingProvider.EASYPOST,
    });
    const findFirst = (
      tx as unknown as { carrierCredential: { findFirst: ReturnType<typeof vi.fn> } }
    ).carrierCredential.findFirst;
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: ORG_ID,
          provider: ShippingProvider.EASYPOST,
          status: CarrierCredentialStatus.ACTIVE,
        }),
      })
    );
  });
});
