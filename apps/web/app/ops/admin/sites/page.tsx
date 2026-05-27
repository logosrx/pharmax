// /ops/admin/sites — pharmacy site admin.
//
// Lists every PharmacySite in the operator's organization with an
// inline edit form per site for the ship-from address. The address
// is plaintext (non-PHI; pharmacy business address by HIPAA Safe
// Harbor) — the form sends to UpdatePharmacySiteAddress which
// audits + outboxes the change but does not encrypt.
//
// Completion status (`addressComplete`) drives a small status
// badge so the operator can see at a glance which sites are
// ready for the carrier auto-purchase flow.
//
// Permission gate: `org.manage_sites`.

import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../src/server/auth/resolve-tenancy.js";
import {
  listPharmacySites,
  type PharmacySiteRow,
} from "../../../../src/server/ops/list-pharmacy-sites.js";

interface SiteFormProps {
  readonly site: PharmacySiteRow;
}

function SiteForm({ site }: SiteFormProps) {
  return (
    <form
      action={`/api/ops/admin/sites/${site.siteId}/update-address`}
      method="POST"
      className="space-y-3 rounded-md border border-neutral-800 bg-neutral-950 p-4"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm text-neutral-100">{site.code}</span>
            <span className="text-sm text-neutral-300">{site.name}</span>
            <span
              className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs ${
                site.status === "ACTIVE"
                  ? "border-emerald-700 bg-emerald-950 text-emerald-200"
                  : "border-neutral-700 bg-neutral-900 text-neutral-400"
              }`}
            >
              {site.status}
            </span>
            <span
              className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs ${
                site.addressComplete
                  ? "border-emerald-700 bg-emerald-950 text-emerald-200"
                  : "border-amber-700 bg-amber-950 text-amber-200"
              }`}
            >
              {site.addressComplete ? "address complete" : "needs address"}
            </span>
          </div>
          <div className="text-xs text-neutral-500">timezone {site.timezone}</div>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs text-neutral-500 sm:col-span-2">
          Address line 1
          <input
            type="text"
            name="addressLine1"
            required
            maxLength={200}
            defaultValue={site.addressLine1 ?? ""}
            className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100"
          />
        </label>
        <label className="space-y-1 text-xs text-neutral-500 sm:col-span-2">
          Address line 2 (optional)
          <input
            type="text"
            name="addressLine2"
            maxLength={200}
            defaultValue={site.addressLine2 ?? ""}
            className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100"
          />
        </label>
        <label className="space-y-1 text-xs text-neutral-500">
          City
          <input
            type="text"
            name="city"
            required
            maxLength={100}
            defaultValue={site.city ?? ""}
            className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100"
          />
        </label>
        <label className="space-y-1 text-xs text-neutral-500">
          State
          <input
            type="text"
            name="state"
            required
            maxLength={80}
            defaultValue={site.state ?? ""}
            className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100"
          />
        </label>
        <label className="space-y-1 text-xs text-neutral-500">
          Postal code
          <input
            type="text"
            name="postalCode"
            required
            maxLength={20}
            defaultValue={site.postalCode ?? ""}
            className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100"
          />
        </label>
        <label className="space-y-1 text-xs text-neutral-500">
          Country (ISO 3166-1 alpha-2)
          <input
            type="text"
            name="country"
            required
            maxLength={2}
            defaultValue={site.country}
            className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 font-mono text-sm uppercase text-neutral-100"
          />
        </label>
        <label className="space-y-1 text-xs text-neutral-500 sm:col-span-2">
          Phone (optional but required by some carriers)
          <input
            type="tel"
            name="phone"
            maxLength={40}
            defaultValue={site.phone ?? ""}
            className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100"
          />
        </label>
      </div>

      <button
        type="submit"
        className="rounded-md border border-blue-700 bg-blue-900 px-3 py-1.5 text-sm text-blue-100 hover:bg-blue-800"
      >
        Save address
      </button>
    </form>
  );
}

export default async function SiteAdminPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.ORG_MANAGE_SITES)) {
    return (
      <main className="space-y-3">
        <h1 className="text-2xl font-semibold text-neutral-50">Sites</h1>
        <p className="text-neutral-400">
          You don&apos;t have permission to manage pharmacy sites. Contact your admin to request{" "}
          <code className="text-neutral-200">org.manage_sites</code>.
        </p>
      </main>
    );
  }

  const sites = await listPharmacySites({
    organizationId: session.tenancy.organizationId,
  });
  const flash = typeof params["flash"] === "string" ? params["flash"] : null;
  const flashError = typeof params["error"] === "string" ? params["error"] : null;

  return (
    <main className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-neutral-50">Pharmacy sites</h1>
        <p className="text-sm text-neutral-400">
          The ship-from address configured here is used by the carrier auto-purchase flow
          (PurchaseShipmentLabel). Sites without a complete address fall back to manual shipment
          entry on the shipping queue.
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

      {sites.length === 0 ? (
        <div className="rounded-md border border-neutral-800 bg-neutral-950 p-6 text-sm text-neutral-400">
          No pharmacy sites configured. Run <code>CreateOrganization</code> or seed a site first.
        </div>
      ) : (
        <ul className="space-y-4">
          {sites.map((site) => (
            <li key={site.siteId}>
              <SiteForm site={site} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
