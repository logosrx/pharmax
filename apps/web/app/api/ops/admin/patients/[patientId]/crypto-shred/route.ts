// POST /api/ops/admin/patients/:patientId/crypto-shred
//
// DESTRUCTIVE + IRREVERSIBLE. Dispatches `CryptoShredPatient` —
// every PHI envelope + blind-index column on the patient row is
// NULLed; the underlying DEK is destroyed; the row stays for
// audit history + FK integrity but no future decrypt can recover
// the plaintext.
//
// RBAC enforced by the command (`patients.crypto_shred` — granted
// to OrgAdmin only by default). Double-shred is rejected by the
// command with PATIENT_ALREADY_SHREDDED.

import { CRYPTO_SHRED_REASONS, type CryptoShredReason } from "@pharmax/crypto";
import { CryptoShredPatient } from "@pharmax/patients";

import { dispatchOpsCommand } from "../../../../../../../src/server/ops/dispatch-from-route.js";

interface RouteParams {
  readonly params: Promise<{ readonly patientId: string }>;
}

const VALID_REASONS: ReadonlySet<CryptoShredReason> = new Set(Object.values(CRYPTO_SHRED_REASONS));

function readString(body: FormData | Record<string, unknown>, key: string): string | null {
  const raw = body instanceof FormData ? body.get(key) : (body as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { patientId } = await context.params;
  return await dispatchOpsCommand({
    request,
    command: CryptoShredPatient,
    idempotencyKeyPrefix: `route:crypto-shred:${patientId}`,
    buildInput: ({ body }) => {
      const reason = readString(body, "reason");
      if (reason === null || !VALID_REASONS.has(reason as CryptoShredReason)) {
        return {
          error: `reason must be one of: ${Object.values(CRYPTO_SHRED_REASONS).join(", ")}.`,
        };
      }
      return { patientId, reason: reason as CryptoShredReason };
    },
    successRedirect: () =>
      `/ops/admin/patients/${patientId}?flash=${encodeURIComponent(
        "Patient crypto-shredded. Identity is permanently unreadable."
      )}`,
    failureRedirect: `/ops/admin/patients/${patientId}`,
    successLogEvent: "ops.admin.patient.crypto_shred.applied",
    failureLogEvent: "ops.admin.patient.crypto_shred.failed",
  });
}
