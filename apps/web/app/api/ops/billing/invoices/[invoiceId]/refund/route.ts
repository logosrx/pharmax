// POST /api/ops/billing/invoices/:invoiceId/refund
//
// Operator action: issue a Stripe refund against a paid invoice.
// Dispatches `IssueRefund` (synchronous Stripe call via the
// configured `StripeRefundPort`). RBAC enforced by the command
// (`billing.issue_refund`).

import { IssueRefund, type IssueRefundInput } from "@pharmax/billing";

import { dispatchOpsCommandWithMfa } from "../../../../../../../src/server/auth/dispatch-ops-with-mfa.js";

interface RouteParams {
  readonly params: Promise<{ readonly invoiceId: string }>;
}

const REFUND_REASONS = ["duplicate", "fraudulent", "requested_by_customer"] as const;

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
    command: IssueRefund,
    idempotencyKeyPrefix: `route:refund-invoice:${invoiceId}`,
    buildInput: ({ body }) => {
      const amountCents = readNumber(body, "amountCents");
      const reasonRaw = readString(body, "reason") ?? "requested_by_customer";
      const operatorNote = readString(body, "operatorNote");

      if (amountCents === null || amountCents <= 0) {
        return { error: "amountCents must be a positive integer (cents)." };
      }
      if (!REFUND_REASONS.includes(reasonRaw as (typeof REFUND_REASONS)[number])) {
        return { error: `reason must be one of: ${REFUND_REASONS.join(", ")}.` };
      }
      const input: IssueRefundInput = {
        invoiceId,
        amountCents: Math.floor(amountCents),
        reason: reasonRaw as (typeof REFUND_REASONS)[number],
        ...(operatorNote !== null ? { operatorNote } : {}),
      };
      return input;
    },
    successRedirect: () => `/ops/billing/${invoiceId}?flash=refunded`,
    failureRedirect: `/ops/billing/${invoiceId}`,
    successLogEvent: "ops.billing.refund.applied",
    failureLogEvent: "ops.billing.refund.failed",
  });
}
