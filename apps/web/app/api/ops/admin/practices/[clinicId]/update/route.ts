// POST /api/ops/admin/practices/[clinicId]/update
//
// Admin action: correct a client practice's display name. The client
// code is immutable and has no input — invoices and prescriptions cite
// it, so renaming it would rewrite the meaning of records already sent.

import { UpdateClinic } from "@pharmax/orgs";

import { dispatchOpsCommandWithMfa } from "../../../../../../../src/server/auth/dispatch-ops-with-mfa.js";

interface RouteParams {
  readonly params: Promise<{ readonly clinicId: string }>;
}

function readString(body: FormData | Record<string, unknown>, key: string): string | null {
  const raw = body instanceof FormData ? body.get(key) : (body as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { clinicId } = await context.params;
  return await dispatchOpsCommandWithMfa({
    request,
    command: UpdateClinic,
    idempotencyKeyPrefix: `route:update-clinic:${clinicId}:${Date.now()}`,
    buildInput: ({ body }) => {
      const name = readString(body, "name");
      if (name === null) return { error: "Client name is required." };
      return { clinicId, name };
    },
    successRedirect: () =>
      `/ops/admin/practices/${clinicId}?flash=${encodeURIComponent("Client name updated.")}`,
    failureRedirect: `/ops/admin/practices/${clinicId}`,
    successLogEvent: "ops.admin.clinic.update.applied",
    failureLogEvent: "ops.admin.clinic.update.failed",
  });
}
