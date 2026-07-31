// POST /api/ops/admin/roles/create
//
// Admin action: mint a custom role. Dispatches `CreateRole` (RBAC
// `roles.manage` enforced by the command; MFA floor enforced by the
// wrapper). An optional `preset` names a position template whose
// permission set seeds the new role — the "start from position" half
// of the privilege model; blank presets start with no permissions.
//
// On success we land the admin on the new role's editor page so
// fine-tuning is the natural next step.

import { CreateRole } from "@pharmax/orgs";
import { findRoleTemplate } from "@pharmax/rbac";

import { dispatchOpsCommandWithMfa } from "../../../../../../src/server/auth/dispatch-ops-with-mfa.js";

const ROLE_SCOPES = new Set(["ORGANIZATION", "SITE", "CLINIC", "TEAM"]);

function readString(body: FormData | Record<string, unknown>, key: string): string | null {
  const raw = body instanceof FormData ? body.get(key) : (body as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

export async function POST(request: Request): Promise<Response> {
  return await dispatchOpsCommandWithMfa({
    request,
    command: CreateRole,
    idempotencyKeyPrefix: "route:create-role",
    buildInput: ({ body }) => {
      const code = readString(body, "code");
      if (code === null) return { error: "code is required." };
      const name = readString(body, "name");
      if (name === null) return { error: "name is required." };

      const scope = readString(body, "scope") ?? "ORGANIZATION";
      if (!ROLE_SCOPES.has(scope)) return { error: `Unknown scope "${scope}".` };

      const description = readString(body, "description");

      // Preset resolution: a position template's permission set is the
      // starting point. The template registry is compile-time data, so
      // an unknown preset is a form-tampering signal, not a race.
      const preset = readString(body, "preset");
      let permissions: ReadonlyArray<string> = [];
      if (preset !== null) {
        const template = findRoleTemplate(preset);
        if (template === undefined) return { error: `Unknown position preset "${preset}".` };
        permissions = template.permissions;
      }

      return {
        code,
        name,
        scope: scope as "ORGANIZATION" | "SITE" | "CLINIC" | "TEAM",
        ...(description !== null ? { description } : {}),
        permissions: [...permissions],
      };
    },
    successRedirect: (output) =>
      `/ops/admin/roles/${output.roleId}?flash=${encodeURIComponent(
        `Role ${output.code} created with ${output.permissionCount} permissions. Fine-tune below.`
      )}`,
    failureRedirect: "/ops/admin/roles",
    successLogEvent: "ops.admin.role.create.applied",
    failureLogEvent: "ops.admin.role.create.failed",
  });
}
