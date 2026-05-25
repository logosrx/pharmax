// Default factory for the UPS adapter.
//
// UPS uses the same packed-credential shape as FedEx:
//
//   carrier_credential.apiKey         = "<client_id>:<client_secret>"
//   carrier_credential.carrierAccountId = "<shipper_number>"
//
// The shipper number is required on every ship call and is the
// account that gets billed. RegisterCarrierCredential validates
// the packed format on input so callers never see a generic
// "missing creds" runtime error.

import { errors } from "@pharmax/platform-core";

import type { ShippingAdapterFactory } from "../configure.js";

import { UpsClient } from "./ups-client.js";
import { UpsShippingAdapter } from "./ups-adapter.js";

export interface CreateUpsFactoryOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

function splitUpsApiKey(packed: string): { key: string; secret: string } {
  const idx = packed.indexOf(":");
  if (idx <= 0 || idx === packed.length - 1) {
    throw new errors.InternalError({
      code: "UPS_API_KEY_MISFORMATTED",
      message:
        "UPS credential apiKey must be in the form '<client_id>:<client_secret>'. Re-register via RegisterCarrierCredential.",
    });
  }
  return { key: packed.slice(0, idx), secret: packed.slice(idx + 1) };
}

export function createUpsFactory(options: CreateUpsFactoryOptions = {}): ShippingAdapterFactory {
  return (ctx) => {
    if (ctx.carrierAccountId === null || ctx.carrierAccountId.length === 0) {
      throw new errors.InternalError({
        code: "UPS_NO_SHIPPER_NUMBER",
        message:
          "UPS credential is missing carrierAccountId (the UPS shipper number). Re-register via RegisterCarrierCredential.",
      });
    }
    const { key, secret } = splitUpsApiKey(ctx.apiKey);
    const client = new UpsClient({
      apiKey: key,
      apiSecret: secret,
      shipperNumber: ctx.carrierAccountId,
      ...(ctx.baseUrl !== null ? { baseUrl: ctx.baseUrl } : {}),
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    return new UpsShippingAdapter({ client });
  };
}
