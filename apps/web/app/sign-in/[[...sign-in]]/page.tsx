// Clerk hosted sign-in surface. The `[[...sign-in]]` catch-all
// route lets Clerk render its multi-step flow (email → password →
// MFA → success) at any nested path under `/sign-in`.
//
// Public route (allowlisted in `proxy.ts`). The proxy's
// `auth.protect()` skips this path; an authenticated visitor lands
// here and Clerk's component redirects them to `redirectUrl` (the
// dashboard).

import { SignIn } from "@clerk/nextjs";

export default function Page() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-950 px-4 py-16">
      <SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" forceRedirectUrl="/" />
    </main>
  );
}
