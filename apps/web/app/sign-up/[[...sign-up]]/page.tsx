// Sign-up surface (ADR-0030).
//
// Pharmax operator accounts are invitation-only — there is no public
// self-service sign-up. Operators are pre-provisioned server-side
// (InviteUser) and complete enrollment through an invitation link
// (accept-invite flow, wired in the lifecycle slice). This page renders
// a static "invitation-only" surface with a support contact.
//
// Public route (allowlisted in proxy.ts); proxy also 404s a closed
// `/sign-up` in production as defence-in-depth.

import { env } from "@/server/env";

import { AuthShell } from "../../../src/components/shell/auth-shell.js";
import { buttonClass } from "../../../src/components/ui/button.js";

export default function Page() {
  const supportEmail = env.SUPPORT_EMAIL ?? "";
  return (
    <AuthShell
      title="Sign-up is closed"
      subtitle="Pharmax operator accounts are invitation-only."
      footer={
        <a className="text-brand underline-offset-4 hover:underline" href="/sign-in">
          Return to sign in
        </a>
      }
    >
      <div className="w-full space-y-3 rounded-lg border border-line bg-surface p-6 text-sm text-muted">
        <p>
          If you have an invitation email, follow the link in that email to complete your account
          setup. Otherwise, contact your administrator to be provisioned.
        </p>
        {supportEmail.length > 0 && (
          <a
            href={`mailto:${supportEmail}`}
            className={buttonClass({ variant: "secondary", size: "sm", className: "w-full" })}
          >
            Contact your administrator
          </a>
        )}
      </div>
    </AuthShell>
  );
}
