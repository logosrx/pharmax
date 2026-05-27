// POST /api/ops/orders/:orderId/assign-lot
//
// Tech assigns an inventory lot to a single order line. The
// command validates lot status (must be ACTIVE), expiry (must be
// today or future), NDC match against the line's prescription,
// and site match against the order's pharmacy site. RBAC enforced
// by the command (`fill.assign_lot` permission).

import { AssignLot } from "@pharmax/fill";

import { dispatchOpsCommand } from "../../../../../../src/server/ops/dispatch-from-route.js";

interface RouteParams {
  readonly params: Promise<{ readonly orderId: string }>;
}

function readUuid(body: FormData | Record<string, unknown>, key: string): string | null {
  const raw = body instanceof FormData ? body.get(key) : (body as Record<string, unknown>)[key];
  if (typeof raw !== "string" || raw.length === 0) return null;
  // Server-side shape only — Zod re-validates inside the command.
  return raw;
}

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { orderId } = await context.params;
  return await dispatchOpsCommand({
    request,
    command: AssignLot,
    idempotencyKeyPrefix: `route:assign-lot:${orderId}`,
    buildInput: ({ body }) => {
      const orderLineId = readUuid(body, "orderLineId");
      const lotId = readUuid(body, "lotId");
      if (orderLineId === null) return { error: "orderLineId is required." };
      if (lotId === null) return { error: "lotId is required." };
      return { orderId, orderLineId, lotId };
    },
    successRedirect: () => `/ops/fill/${orderId}?flash=Lot+assigned`,
    failureRedirect: `/ops/fill/${orderId}`,
    successLogEvent: "ops.fill.assign_lot.applied",
    failureLogEvent: "ops.fill.assign_lot.failed",
  });
}
