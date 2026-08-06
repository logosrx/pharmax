// POST /api/ops/orders/:orderId/acknowledge-pv1-screening-finding
//
// A pharmacist records their judgement on ONE clinical-screening
// finding, which is what lets `ApprovePV1` past it. Dispatches
// `AcknowledgePV1ScreeningFinding`. RBAC enforced by the command
// (`pv1.approve` — the authority to record the judgement that opens
// the gate is the authority to sign the approval itself).
//
// One finding per request, deliberately: there is no bulk form and no
// repeated `fingerprint` field to collect. See the header of
// `screening-findings-panel.tsx`.
//
// The redirect lands back on the order detail page, because that is
// where the panel is and where the pharmacist's next decision happens.
// `alreadyAcknowledged` gets its own flash: a double-submit should say
// "already on record" rather than claim a second judgement was taken.
//
// PHI: the fingerprint is an identity string built from finding codes
// and gradings. It is read from the POST body and never put into the
// redirect.

import { AcknowledgePV1ScreeningFinding } from "@pharmax/verification";

import { dispatchOpsCommand } from "../../../../../../src/server/ops/dispatch-from-route.js";

interface RouteParams {
  readonly params: Promise<{ readonly orderId: string }>;
}

function readString(body: FormData | Record<string, unknown>, key: string): string | null {
  if (body instanceof FormData) {
    const v = body.get(key);
    return typeof v === "string" && v.length > 0 ? v : null;
  }
  const v = (body as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { orderId } = await context.params;
  return await dispatchOpsCommand({
    request,
    command: AcknowledgePV1ScreeningFinding,
    idempotencyKeyPrefix: `route:acknowledge-pv1-screening-finding:${orderId}`,
    buildInput: ({ body }) => {
      const fingerprint = readString(body, "fingerprint");
      if (fingerprint === null) {
        return { error: "fingerprint is required to acknowledge a screening finding." };
      }
      return { orderId, fingerprint };
    },
    successRedirect: (output) =>
      `/ops/orders/${orderId}?flash=${
        output.alreadyAcknowledged ? "screening_already_acknowledged" : "screening_acknowledged"
      }`,
    failureRedirect: `/ops/orders/${orderId}`,
    successLogEvent: "ops.pv1.screening.acknowledge.applied",
    failureLogEvent: "ops.pv1.screening.acknowledge.failed",
  });
}
