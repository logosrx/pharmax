// POST /api/ops/billing/invoices/:invoiceId/finalize
//
// Operator action: flip a DRAFT invoice to OPEN. Dispatches the
// standard `FinalizeInvoice` command. RBAC enforced by the command
// (`billing.finalize_invoice` permission).

import { FinalizeInvoice } from "@pharmax/billing";

import { dispatchOpsCommandWithMfa } from "../../../../../../../src/server/auth/dispatch-ops-with-mfa.js";

interface RouteParams {
  readonly params: Promise<{ readonly invoiceId: string }>;
}

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { invoiceId } = await context.params;
  return await dispatchOpsCommandWithMfa({
    request,
    command: FinalizeInvoice,
    idempotencyKeyPrefix: `route:finalize-invoice:${invoiceId}`,
    buildInput: ({ body, bodyKind }) => {
      const days =
        bodyKind === "json"
          ? (body as Record<string, unknown>)["daysUntilDue"]
          : (body as FormData).get("daysUntilDue");
      const parsedDays = typeof days === "string" ? Number(days) : days;
      const daysUntilDue =
        typeof parsedDays === "number" && Number.isFinite(parsedDays) && parsedDays >= 0
          ? Math.floor(parsedDays)
          : 30;
      return { invoiceId, daysUntilDue };
    },
    successRedirect: () => `/ops/billing/${invoiceId}?flash=finalized`,
    failureRedirect: `/ops/billing/${invoiceId}`,
    successLogEvent: "ops.billing.finalize.applied",
    failureLogEvent: "ops.billing.finalize.failed",
  });
}
