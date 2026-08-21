// Provider portal home (ADR-0033, slice 2; nav + shell in slice 3).
//
// The signed-in landing page: provider identity, roster status, and
// (when the account came from self-serve onboarding) the
// application's decision trail. Session gating is server-side —
// no valid portal cookie means a redirect to /portal/sign-in before
// anything renders.

import { PortalShell } from "../../src/components/portal/portal-shell.js";
import { getPortalApplicationStatus } from "../../src/server/portal/application-status.js";
import { requireScopedPortalIdentity } from "../../src/server/portal/require-scoped-identity.js";

export default async function Page() {
  const identity = await requireScopedPortalIdentity();

  const application =
    identity.account.applicationId === null
      ? null
      : await getPortalApplicationStatus(identity.account.applicationId);

  const displayName = `${identity.provider.firstName} ${identity.provider.lastName}${
    identity.provider.credential === null ? "" : `, ${identity.provider.credential}`
  }`;

  return (
    <PortalShell active="home" identity={identity}>
      <section className="rounded-lg border border-line bg-surface p-6">
        <h1 className="text-xl font-semibold tracking-tight text-fg">{displayName}</h1>
        <dl className="mt-4 space-y-2 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted">NPI</dt>
            <dd className="font-mono text-fg">{identity.provider.npi}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Email</dt>
            <dd className="text-fg">{identity.account.email}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Roster status</dt>
            <dd className="text-fg">{identity.provider.status}</dd>
          </div>
        </dl>
      </section>

      {application !== null ? (
        <section className="rounded-lg border border-line bg-surface p-6">
          <h2 className="text-sm font-semibold text-fg">Onboarding application</h2>
          <dl className="mt-4 space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Status</dt>
              <dd className="text-fg">{application.status}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Submitted</dt>
              <dd className="text-fg">{application.submittedAt.toLocaleDateString("en-US")}</dd>
            </div>
            {application.decidedAt !== null ? (
              <div className="flex justify-between gap-4">
                <dt className="text-muted">Decided</dt>
                <dd className="text-fg">{application.decidedAt.toLocaleDateString("en-US")}</dd>
              </div>
            ) : null}
          </dl>
        </section>
      ) : null}
    </PortalShell>
  );
}
