// Provider portal sign-in surface (ADR-0033, slice 2).
//
// The org is resolved from the request subdomain by the portal
// sign-in API route; this page just renders the email/password form.
// Public route (allowlisted in proxy.ts). If a valid portal session
// already exists, skip straight to the portal home.

import { redirect } from "next/navigation";

import { PortalSignInForm } from "../../../src/components/portal/portal-sign-in-form.js";
import { AuthShell } from "../../../src/components/shell/auth-shell.js";
import { getCurrentPortalIdentity } from "../../../src/server/portal/current-session.js";

export default async function Page() {
  const identity = await getCurrentPortalIdentity();
  if (identity !== null) {
    redirect("/portal");
  }
  return (
    <AuthShell
      title="Provider portal"
      subtitle="Sign in with the account from your onboarding approval email."
    >
      <PortalSignInForm />
    </AuthShell>
  );
}
