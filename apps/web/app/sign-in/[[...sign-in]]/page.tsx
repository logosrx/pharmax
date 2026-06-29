// Clerk hosted sign-in surface. The `[[...sign-in]]` catch-all route
// lets Clerk render its multi-step flow (email → password → MFA →
// success) at any nested path under `/sign-in`.
//
// Public route (allowlisted in `proxy.ts`). An authenticated visitor
// landing here is redirected by Clerk to `forceRedirectUrl`.

import { SignIn } from "@clerk/nextjs";

import { AuthShell, clerkAppearance } from "../../../src/components/shell/auth-shell.js";

export default function Page() {
  return (
    <AuthShell title="Welcome back" subtitle="Sign in to the Pharmax operations console.">
      <SignIn
        routing="path"
        path="/sign-in"
        signUpUrl="/sign-up"
        forceRedirectUrl="/ops"
        appearance={clerkAppearance}
      />
    </AuthShell>
  );
}
