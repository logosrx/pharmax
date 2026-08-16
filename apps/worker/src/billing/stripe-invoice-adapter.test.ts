// createStripeInvoiceAdapter contract tests (coverage-audit 2026-08,
// backfill item 5). Direct double-billing risk: the adapter's
// idempotency keys and call ordering are what make a retried push
// resolve to the SAME Stripe invoice instead of a duplicate.
//
// The Stripe SDK is faked the same way other adapters in this repo
// fake third-party clients (narrow structural stub, cast at the
// boundary — see `push-invoice-to-stripe.test.ts`). The fake HONORS
// idempotency keys the way Stripe does: a replayed key returns the
// original object instead of creating a second one, which is exactly
// the property the key-construction tests here protect.
//
// Pinned behavior:
//   - Idempotency keys are STABLE per line / per invoice across
//     retries: `pharmax-line:{pharmaxLineId}` and
//     `pharmax-invoice:{pharmaxInvoiceId}` — byte-exact.
//   - Call sequence: one invoiceItems.create per line (in request
//     order), then invoices.create, then finalizeInvoice. Finalize
//     is never attempted when creation failed — a failed push throws
//     loudly instead of leaving a silently-unfinalized draft.
//   - Error mid-sequence → retry creates no duplicate invoice items
//     and converges on the same finalized invoice.
//   - Stripe error classes (429 rate-limit, card/validation, 5xx)
//     all surface as InternalError(STRIPE_PUSH_API_ERROR) with the
//     Stripe code preserved in metadata and the cause chained.
//
// CLEAN ROOM / PHI: synthetic ids and a sanitized flat description
// only — mirrors what materialization actually sends.

import { STRIPE_PUSH_API_ERROR, type StripePushRequest } from "@pharmax/billing";
import { errors } from "@pharmax/platform-core";
import type Stripe from "stripe";
import { describe, expect, it } from "vitest";

import { createStripeInvoiceAdapter } from "./stripe-invoice-adapter.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c";
const INVOICE_ID = "1111aaaa-1111-4111-8111-000000000001";
const LINE_1 = "2222bbbb-2222-4222-8222-000000000001";
const LINE_2 = "2222bbbb-2222-4222-8222-000000000002";

function buildRequest(overrides: Partial<StripePushRequest> = {}): StripePushRequest {
  return {
    organizationId: ORG_ID,
    clinicId: CLINIC_ID,
    pharmaxInvoiceId: INVOICE_ID,
    invoiceNumber: "INV-2026-000042",
    stripeCustomerId: "cus_synthetic1",
    currency: "usd",
    daysUntilDue: 30,
    lines: [
      {
        pharmaxLineId: LINE_1,
        description: "Shipped prescription order (dispense fee)",
        quantity: 1,
        unitAmountCents: 4_500,
        amountCents: 4_500,
      },
      {
        pharmaxLineId: LINE_2,
        description: "Shipped prescription order (dispense fee)",
        quantity: 2,
        unitAmountCents: 1_000,
        amountCents: 2_000,
      },
    ],
    ...overrides,
  };
}

interface StripeFakeOptions {
  /** Reject the Nth (1-based) invoiceItems.create call with this error, once. */
  readonly failItemCreateAtCall?: { readonly call: number; readonly error: unknown };
  /** Reject the next invoices.create call with this error, once. */
  readonly failInvoiceCreateWith?: unknown;
  /** Override the invoice object create/finalize returns. */
  readonly invoiceOverrides?: Record<string, unknown>;
  /** Override only the finalized invoice object. */
  readonly finalizedOverrides?: Record<string, unknown>;
}

/**
 * Stateful fake of the narrow Stripe SDK surface the adapter touches.
 * Replays by idempotency key like the real API: the same key returns
 * the original object without creating anything new.
 */
