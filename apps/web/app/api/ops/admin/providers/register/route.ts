// POST /api/ops/admin/providers/register
//
// Register a prescriber from the operator console. Not MFA-gated:
// registering does not by itself let anyone prescribe — the prescriber
// still has to be affiliated with a client, and a DEA number supplied
// here is validated by checksum before it grants anything.
//
// Optional fields are omitted rather than sent empty, because the
// command's schema is `.strict()` with per-field regexes: an empty
// string for `postalCode` would fail the ZIP pattern instead of reading
// as "not provided".

import { RegisterProvider } from "@pharmax/providers";

import { dispatchOpsCommand } from "@/server/ops/dispatch-from-route";
import { readStringField } from "@/server/ops/read-body-field";

/** Every optional text field, all handled identically. */
const OPTIONAL_FIELDS = [
  "credential",
  "deaNumber",
  "phone",
  "email",
  "addressLine1",
  "addressLine2",
  "city",
  "state",
  "postalCode",
] as const;

export async function POST(request: Request): Promise<Response> {
  return await dispatchOpsCommand({
    request,
    command: RegisterProvider,
    idempotencyKeyPrefix: `route:register-provider:${Date.now()}`,
    buildInput: ({ body }) => {
      const npi = readStringField(body, "npi");
      const firstName = readStringField(body, "firstName");
      const lastName = readStringField(body, "lastName");

      if (npi === null) return { error: "An NPI is required." };
      if (firstName === null || lastName === null) {
        return { error: "First and last name are required." };
      }

      const optional: Record<string, string> = {};
      for (const field of OPTIONAL_FIELDS) {
        const value = readStringField(body, field);
        if (value !== null) optional[field] = value;
      }

      return { npi, firstName, lastName, ...optional };
    },
    // Straight to the credentials page: the next thing an operator
    // needs is usually to record an expiry or a state licence.
    successRedirect: (output) =>
      `/ops/admin/providers/${output.providerId}?flash=${encodeURIComponent(
        "Prescriber registered."
      )}`,
    failureRedirect: "/ops/admin/providers/new",
    successLogEvent: "ops.admin.provider.register.applied",
    failureLogEvent: "ops.admin.provider.register.failed",
  });
}
