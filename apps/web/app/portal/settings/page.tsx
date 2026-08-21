// Provider portal settings (ADR-0033, slice 3): password change.
// Server-gated like every signed-in portal page.

import { PortalChangePasswordForm } from "../../../src/components/portal/portal-change-password-form.js";
import { PortalShell } from "../../../src/components/portal/portal-shell.js";
import { requireScopedPortalIdentity } from "../../../src/server/portal/require-scoped-identity.js";

export default async function Page() {
  const identity = await requireScopedPortalIdentity();

  return (
    <PortalShell active="settings" identity={identity}>
      <PortalChangePasswordForm />
      <p className="text-xs text-muted">
        Changing your password signs you out on every other device.
      </p>
    </PortalShell>
  );
}
