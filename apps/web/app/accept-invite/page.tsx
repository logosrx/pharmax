// Accept-invite surface (ADR-0030). Reached via the invitation link
// (`/accept-invite?token=...`). Public route (allowlisted in proxy.ts).
// The token authorizes setting the initial password; org/user are
// resolved server-side from the token, so no subdomain is required.

import { AcceptInviteForm } from "../../src/components/auth/accept-invite-form.js";
import { AuthShell } from "../../src/components/shell/auth-shell.js";

interface PageProps {
  readonly searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function Page({ searchParams }: PageProps) {
  const sp = searchParams ? await searchParams : {};
  const token = typeof sp.token === "string" ? sp.token : "";
  return (
    <AuthShell
      title="Set your password"
      subtitle="Finish setting up your Pharmax operator account."
    >
      <AcceptInviteForm token={token} />
    </AuthShell>
  );
}
