// POST /api/ops/admin/patients/:patientId/allergies/record
//
// Dispatches `RecordPatientAllergy`. RBAC and every clinical rule are
// enforced by the command (`patients.allergies.record`); this route only
// translates a browser form into its input.
//
// TWO TRANSLATION DECISIONS WORTH NAMING:
//
//   - An empty string means "not supplied", not "empty value". A
//     `<select>` with no choice and a blank text input both post `""`,
//     and passing that through would fail the command's Zod `min(1)`
//     with a message about a field the operator never filled in.
//
//   - `substanceCode` is dropped when the code system is UNCODED, rather
//     than passed through as empty. The command REJECTS an UNCODED
//     record carrying a code, and the form leaves the code input visible
//     for all systems — so an operator who types a code and then
//     switches the system to UNCODED would otherwise get a validation
//     error for a field they had already given up on.

import { RecordPatientAllergy } from "@pharmax/patients";

import { dispatchOpsCommand } from "../../../../../../../../src/server/ops/dispatch-from-route.js";

interface RouteParams {
  readonly params: Promise<{ readonly patientId: string }>;
}

type Body = FormData | Record<string, unknown>;

function readString(body: Body, key: string): string | null {
  const raw = body instanceof FormData ? body.get(key) : (body as Record<string, unknown>)[key];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readAll(body: Body, key: string): ReadonlyArray<string> {
  if (body instanceof FormData) {
    return body.getAll(key).filter((v): v is string => typeof v === "string");
  }
  const raw = (body as Record<string, unknown>)[key];
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === "string");
  return typeof raw === "string" ? [raw] : [];
}

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { patientId } = await context.params;
  return await dispatchOpsCommand({
    request,
    command: RecordPatientAllergy,
    idempotencyKeyPrefix: `route:record-patient-allergy:${patientId}`,
    buildInput: ({ body }) => {
      const codeSystem = readString(body, "substanceCodeSystem");
      if (codeSystem === null) {
        return { error: "Choose a code system for the substance." };
      }

      const input: Record<string, unknown> = {
        patientId,
        substanceCodeSystem: codeSystem,
      };

      const code = readString(body, "substanceCode");
      if (code !== null && codeSystem !== "UNCODED") input["substanceCode"] = code;

      for (const key of ["substanceLabel", "reactionNote", "onsetDate"] as const) {
        const value = readString(body, key);
        if (value !== null) input[key] = value;
      }
      for (const key of [
        "category",
        "type",
        "criticality",
        "verificationStatus",
        "reactionSeverity",
      ] as const) {
        const value = readString(body, key);
        if (value !== null) input[key] = value;
      }

      const manifestations = readAll(body, "reactionManifestations").filter((m) => m.length > 0);
      if (manifestations.length > 0) input["reactionManifestations"] = manifestations;

      return input as unknown as Parameters<typeof RecordPatientAllergy.handle>[0]["input"];
    },
    successRedirect: (output) =>
      `/ops/admin/patients/${patientId}?flash=${encodeURIComponent(
        output.screenable
          ? "Allergy recorded. PV1 screening can compare this record automatically."
          : "Allergy recorded. It cannot be compared automatically at PV1 (uncoded or non-drug), so a pharmacist must read it."
      )}`,
    failureRedirect: `/ops/admin/patients/${patientId}`,
    successLogEvent: "ops.admin.patient.allergy.recorded",
    failureLogEvent: "ops.admin.patient.allergy.record.failed",
  });
}
