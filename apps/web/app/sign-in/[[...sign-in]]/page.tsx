// Sign-in surface (ADR-0030, in-house identity engine).
//
// The org is resolved from the request subdomain by the sign-in API
// route; this page just renders the email/password (+ MFA) form. Public
// route (allowlisted in proxy.ts).

import { SignInForm } from "../../../src/components/auth/sign-in-form.js";
import { AuthShell } from "../../../src/components/shell/auth-shell.js";

export default function Page() {
  return (
    <AuthShell title="Welcome back" subtitle="Sign in to the Pharmax operations console.">
      <SignInForm />
    </AuthShell>
  );
}
