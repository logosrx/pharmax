// POST /api/ops/billing/invoices/:invoiceId/approve
//
// Operator action: record the review of a DRAFT invoice, stamping the
// revision that FinalizeInvoice requires. Dispatches the standard
// `ApproveInvoice` command. RBAC enforced by the command
// (`billing.approve_invoice` permission).

import { ApproveInvoice } from "@pharmax/billing";

import { dispatchOpsCommandWithMfa } from "../../../../../../../src/server/auth/dispatch-ops-with-mfa.js";

interface RouteParams {
  readonly params: Promise<{ readonly invoiceId: string }>;
}

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { invoiceId } = await context.params;
  return await dispatchOpsCommandWithMfa({
    request,
    command: ApproveInvoice,
    idempotencyKeyPrefix: `route:approve-invoice:${invoiceId}`,
    buildInput: ({ body, bodyKind }) => {
      const note =
        bodyKind === "json"
          ? (body as Record<string, unknown>)["approvalNote"]
          : (body as FormData).get("approvalNote");
      const approvalNote = typeof note === "string" && note.trim().length > 0 ? note : undefined;
      return approvalNote === undefined ? { invoiceId } : { invoiceId, approvalNote };
    },
    successRedirect: () => `/ops/billing/${invoiceId}?flash=approved`,
    failureRedirect: `/ops/billing/${invoiceId}`,
    successLogEvent: "ops.billing.approve.applied",
    failureLogEvent: "ops.billing.approve.failed",
  });
}
