// POST /api/ops/admin/practices/create
//
// Admin action: onboard a client practice. Dispatches `CreateClinic`
// (RBAC `clinics.create` enforced by the command).
//
// MFA-gated: creating a client admits a new billing counterparty to the
// organization, which is the same class of action as inviting a user.

import { CreateClinic } from "@pharmax/orgs";

import { dispatchOpsCommandWithMfa } from "../../../../../../src/server/auth/dispatch-ops-with-mfa.js";

function readString(body: FormData | Record<string, unknown>, key: string): string | null {
  const raw = body instanceof FormData ? body.get(key) : (body as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

function readStringList(body: FormData | Record<string, unknown>, key: string): string[] {
  if (body instanceof FormData) {
    return body
      .getAll(key)
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .map((v) => v.trim());
  }
  const raw = (body as Record<string, unknown>)[key];
  if (Array.isArray(raw)) {
    return raw.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  }
  return typeof raw === "string" && raw.trim().length > 0 ? [raw.trim()] : [];
}

export async function POST(request: Request): Promise<Response> {
  return await dispatchOpsCommandWithMfa({
    request,
    command: CreateClinic,
    idempotencyKeyPrefix: `route:create-clinic:${Date.now()}`,
    buildInput: ({ body }) => {
      const code = readString(body, "code");
      const name = readString(body, "name");
      const siteIds = readStringList(body, "siteIds");
      if (code === null) return { error: "Client code is required." };
      if (name === null) return { error: "Client name is required." };
      if (siteIds.length === 0) {
        return { error: "Select at least one pharmacy site that will fill for this client." };
      }
      // Uppercased here rather than rejecting a lowercase entry: the
      // code is a customer-facing identifier typed by a human, and
      // "VALLEY-WELLNESS" is what they meant.
      return { code: code.toUpperCase(), name, siteIds };
    },
    successRedirect: (output) =>
      `/ops/admin/practices/${output.clinicId}?flash=${encodeURIComponent(
        `${output.name} onboarded as ${output.code}.`
      )}`,
    failureRedirect: `/ops/admin/practices/new`,
    successLogEvent: "ops.admin.clinic.create.applied",
    failureLogEvent: "ops.admin.clinic.create.failed",
  });
}
