// /ops/admin/carriers — carrier credential admin.
//
// Operator surface for registering and rotating per-org carrier
// API credentials. The `RegisterCarrierCredential` backend command
// (shipped in the Phase-4 multi-carrier slice) already handles:
//   - Envelope-encrypting the API key + webhook secret via
//     @pharmax/crypto, AAD-bound to `(orgId, "carrier_credential",
//     "<field>", credentialId)`.
//   - Replacing the prior ACTIVE credential for the same provider
//     by marking it DISABLED (preserves audit history).
//   - Redacting `apiKey` and `webhookSecret` from
//     command_log.requestPayload so the replay record carries
//     metadata only.
//
// This page LISTS registered credentials (ACTIVE + DISABLED) for
// rotation history and renders one "register new" form per
// provider. API keys are NEVER displayed after registration — once
// you submit, the only safe surface for the secret is the carrier's
// own dashboard.
//
// Permission gate: `ship.manage_carrier_credentials`.

import { ShippingProvider } from "@pharmax/database";
import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../src/server/auth/resolve-tenancy.js";
import { listCarrierCredentials } from "../../../../src/server/ops/list-carrier-credentials.js";

function formatDate(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function statusBadgeClass(status: string): string {
  return status === "ACTIVE"
    ? "border-emerald-700 bg-emerald-950 text-emerald-200"
    : "border-neutral-700 bg-neutral-900 text-neutral-400";
}

interface RegisterFormProps {
  readonly provider: ShippingProvider;
  readonly hint: string;
}

function RegisterForm({ provider, hint }: RegisterFormProps) {
  return (
    <form
      action="/api/ops/admin/carriers/register"
      method="POST"
      className="space-y-3 rounded-md border border-neutral-800 bg-neutral-950 p-4"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-neutral-100">{provider}</h3>
        <span className="text-xs text-neutral-500">{hint}</span>
      </div>
      <input type="hidden" name="provider" value={provider} />

      <label className="space-y-1 text-xs text-neutral-500">
        API key (or `&lt;key&gt;:&lt;secret&gt;` for FedEx / UPS)
        <input
          type="password"
          name="apiKey"
          required
          autoComplete="off"
          className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 font-mono text-sm text-neutral-100"
          placeholder="paste here; encrypted before persist"
        />
      </label>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs text-neutral-500">
          Webhook signing secret (optional)
          <input
            type="password"
            name="webhookSecret"
            autoComplete="off"
            className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 font-mono text-sm text-neutral-100"
            placeholder="for inbound tracking webhook signature verification"
          />
        </label>
        <label className="space-y-1 text-xs text-neutral-500">
          Carrier account id (optional)
          <input
            type="text"
            name="carrierAccountId"
            autoComplete="off"
            className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 font-mono text-sm text-neutral-100"
            placeholder="FedEx account # / UPS shipper #"
          />
        </label>
      </div>

      <label className="space-y-1 text-xs text-neutral-500">
        Base URL (optional override)
        <input
          type="url"
          name="baseUrl"
          autoComplete="off"
          className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 font-mono text-sm text-neutral-100"
          placeholder="leave blank for sandbox/production default"
        />
      </label>

      <label className="space-y-1 text-xs text-neutral-500">
        Notes (optional)
        <input
          type="text"
          name="notes"
          maxLength={500}
          className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100"
          placeholder="e.g. rotated 2026-05-25 by admin"
        />
      </label>

      <button
        type="submit"
        className="rounded-md border border-blue-700 bg-blue-900 px-3 py-1.5 text-sm text-blue-100 hover:bg-blue-800"
      >
        Register {provider} credential
      </button>
    </form>
  );
}

export default async function CarrierAdminPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.SHIP_MANAGE_CARRIER_CREDENTIALS)) {
    return (
      <main className="space-y-3">
        <h1 className="text-2xl font-semibold text-neutral-50">Carriers</h1>
        <p className="text-neutral-400">
          You don&apos;t have permission to manage carrier credentials. Contact your admin to
          request <code className="text-neutral-200">ship.manage_carrier_credentials</code>.
        </p>
      </main>
    );
  }

  const credentials = await listCarrierCredentials({
    organizationId: session.tenancy.organizationId,
  });
  const flash = typeof params["flash"] === "string" ? params["flash"] : null;
  const flashError = typeof params["error"] === "string" ? params["error"] : null;

  return (
    <main className="space-y-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-neutral-50">Carrier credentials</h1>
        <p className="text-sm text-neutral-400">
          Per-organization API keys for the EasyPost / FedEx / UPS adapters. Registering a new
          credential automatically disables any prior ACTIVE one for the same provider. Keys are
          encrypted at rest with AAD bound to the credential row; once submitted they are never
          displayed again.
        </p>
      </header>

      {flash !== null ? (
        <div className="rounded-md border border-emerald-700 bg-emerald-950 px-4 py-3 text-sm text-emerald-200">
          {flash}
        </div>
      ) : null}
      {flashError !== null ? (
        <div className="rounded-md border border-red-700 bg-red-950 px-4 py-3 text-sm text-red-200">
          {flashError}
        </div>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-400">
          Registered ({credentials.length})
        </h2>
        {credentials.length === 0 ? (
          <div className="rounded-md border border-neutral-800 bg-neutral-950 p-6 text-sm text-neutral-400">
            No credentials registered yet. Use one of the forms below to plug in your first carrier.
          </div>
        ) : (
          <ul className="space-y-2">
            {credentials.map((c) => (
              <li
                key={c.credentialId}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-neutral-800 bg-neutral-950 px-4 py-3 text-sm"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-neutral-100">{c.provider}</span>
                    <span
                      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs ${statusBadgeClass(
                        c.status
                      )}`}
                    >
                      {c.status}
                    </span>
                    {c.hasWebhookSecret ? (
                      <span className="text-xs text-neutral-500">+ webhook signing secret</span>
                    ) : null}
                  </div>
                  <div className="text-xs text-neutral-500">
                    Registered {formatDate(c.createdAt)} by{" "}
                    <code className="text-neutral-400">{c.createdByUserId}</code>
                    {c.carrierAccountId !== null ? (
                      <>
                        {" · "}account{" "}
                        <code className="font-mono text-neutral-400">{c.carrierAccountId}</code>
                      </>
                    ) : null}
                    {c.baseUrl !== null ? (
                      <>
                        {" · "}base <code className="font-mono text-neutral-400">{c.baseUrl}</code>
                      </>
                    ) : null}
                  </div>
                  {c.notes !== null ? (
                    <div className="text-xs text-neutral-500">Notes: {c.notes}</div>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-400">
          Register or rotate
        </h2>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <RegisterForm provider={ShippingProvider.EASYPOST} hint="single API key" />
          <RegisterForm
            provider={ShippingProvider.FEDEX}
            hint="API key:client secret (colon-separated)"
          />
          <RegisterForm
            provider={ShippingProvider.UPS}
            hint="API key:client secret (colon-separated)"
          />
        </div>
      </section>
    </main>
  );
}
