// Provider portal account-setup surface (ADR-0033, slice 2).
//
// Landing page for the emailed one-time link
// (`/portal/setup?token=…`). The token is never validated here — the
// setup API route is the single validator, and it answers every
// not-consumable case with one opaque error. A missing token just
// renders guidance instead of a form.

import { PortalSetupForm } from "../../../src/components/portal/portal-setup-form.js";
import { AuthShell } from "../../../src/components/shell/auth-shell.js";

export default async function Page({
  searchParams,
}: {
  readonly searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  return (
    <AuthShell
      title="Activate your portal account"
      subtitle="Choose a password to finish setting up your provider portal access."
    >
      {typeof token === "string" && token.length > 0 ? (
        <PortalSetupForm token={token} />
      ) : (
        <p className="text-sm text-muted">
          This setup link is incomplete. Open the link from your approval email again, or contact
          the pharmacy that invited you.
        </p>
      )}
    </AuthShell>
  );
}
