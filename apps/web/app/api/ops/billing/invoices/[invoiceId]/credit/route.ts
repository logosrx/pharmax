// POST /api/ops/billing/invoices/:invoiceId/credit
//
// Operator action: apply a manual credit / discount / adjustment
// (negative-amount line) to the invoice. Dispatches `CreditInvoice`.
// RBAC enforced by the command (`billing.credit_invoice`).

import { CreditInvoice, CREDIT_INVOICE_KINDS, type CreditInvoiceInput } from "@pharmax/billing";

import { dispatchOpsCommandWithMfa } from "../../../../../../../src/server/auth/dispatch-ops-with-mfa.js";

interface RouteParams {
  readonly params: Promise<{ readonly invoiceId: string }>;
}

function readString(body: FormData | Record<string, unknown>, key: string): string | null {
  if (body instanceof FormData) {
    const v = body.get(key);
    return typeof v === "string" && v.length > 0 ? v : null;
  }
  const v = (body as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function readNumber(body: FormData | Record<string, unknown>, key: string): number | null {
  if (body instanceof FormData) {
    const raw = body.get(key);
    const parsed = typeof raw === "string" ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? parsed : null;
  }
  const v = (body as Record<string, unknown>)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { invoiceId } = await context.params;
  return await dispatchOpsCommandWithMfa({
    request,
    command: CreditInvoice,
    idempotencyKeyPrefix: `route:credit-invoice:${invoiceId}`,
    buildInput: ({ body }) => {
      const amountCents = readNumber(body, "amountCents");
      const kindRaw = readString(body, "kind");
      const description = readString(body, "description");
      const reasonText = readString(body, "reasonText");

      if (amountCents === null || amountCents <= 0) {
        return { error: "amountCents must be a positive integer (cents)." };
      }
      if (
        kindRaw === null ||
        !CREDIT_INVOICE_KINDS.includes(kindRaw as (typeof CREDIT_INVOICE_KINDS)[number])
      ) {
        return { error: `kind must be one of: ${CREDIT_INVOICE_KINDS.join(", ")}.` };
      }
      if (description === null) {
        return { error: "description is required (e.g. 'Goodwill credit')." };
      }
      const input: CreditInvoiceInput = {
        invoiceId,
        amountCents: Math.floor(amountCents),
        kind: kindRaw as (typeof CREDIT_INVOICE_KINDS)[number],
        description,
        ...(reasonText !== null ? { reasonText } : {}),
      };
      return input;
    },
    successRedirect: () => `/ops/billing/${invoiceId}?flash=credited`,
    failureRedirect: `/ops/billing/${invoiceId}`,
    successLogEvent: "ops.billing.credit.applied",
    failureLogEvent: "ops.billing.credit.failed",
  });
}
