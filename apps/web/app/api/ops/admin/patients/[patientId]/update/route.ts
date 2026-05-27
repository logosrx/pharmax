// POST /api/ops/admin/patients/:patientId/update
//
// Admin action: edit patient identity / contact / address.
// Dispatches `UpdatePatient` — the command re-encrypts every
// changed PHI field via @pharmax/crypto + refreshes the matching
// blind index, with the full input redacted from
// command_log.requestPayload.
//
// FORM SHAPE: the patient-detail page sends all fields whether
// changed or not (pre-filled from current values). The route
// passes through any non-empty string as a "set this value"
// update; the command's diff logic decides whether each is
// actually a change. Empty strings are SKIPPED (treated as
// "unchanged"), NOT cleared — the form has no separate
// "clear" affordance for v1; use CryptoShredPatient for the
// forget-me path. (Identity fields cannot be cleared anyway per
// the command's Zod schema.)
//
// RBAC enforced by the command (`patients.update`).

import { UpdatePatient } from "@pharmax/patients";

import { dispatchOpsCommand } from "../../../../../../../src/server/ops/dispatch-from-route.js";

interface RouteParams {
  readonly params: Promise<{ readonly patientId: string }>;
}

const STRING_FIELDS = [
  "firstName",
  "lastName",
  "dateOfBirth",
  "middleName",
  "sexAtBirth",
  "ssnLast4",
  "phone",
  "email",
  "addressLine1",
  "addressLine2",
  "city",
  "state",
  "postalCode",
  "mrn",
] as const;

function readString(body: FormData | Record<string, unknown>, key: string): string | null {
  const raw = body instanceof FormData ? body.get(key) : (body as Record<string, unknown>)[key];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { patientId } = await context.params;
  return await dispatchOpsCommand({
    request,
    command: UpdatePatient,
    idempotencyKeyPrefix: `route:update-patient:${patientId}`,
    buildInput: ({ body }) => {
      const input: Record<string, unknown> = { patientId };
      for (const key of STRING_FIELDS) {
        const value = readString(body, key);
        if (value !== null) {
          // State always uppercase (the command's Zod regex
          // expects 2 uppercase letters; absorb operator typing).
          input[key] = key === "state" ? value.toUpperCase() : value;
        }
      }
      // The command requires at least one updatable field beyond
      // patientId. If the form was all-empty, surface a friendly
      // error instead of a generic Zod failure.
      if (Object.keys(input).length === 1) {
        return { error: "No fields to update. Fill in at least one field above." };
      }
      return input as unknown as Parameters<typeof UpdatePatient.handle>[0]["input"];
    },
    successRedirect: () =>
      `/ops/admin/patients/${patientId}?flash=${encodeURIComponent("Patient updated.")}`,
    failureRedirect: `/ops/admin/patients/${patientId}`,
    successLogEvent: "ops.admin.patient.update.applied",
    failureLogEvent: "ops.admin.patient.update.failed",
  });
}
