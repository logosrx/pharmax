// Rate-shopping loader — drives `/ops/shipping/[orderId]/rates`.
//
// Assembles the same purchase context the auto-purchase route uses
// (site from-address, decrypted patient to-address, default parcel),
// resolves the provider's adapter, and quotes every purchasable
// service WITHOUT buying anything. The page renders the options;
// each "Buy" button posts the chosen serviceLevel to the existing
// purchase route — quoting never mutates state, so no command
// handler is involved here.
//
// PHI: the decrypted to-address exists in memory only for the
// carrier's rating call (same contract as the purchase route). The
// result carries rates ONLY — no address content reaches the page.
//
// Failure modes are typed strings from `resolvePurchaseContext`
// plus:
//   - PROVIDER_NO_RATE_SHOPPING — adapter has no getRates.
//   - RATE_QUOTE_FAILED — the carrier's rating API errored.

import "server-only";

import { readInOrgScope, type ShippingProvider } from "@pharmax/database";
import { resolveShippingAdapter, type RateQuoteOption } from "@pharmax/shipping";

import { logger } from "../logger.js";

import { resolvePurchaseContext } from "./resolve-purchase-context.js";

export const QUOTE_RATES_PROVIDER_NO_RATE_SHOPPING = "PROVIDER_NO_RATE_SHOPPING";
export const QUOTE_RATES_FAILED = "RATE_QUOTE_FAILED";

export type QuoteShippingRatesResult =
  | {
      readonly ok: true;
      readonly rates: ReadonlyArray<RateQuoteOption>;
      readonly parcel: {
        readonly lengthInches: number;
        readonly widthInches: number;
        readonly heightInches: number;
        readonly weightOunces: number;
      };
    }
  | { readonly ok: false; readonly code: string; readonly message: string };

export async function quoteShippingRates(input: {
  readonly organizationId: string;
  readonly orderId: string;
  readonly provider: ShippingProvider;
}): Promise<QuoteShippingRatesResult> {
  const resolved = await resolvePurchaseContext({
    organizationId: input.organizationId,
    orderId: input.orderId,
  });
  if (!resolved.ok) {
    return Object.freeze({ ok: false, code: resolved.code, message: resolved.message });
  }

  // Short tenant tx ONLY for the credential decrypt; the carrier
  // HTTP call runs after the connection is released.
  const { adapter } = await readInOrgScope(input.organizationId, (tx) =>
    resolveShippingAdapter({
      tx: tx as Parameters<typeof resolveShippingAdapter>[0]["tx"],
      organizationId: input.organizationId,
      provider: input.provider,
    })
  );

  if (adapter.getRates === undefined) {
    return Object.freeze({
      ok: false,
      code: QUOTE_RATES_PROVIDER_NO_RATE_SHOPPING,
      message: `${input.provider} does not support rate shopping yet. Purchase with an explicit service level instead.`,
    });
  }

  try {
    const rates = await adapter.getRates({
      fromAddress: resolved.context.fromAddress,
      toAddress: resolved.context.toAddress,
      parcel: resolved.context.parcel,
    });
    return Object.freeze({ ok: true, rates, parcel: resolved.context.parcel });
  } catch (cause) {
    // PHI note: carrier errors can echo request fragments; log the
    // message server-side, surface a generic string to the page.
    logger.error("ops.shipping.rate_quote.failed", {
      orderId: input.orderId,
      provider: input.provider,
      errorMessage: cause instanceof Error ? cause.message : "unknown",
    });
    return Object.freeze({
      ok: false,
      code: QUOTE_RATES_FAILED,
      message:
        "The carrier's rating API declined the quote. Retry, or purchase with an explicit service level.",
    });
  }
}
