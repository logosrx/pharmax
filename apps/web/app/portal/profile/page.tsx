// Prescriber profile page (ADR-0033, slice 3): read-only identity +
// editable contact details, routed through UpdateProvider server-side.

import { redirect } from "next/navigation";

import { PortalProfileForm } from "../../../src/components/portal/portal-profile-form.js";
import { PortalShell } from "../../../src/components/portal/portal-shell.js";
import { getCurrentPortalIdentity } from "../../../src/server/portal/current-session.js";
import { getPortalProviderProfile } from "../../../src/server/portal/provider-profile.js";

export default async function Page() {
  const identity = await getCurrentPortalIdentity();
  if (identity === null) {
    redirect("/portal/sign-in");
  }

  const profile = await getPortalProviderProfile({
    organizationId: identity.session.organizationId,
    providerId: identity.provider.id,
  });
  if (profile === null) {
    redirect("/portal/sign-in");
  }

  const displayName = `${identity.provider.firstName} ${identity.provider.lastName}${
    identity.provider.credential === null ? "" : `, ${identity.provider.credential}`
  }`;

  return (
    <PortalShell active="profile">
      <section className="rounded-lg border border-line bg-surface p-6">
        <h1 className="text-sm font-semibold text-fg">Identity</h1>
        <dl className="mt-4 space-y-2 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Name</dt>
            <dd className="text-fg">{displayName}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">NPI</dt>
            <dd className="font-mono text-fg">{identity.provider.npi}</dd>
          </div>
        </dl>
      </section>

      <PortalProfileForm
        initial={{
          phone: profile.phone ?? "",
          email: profile.email ?? "",
          addressLine1: profile.addressLine1 ?? "",
          addressLine2: profile.addressLine2 ?? "",
          city: profile.city ?? "",
          state: profile.state ?? "",
          postalCode: profile.postalCode ?? "",
        }}
      />
    </PortalShell>
  );
}
