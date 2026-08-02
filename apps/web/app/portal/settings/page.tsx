// Provider portal settings (ADR-0033, slice 3): password change.
// Server-gated like every signed-in portal page.

import { redirect } from "next/navigation";

import { PortalChangePasswordForm } from "../../../src/components/portal/portal-change-password-form.js";
import { PortalShell } from "../../../src/components/portal/portal-shell.js";
import { getCurrentPortalIdentity } from "../../../src/server/portal/current-session.js";

export default async function Page() {
  const identity = await getCurrentPortalIdentity();
  if (identity === null) {
    redirect("/portal/sign-in");
  }

  return (
    <PortalShell active="settings">
      <PortalChangePasswordForm />
      <p className="text-xs text-muted">
        Changing your password signs you out on every other device.
      </p>
    </PortalShell>
  );
}
