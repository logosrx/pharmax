// POST /api/ops/admin/patients/:patientId/allergies/assert-history
//
// Dispatches `AssertPatientAllergyHistory` — the command that turns "no
// allergies listed" into "a history was taken and found none, by this
// person, on this date".
//
// `assertedAt` is deliberately NOT accepted from the form. The command
// supports backfilling a clinical time within a window, which is right
// for an importer, but a console field for it would let an operator
// date a history they took today to a date that suits them — and this
// assertion is what allows allergy screening to report clear. The
// console records the history as taken now.

import { AssertPatientAllergyHistory } from "@pharmax/patients";

import { dispatchOpsCommand } from "../../../../../../../../src/server/ops/dispatch-from-route.js";

interface RouteParams {
  readonly params: Promise<{ readonly patientId: string }>;
}

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { patientId } = await context.params;
  return await dispatchOpsCommand({
    request,
    command: AssertPatientAllergyHistory,
    idempotencyKeyPrefix: `route:assert-allergy-history:${patientId}`,
    buildInput: ({ body }) => {
      const raw =
        body instanceof FormData ? body.get("status") : (body as Record<string, unknown>)["status"];
      const status = typeof raw === "string" ? raw.trim() : "";
      if (status.length === 0) {
        return {
          error: "Choose whether the history found no known allergies or was unable to assess.",
        };
      }
      return { patientId, status } as unknown as Parameters<
        typeof AssertPatientAllergyHistory.handle
      >[0]["input"];
    },
    successRedirect: (output) =>
      `/ops/admin/patients/${patientId}?flash=${encodeURIComponent(
        output.satisfiesAllergyScreening
          ? "Allergy history recorded as no known allergies. PV1 allergy screening will now report clear for this patient."
          : "Recorded that the allergy history could not be obtained. The PV1 allergy gap stays open — this is not an answer."
      )}`,
    failureRedirect: `/ops/admin/patients/${patientId}`,
    successLogEvent: "ops.admin.patient.allergy_history.asserted",
    failureLogEvent: "ops.admin.patient.allergy_history.assert.failed",
  });
}
