// Default factory for the EasyPost adapter.
//
// Registered at boot via:
//
//   configureShipping({
//     factories: {
//       EASYPOST: createEasyPostFactory(),
//     },
//   });
//
// Each per-org credential lookup builds a fresh `EasyPostClient`
// with that org's API key. The HTTP client itself is light — there
// is no global connection pool to share, and per-org request
// isolation matches the credential boundary.

import type { ShippingAdapterFactory } from "../configure.js";

import { EasyPostClient } from "./easypost-client.js";
import { EasyPostShippingAdapter } from "./easypost-adapter.js";

export interface CreateEasyPostFactoryOptions {
  /** Override for tests. Defaults to `globalThis.fetch`. */
  readonly fetch?: typeof fetch;
  /** Override request timeout. Defaults to the client's 15s. */
  readonly timeoutMs?: number;
}

export function createEasyPostFactory(
  options: CreateEasyPostFactoryOptions = {}
): ShippingAdapterFactory {
  return (ctx) => {
    const client = new EasyPostClient({
      apiKey: ctx.apiKey,
      ...(ctx.baseUrl !== null ? { baseUrl: ctx.baseUrl } : {}),
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    return new EasyPostShippingAdapter({ client });
  };
}
