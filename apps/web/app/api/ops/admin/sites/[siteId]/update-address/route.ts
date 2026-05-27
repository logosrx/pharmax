// POST /api/ops/admin/sites/:siteId/update-address
//
// Admin action: write or update the ship-from address on a
// PharmacySite. Dispatches `UpdatePharmacySiteAddress` — plaintext
// columns (non-PHI), but the change still goes through the
// command bus for audit + outbox.
//
// RBAC enforced by the command (`org.manage_sites`).

import { UpdatePharmacySiteAddress } from "@pharmax/orgs";

import { dispatchOpsCommandWithMfa } from "../../../../../../../src/server/auth/dispatch-ops-with-mfa.js";

interface RouteParams {
  readonly params: Promise<{ readonly siteId: string }>;
}

function readString(body: FormData | Record<string, unknown>, key: string): string | null {
  const raw = body instanceof FormData ? body.get(key) : (body as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { siteId } = await context.params;
  return await dispatchOpsCommandWithMfa({
    request,
    command: UpdatePharmacySiteAddress,
    idempotencyKeyPrefix: `route:update-site-address:${siteId}`,
    buildInput: ({ body }) => {
      const addressLine1 = readString(body, "addressLine1");
      const city = readString(body, "city");
      const state = readString(body, "state");
      const postalCode = readString(body, "postalCode");
      const countryRaw = readString(body, "country");
      if (addressLine1 === null) return { error: "addressLine1 is required." };
      if (city === null) return { error: "city is required." };
      if (state === null) return { error: "state is required." };
      if (postalCode === null) return { error: "postalCode is required." };
      if (countryRaw === null) return { error: "country is required." };
      const country = countryRaw.toUpperCase();
      const addressLine2 = readString(body, "addressLine2");
      const phone = readString(body, "phone");
      return {
        siteId,
        addressLine1,
        city,
        state,
        postalCode,
        country,
        ...(addressLine2 !== null ? { addressLine2 } : {}),
        ...(phone !== null ? { phone } : {}),
      };
    },
    successRedirect: () => `/ops/admin/sites?flash=${encodeURIComponent("Site address updated.")}`,
    failureRedirect: `/ops/admin/sites`,
    successLogEvent: "ops.admin.site.update_address.applied",
    failureLogEvent: "ops.admin.site.update_address.failed",
  });
}