function buildStripeFake(options: StripeFakeOptions = {}) {
  const callLog: string[] = [];
  const itemsByIdempotencyKey = new Map<string, Record<string, unknown>>();
  const invoicesByIdempotencyKey = new Map<string, Record<string, unknown>>();
  const itemParamsByKey = new Map<string, Record<string, unknown>>();
  let itemCreateCalls = 0;
  let invoiceCounter = 0;
  let pendingInvoiceCreateFailure = options.failInvoiceCreateWith ?? null;

  const stripe = {
    invoiceItems: {
      create: async (
        params: Record<string, unknown>,
        requestOptions: { idempotencyKey: string }
      ) => {
        itemCreateCalls += 1;
        callLog.push(`invoiceItems.create:${requestOptions.idempotencyKey}`);
        if (options.failItemCreateAtCall?.call === itemCreateCalls) {
          throw options.failItemCreateAtCall.error;
        }
        const replay = itemsByIdempotencyKey.get(requestOptions.idempotencyKey);
        if (replay !== undefined) return replay;
        const item = { id: `ii_${itemsByIdempotencyKey.size + 1}`, ...params };
        itemsByIdempotencyKey.set(requestOptions.idempotencyKey, item);
        itemParamsByKey.set(requestOptions.idempotencyKey, params);
        return item;
      },
    },
    invoices: {
      create: async (
        params: Record<string, unknown>,
        requestOptions: { idempotencyKey: string }
      ) => {
        callLog.push(`invoices.create:${requestOptions.idempotencyKey}`);
        if (pendingInvoiceCreateFailure !== null) {
          const failure = pendingInvoiceCreateFailure;
          pendingInvoiceCreateFailure = null;
          throw failure;
        }
        const replay = invoicesByIdempotencyKey.get(requestOptions.idempotencyKey);
        if (replay !== undefined) return replay;
        invoiceCounter += 1;
        const invoice = {
          id: `in_${invoiceCounter}`,
          status: "draft",
          ...params,
          ...options.invoiceOverrides,
        };
        invoicesByIdempotencyKey.set(requestOptions.idempotencyKey, invoice);
        return invoice;
      },
      finalizeInvoice: async (invoiceId: string) => {
        callLog.push(`finalizeInvoice:${invoiceId}`);
        return {
          id: invoiceId,
          status: "open",
          hosted_invoice_url: `https://invoice.stripe.test/${invoiceId}`,
          ...options.finalizedOverrides,
        };
      },
    },
  };

  return {
    stripe: stripe as unknown as Stripe,
    callLog,
    itemsByIdempotencyKey,
    invoicesByIdempotencyKey,
    itemParamsByKey,
  };
}

function stripeError(input: {
  message: string;
  type: string;
  code?: string;
  statusCode?: number;
}): Error {
  // Structural stand-in for Stripe SDK error instances: the adapter
  // only reads `.code` and `.message`, exactly what's faked here.
  return Object.assign(new Error(input.message), {
    type: input.type,
    ...(input.code !== undefined ? { code: input.code } : {}),
    ...(input.statusCode !== undefined ? { statusCode: input.statusCode } : {}),
  });
}

