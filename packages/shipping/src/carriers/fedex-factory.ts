// Default factory for the FedEx adapter.
//
// FedEx requires two separate credentials (API key + secret) plus an
// account number. We pack them like this:
//
//   carrier_credential.apiKey         = "<api_key>:<api_secret>"
//   carrier_credential.carrierAccountId = "<account_number>"
//
// The colon-delimited apiKey field keeps the encryption surface to
// one column (matching EasyPost's single-key model) while still
// carrying both halves of FedEx's client_credentials pair. The
// admin command `RegisterCarrierCredential` does the join on input.

import { errors } from "@pharmax/platform-core";

import type { ShippingAdapterFactory } from "../configure.js";

import { FedExClient } from "./fedex-client.js";
import { FedExShippingAdapter } from "./fedex-adapter.js";

export interface CreateFedExFactoryOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

function splitFedExApiKey(packed: string): { key: string; secret: string } {
  const idx = packed.indexOf(":");
  if (idx <= 0 || idx === packed.length - 1) {
    throw new errors.InternalError({
      code: "FEDEX_API_KEY_MISFORMATTED",
      message:
        "FedEx credential apiKey must be in the form '<api_key>:<api_secret>'. Re-register via RegisterCarrierCredential.",
    });
  }
  return { key: packed.slice(0, idx), secret: packed.slice(idx + 1) };
}

export function createFedExFactory(
  options: CreateFedExFactoryOptions = {}
): ShippingAdapterFactory {
  return (ctx) => {
    if (ctx.carrierAccountId === null || ctx.carrierAccountId.length === 0) {
      throw new errors.InternalError({
        code: "FEDEX_NO_ACCOUNT_NUMBER",
        message:
          "FedEx credential is missing carrierAccountId (the FedEx account number). Re-register via RegisterCarrierCredential.",
      });
    }
    const { key, secret } = splitFedExApiKey(ctx.apiKey);
    const client = new FedExClient({
      apiKey: key,
      apiSecret: secret,
      accountNumber: ctx.carrierAccountId,
      ...(ctx.baseUrl !== null ? { baseUrl: ctx.baseUrl } : {}),
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    return new FedExShippingAdapter({ client });
  };
}
