// POST /api/ops/admin/patients/:patientId/allergies/:allergyId/amend-status
//
// Dispatches `AmendPatientAllergyStatus` — the retraction path. Gated by
// `patients.allergies.amend_status`, which is a pharmacist-level grant
// because this is the only edit that can switch a safety check off.
//
// The form posts both statuses pre-filled with the record's current
// values, so an operator changing one does not silently reset the other.
// The command refuses an amendment that changes neither, which is what
// turns an accidental double-submit into a visible error rather than a
// status-change stamp on a record whose status did not change.

import { AmendPatientAllergyStatus } from "@pharmax/patients";

import { dispatchOpsCommand } from "../../../../../../../../../src/server/ops/dispatch-from-route.js";

interface RouteParams {
  readonly params: Promise<{ readonly patientId: string; readonly allergyId: string }>;
}

type Body = FormData | Record<string, unknown>;

function readString(body: Body, key: string): string | null {
  const raw = body instanceof FormData ? body.get(key) : (body as Record<string, unknown>)[key];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { patientId, allergyId } = await context.params;
  return await dispatchOpsCommand({
    request,
    command: AmendPatientAllergyStatus,
    idempotencyKeyPrefix: `route:amend-patient-allergy:${allergyId}`,
    buildInput: ({ body }) => {
      const reasonCode = readString(body, "reasonCode");
      if (reasonCode === null) {
        return { error: "Choose a reason for the status change." };
      }
      const input: Record<string, unknown> = { allergyId, reasonCode };
      for (const key of ["clinicalStatus", "verificationStatus"] as const) {
        const value = readString(body, key);
        if (value !== null) input[key] = value;
      }
      return input as unknown as Parameters<typeof AmendPatientAllergyStatus.handle>[0]["input"];
    },
    successRedirect: (output) =>
      `/ops/admin/patients/${patientId}?flash=${encodeURIComponent(
        output.screenable
          ? "Allergy status amended. The record still participates in PV1 screening."
          : "Allergy status amended. The record no longer participates in PV1 screening — it stays in the history."
      )}`,
    failureRedirect: `/ops/admin/patients/${patientId}`,
    successLogEvent: "ops.admin.patient.allergy.status_amended",
    failureLogEvent: "ops.admin.patient.allergy.status_amend.failed",
  });
}
