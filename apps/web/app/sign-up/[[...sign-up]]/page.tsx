// Clerk hosted sign-up surface — gated by environment.
//
// In production pharmacy operations, end-users do NOT self-sign-up.
// Operators are pre-provisioned server-side via the `bootstrap-org`
// CLI + Clerk Backend API, then receive an invite email that drives
// them through Clerk's invitation flow (which uses /sign-up only with
// a signed `__clerk_ticket` parameter — Clerk handles that path
// inside the `<SignUp>` component when present, so invitations still
// work even when this page disables the open-form variant).
//
// Behavior:
//
//   - NODE_ENV !== "production"          ⇒ render the standard <SignUp/>
//     form. Lets developers spin up tenants end-to-end without going
//     through the CLI.
//
//   - NODE_ENV === "production"          ⇒ render a static
//     "contact your admin" surface unless the request carries the
//     Clerk invitation token (`?__clerk_ticket=...`). When the token
//     is present, we still render <SignUp/> so the invitation flow
//     completes; without it, self-service sign-up is closed.
//
// Why we don't just remove the route: Clerk's invitation emails
// link to `/sign-up?__clerk_ticket=<jwt>`. Removing the route would
// break the only legitimate path for operators to enroll. Gating on
// the token preserves that path while denying the open form.

import { SignUp } from "@clerk/nextjs";

import { env } from "@/server/env";

import { AuthShell, clerkAppearance } from "../../../src/components/shell/auth-shell.js";
import { buttonClass } from "../../../src/components/ui/button.js";

import { resolveSignUpSurface } from "./resolve-surface";

interface PageProps {
  // Next 16 routing — searchParams is async.
  readonly searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function Page({ searchParams }: PageProps) {
  const sp = searchParams ? await searchParams : {};
  const ticket = typeof sp.__clerk_ticket === "string" ? sp.__clerk_ticket : null;

  const surface = resolveSignUpSurface({
    nodeEnv: env.NODE_ENV,
    signupsEnabled: env.CLERK_SIGNUPS_ENABLED,
    invitationTicket: ticket,
  });

  if (surface === "closed") {
    // SUPPORT_EMAIL is required in production by the bootstrap gate
    // (`bootstrap.ts → enforceClerkProductionConfig`). The empty-string
    // fallback below should never trigger in a real deployment; it's
    // belt-and-braces for non-prod renders that hit this branch via a
    // forced env (e.g. `NODE_ENV=production pnpm dev`).
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
            If you have an invitation email, follow the link in that email — it will bring you here
            with the right credentials.
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

  return (
    <AuthShell title="Create your account" subtitle="Complete your Pharmax operator enrollment.">
      <SignUp
        routing="path"
        path="/sign-up"
        signInUrl="/sign-in"
        forceRedirectUrl="/ops"
        appearance={clerkAppearance}
      />
    </AuthShell>
  );
}