describe("createStripeInvoiceAdapter — call sequence and idempotency keys", () => {
  it("runs invoiceItems.create per line (request order) → invoices.create → finalizeInvoice, with exact key construction", async () => {
    const fake = buildStripeFake();
    const adapter = createStripeInvoiceAdapter({ stripe: fake.stripe });

    const result = await adapter.pushInvoice(buildRequest());

    expect(fake.callLog).toEqual([
      `invoiceItems.create:pharmax-line:${LINE_1}`,
      `invoiceItems.create:pharmax-line:${LINE_2}`,
      `invoices.create:pharmax-invoice:${INVOICE_ID}`,
      "finalizeInvoice:in_1",
    ]);
    expect(result).toEqual({
      stripeInvoiceId: "in_1",
      stripeStatus: "open",
      hostedInvoiceUrl: "https://invoice.stripe.test/in_1",
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("sends the pre-multiplied line amount, sanitized description, and pharmax ids as metadata", async () => {
    const fake = buildStripeFake();
    const adapter = createStripeInvoiceAdapter({ stripe: fake.stripe });

    await adapter.pushInvoice(buildRequest());

    const line2 = fake.itemParamsByKey.get(`pharmax-line:${LINE_2}`);
    expect(line2).toEqual({
      customer: "cus_synthetic1",
      currency: "usd",
      amount: 2_000,
      description: "Shipped prescription order (dispense fee)",
      quantity: 2,
      metadata: { pharmaxLineId: LINE_2, pharmaxInvoiceId: INVOICE_ID },
    });
  });

  it("clamps fractional/zero quantities to a positive integer", async () => {
    const fake = buildStripeFake();
    const adapter = createStripeInvoiceAdapter({ stripe: fake.stripe });

    await adapter.pushInvoice(
      buildRequest({
        lines: [
          {
            pharmaxLineId: LINE_1,
            description: "Shipped prescription order (dispense fee)",
            quantity: 0,
            unitAmountCents: 100,
            amountCents: 100,
          },
          {
            pharmaxLineId: LINE_2,
            description: "Shipped prescription order (dispense fee)",
            quantity: 2.6,
            unitAmountCents: 100,
            amountCents: 260,
          },
        ],
      })
    );

    expect(fake.itemParamsByKey.get(`pharmax-line:${LINE_1}`)?.["quantity"]).toBe(1);
    expect(fake.itemParamsByKey.get(`pharmax-line:${LINE_2}`)?.["quantity"]).toBe(3);
  });

  it("re-running the same push uses byte-identical idempotency keys, so nothing is created twice", async () => {
    const fake = buildStripeFake();
    const adapter = createStripeInvoiceAdapter({ stripe: fake.stripe });

    const first = await adapter.pushInvoice(buildRequest());
    const second = await adapter.pushInvoice(buildRequest());

    // The second pass replays byte-identical calls (keys included)…
    expect(fake.callLog.slice(4)).toEqual(fake.callLog.slice(0, 4));
    // …so the key-honoring fake materialized exactly one item per line
    // and exactly one invoice, and both pushes resolved to it.
    expect(fake.itemsByIdempotencyKey.size).toBe(2);
    expect(fake.invoicesByIdempotencyKey.size).toBe(1);
    expect(second.stripeInvoiceId).toBe(first.stripeInvoiceId);
  });

  it("falls back to stripeStatus 'draft' and hostedInvoiceUrl null when finalize returns neither", async () => {
    const fake = buildStripeFake({
      finalizedOverrides: { status: null, hosted_invoice_url: undefined },
    });
    const adapter = createStripeInvoiceAdapter({ stripe: fake.stripe });

    const result = await adapter.pushInvoice(buildRequest());
    expect(result.stripeStatus).toBe("draft");
    expect(result.hostedInvoiceUrl).toBeNull();
  });
});

describe("createStripeInvoiceAdapter — error mid-sequence and resume", () => {
  it("failure on the second line item: throws loudly, never creates or finalizes the invoice", async () => {
    const fake = buildStripeFake({
      failItemCreateAtCall: {
        call: 2,
        error: stripeError({ message: "boom", type: "StripeAPIError", statusCode: 500 }),
      },
    });
    const adapter = createStripeInvoiceAdapter({ stripe: fake.stripe });

    await expect(adapter.pushInvoice(buildRequest())).rejects.toBeInstanceOf(errors.InternalError);
    // No invoice draft exists, and finalize was never attempted — the
    // failure is loud, not a silently-unfinalized invoice.
    expect(fake.callLog.some((c) => c.startsWith("invoices.create"))).toBe(false);
    expect(fake.callLog.some((c) => c.startsWith("finalizeInvoice"))).toBe(false);
    expect(fake.itemsByIdempotencyKey.size).toBe(1);
  });

  it("failure at invoices.create, then retry: no duplicate invoice items, one invoice, finalized", async () => {
    const fake = buildStripeFake({
      failInvoiceCreateWith: stripeError({
        message: "An error occurred with our connection to Stripe.",
        type: "StripeConnectionError",
      }),
    });
    const adapter = createStripeInvoiceAdapter({ stripe: fake.stripe });

    await expect(adapter.pushInvoice(buildRequest())).rejects.toBeInstanceOf(errors.InternalError);
    // First attempt died at invoices.create — finalize never ran.
    expect(fake.callLog.some((c) => c.startsWith("finalizeInvoice"))).toBe(false);

    const result = await adapter.pushInvoice(buildRequest());

    // The retry replayed both line keys against the fake's ledger —
    // still exactly one Stripe item per Pharmax line (no double bill).
    expect(fake.itemsByIdempotencyKey.size).toBe(2);
    expect(fake.invoicesByIdempotencyKey.size).toBe(1);
    // And the retry did not leave the invoice unfinalized.
    expect(fake.callLog.filter((c) => c.startsWith("finalizeInvoice")).length).toBe(1);
    expect(result.stripeStatus).toBe("open");
  });

  it("throws InternalError(STRIPE_PUSH_API_ERROR) when Stripe returns an invoice without an id, before finalizing", async () => {
    const fake = buildStripeFake({ invoiceOverrides: { id: "" } });
    const adapter = createStripeInvoiceAdapter({ stripe: fake.stripe });

    const failure = await adapter.pushInvoice(buildRequest()).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(errors.InternalError);
    const internal = failure as InstanceType<typeof errors.InternalError>;
    expect(internal.code).toBe(STRIPE_PUSH_API_ERROR);
    expect(internal.metadata["pharmaxInvoiceId"]).toBe(INVOICE_ID);
    expect(fake.callLog.some((c) => c.startsWith("finalizeInvoice"))).toBe(false);
  });
});

describe("createStripeInvoiceAdapter — Stripe error classification", () => {
  it.each([
    [
      "429 rate-limit",
      stripeError({
        message: "Too many requests hit the API too quickly.",
        type: "StripeRateLimitError",
        code: "rate_limit",
        statusCode: 429,
      }),
      "rate_limit",
    ],
    [
      "card/validation error",
      stripeError({
        message: "Your card was declined.",
        type: "StripeCardError",
        code: "card_declined",
        statusCode: 402,
      }),
      "card_declined",
    ],
    [
      "invalid request",
      stripeError({
        message: "No such customer: cus_synthetic1",
        type: "StripeInvalidRequestError",
        code: "resource_missing",
        statusCode: 404,
      }),
      "resource_missing",
    ],
    [
      "5xx API error without a code",
      stripeError({
        message: "Something went wrong on Stripe's end.",
        type: "StripeAPIError",
        statusCode: 500,
      }),
      STRIPE_PUSH_API_ERROR,
    ],
  ])(
    "wraps a %s into InternalError(STRIPE_PUSH_API_ERROR) with the Stripe code in metadata and the cause chained",
    async (_label, sdkError, expectedStripeCode) => {
      const fake = buildStripeFake({ failInvoiceCreateWith: sdkError });
      const adapter = createStripeInvoiceAdapter({ stripe: fake.stripe });

      const failure = await adapter.pushInvoice(buildRequest()).catch((cause: unknown) => cause);

      expect(failure).toBeInstanceOf(errors.InternalError);
      const internal = failure as InstanceType<typeof errors.InternalError>;
      expect(internal.code).toBe(STRIPE_PUSH_API_ERROR);
      expect(internal.message).toContain((sdkError as Error).message);
      expect(internal.metadata["stripeErrorCode"]).toBe(expectedStripeCode);
      expect(internal.metadata["pharmaxInvoiceId"]).toBe(INVOICE_ID);
      expect(internal.cause).toBe(sdkError);
      // A failed create never reaches finalize.
      expect(fake.callLog.some((c) => c.startsWith("finalizeInvoice"))).toBe(false);
    }
  );

  it("wraps a non-Error throw with message 'unknown'", async () => {
    const fake = buildStripeFake({ failInvoiceCreateWith: "socket hang up" });
    const adapter = createStripeInvoiceAdapter({ stripe: fake.stripe });

    const failure = await adapter.pushInvoice(buildRequest()).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(errors.InternalError);
    expect((failure as Error).message).toContain("unknown");
  });

  it("lets a PharmaxError thrown inside the sequence pass through unwrapped", async () => {
    const domainError = new errors.InternalError({
      code: STRIPE_PUSH_API_ERROR,
      message: "Stripe invoice create returned without an id.",
    });
    const fake = buildStripeFake({ failInvoiceCreateWith: domainError });
    const adapter = createStripeInvoiceAdapter({ stripe: fake.stripe });

    await expect(adapter.pushInvoice(buildRequest())).rejects.toBe(domainError);
  });
});
