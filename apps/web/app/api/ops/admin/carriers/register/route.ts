// POST /api/ops/admin/carriers/register
//
// Admin action: register (or rotate) a per-organization carrier
// credential. Dispatches `RegisterCarrierCredential` — the
// command encrypts the API key + webhook secret via @pharmax/crypto
// (AAD-bound to the new credential row), DISABLEs any prior ACTIVE
// credential for the same provider, and writes audit + outbox.
//
// SECURITY: the apiKey / webhookSecret fields are scrubbed from
// command_log.requestPayload by the command's `redactFields`. The
// route here ALSO avoids logging the body — dispatchOpsCommand's
// success/failure logger emits only the operator id + the typed
// success/failure event name.
//
// RBAC enforced by the command (`ship.manage_carrier_credentials`).

import { ShippingProvider } from "@pharmax/database";
import { RegisterCarrierCredential } from "@pharmax/shipping";

import { dispatchOpsCommandWithMfa } from "../../../../../../src/server/auth/dispatch-ops-with-mfa.js";

/**
 * EASYPOST is deliberately absent — no BAA covers it.
 *
 * The type is narrowed rather than left as `ShippingProvider` so that
 * re-adding a blocked provider here is a compile error, not a runtime
 * rejection discovered by an admin. The command's schema refuses it
 * independently; this list decides only what the route advertises, and
 * it must not name a provider the command will reject.
 */
type RegistrableProvider = typeof ShippingProvider.FEDEX | typeof ShippingProvider.UPS;

const PROVIDERS: ReadonlySet<RegistrableProvider> = new Set([
  ShippingProvider.FEDEX,
  ShippingProvider.UPS,
]);

function readString(body: FormData | Record<string, unknown>, key: string): string | null {
  const raw = body instanceof FormData ? body.get(key) : (body as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

export async function POST(request: Request): Promise<Response> {
  return await dispatchOpsCommandWithMfa({
    request,
    command: RegisterCarrierCredential,
    idempotencyKeyPrefix: `route:register-carrier:${Date.now()}`,
    buildInput: ({ body }) => {
      const provider = readString(body, "provider");
      const apiKey = readString(body, "apiKey");
      if (provider === null || !PROVIDERS.has(provider as RegistrableProvider)) {
        return {
          error: `provider must be one of: ${Array.from(PROVIDERS).join(", ")}.`,
        };
      }
      if (apiKey === null) return { error: "apiKey is required." };
      const webhookSecret = readString(body, "webhookSecret");
      const carrierAccountId = readString(body, "carrierAccountId");
      const baseUrl = readString(body, "baseUrl");
      const notes = readString(body, "notes");
      return {
        provider: provider as RegistrableProvider,
        apiKey,
        ...(webhookSecret !== null ? { webhookSecret } : {}),
        ...(carrierAccountId !== null ? { carrierAccountId } : {}),
        ...(baseUrl !== null ? { baseUrl } : {}),
        ...(notes !== null ? { notes } : {}),
      };
    },
    successRedirect: () =>
      `/ops/admin/carriers?flash=${encodeURIComponent(
        "Credential registered. Any prior ACTIVE credential for this provider was disabled."
      )}`,
    failureRedirect: `/ops/admin/carriers`,
    successLogEvent: "ops.admin.carrier.register.applied",
    failureLogEvent: "ops.admin.carrier.register.failed",
  });
}
