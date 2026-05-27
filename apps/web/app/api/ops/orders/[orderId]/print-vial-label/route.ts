// POST /api/ops/orders/:orderId/print-vial-label
//
// Tech prints the vial label for one order line. This is the only
// fill-loop route that requires workstation context, because
// PrintVialLabel declares `requiresWorkstation: true` (the
// workstation is part of the print-job audit trail and routes the
// print job to a physically-paired printer).
//
// SECURITY: the operator can post any UUID for `workstationId`.
// The route validates the workstation (a) belongs to the
// operator's organization, (b) is at the order's pharmacy site,
// and (c) is ACTIVE. Failure surfaces a flash error rather than
// silently downgrading to "no workstation".
//
// RBAC enforced by the command (`fill.print_vial_label` permission).

import { prisma } from "@pharmax/database";
import { PrintVialLabel } from "@pharmax/fill";
import { DEFAULT_VIAL_TEMPLATE_CODE } from "@pharmax/labels";

import { dispatchOpsCommand } from "../../../../../../src/server/ops/dispatch-from-route.js";
import { assertWorkstationBelongsToSite } from "../../../../../../src/server/ops/get-fill-workbench.js";

interface RouteParams {
  readonly params: Promise<{ readonly orderId: string }>;
}

function readString(body: FormData | Record<string, unknown>, key: string): string | null {
  const raw = body instanceof FormData ? body.get(key) : (body as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { orderId } = await context.params;
  return await dispatchOpsCommand({
    request,
    command: PrintVialLabel,
    idempotencyKeyPrefix: `route:print-vial-label:${orderId}`,
    buildInput: ({ body }) => {
      const orderLineId = readString(body, "orderLineId");
      const printerId = readString(body, "printerId");
      if (orderLineId === null) return { error: "orderLineId is required." };
      if (printerId === null) return { error: "printerId is required." };
      return {
        orderId,
        orderLineId,
        printerId,
        templateCode: DEFAULT_VIAL_TEMPLATE_CODE,
      };
    },
    resolveTenancyExtras: async ({ body, organizationId }) => {
      const workstationId = readString(body, "workstationId");
      if (workstationId === null) {
        return { error: "workstationId is required for printing. Select one above." };
      }
      // Lookup the order's site to scope the workstation check.
      // System context not needed — the operator's tenancy covers
      // this read (order is org-scoped).
      const order = await prisma.order.findFirst({
        where: { id: orderId, organizationId },
        select: { siteId: true },
      });
      if (order === null) {
        return { error: "Order not found." };
      }
      const ok = await assertWorkstationBelongsToSite({
        organizationId,
        siteId: order.siteId,
        workstationId,
      });
      if (!ok) {
        return {
          error: "Selected workstation is not active at this order's pharmacy site. Pick another.",
        };
      }
      return { workstationId, siteId: order.siteId };
    },
    successRedirect: () => `/ops/fill/${orderId}?flash=Vial+label+sent+to+printer`,
    failureRedirect: `/ops/fill/${orderId}`,
    successLogEvent: "ops.fill.print_vial_label.applied",
    failureLogEvent: "ops.fill.print_vial_label.failed",
  });
}
