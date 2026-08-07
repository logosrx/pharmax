// POST /api/ops/admin/compliance/controls/:controlId/sign-off
//
// Operator action: attest that a control is designed and operating.
// Dispatches `SignOffControl`, which holds the real enforcement —
// RBAC (`compliance.control.sign_off`) and the refusal to attest over
// failing evidence. The page disables the button in that case as a
// courtesy; this route does not re-implement the check, because two
// copies of a safety rule is one copy that drifts.

import { SignOffControl, type SignOffControlInput } from "@pharmax/compliance";

import { dispatchOpsCommand } from "../../../../../../../../src/server/ops/dispatch-from-route.js";
import { getControlCodeById } from "../../../../../../../../src/server/compliance/resolve-codes.js";

interface RouteParams {
  readonly params: Promise<{ readonly controlId: string }>;
}

const ATTESTABLE_STATUSES = [
  "IMPLEMENTED",
  "PARTIAL",
  "PLANNED",
  "DEPRECATED",
  "NOT_APPLICABLE",
] as const;

type AttestableStatus = (typeof ATTESTABLE_STATUSES)[number];

function readString(body: FormData | Record<string, unknown>, key: string): string | null {
  if (body instanceof FormData) {
    const v = body.get(key);
    return typeof v === "string" && v.length > 0 ? v : null;
  }
  const v = (body as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { controlId } = await context.params;
  const back = `/ops/admin/compliance/controls/${controlId}`;

  return await dispatchOpsCommand({
    request,
    command: SignOffControl,
    idempotencyKeyPrefix: `route:compliance-sign-off:${controlId}`,
    buildInput: async ({ body }) => {
      const statusRaw = readString(body, "status");
      const note = readString(body, "attestationNote");

      if (
        statusRaw === null ||
        !(ATTESTABLE_STATUSES as ReadonlyArray<string>).includes(statusRaw)
      ) {
        return { error: `status must be one of: ${ATTESTABLE_STATUSES.join(", ")}.` };
      }

      // Resolved from the trusted URL, never from the posted body.
      const controlCode = await getControlCodeById(controlId);
      if (controlCode === null) {
        return { error: "That control no longer exists." };
      }

      const input: SignOffControlInput = {
        controlCode,
        status: statusRaw as AttestableStatus,
        attestationNote: note,
      };
      return input;
    },
    successRedirect: () => `${back}?flash=signed-off`,
    failureRedirect: back,
    successLogEvent: "ops.compliance.control.sign_off.applied",
    failureLogEvent: "ops.compliance.control.sign_off.failed",
  });
}
