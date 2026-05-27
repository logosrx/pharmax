// Pure helper that decides which sign-up surface to render.
//
// Extracted from `page.tsx` so it can be unit-tested without
// pulling in Clerk's <SignUp> component (which depends on a real
// React Server Component runtime + the Clerk SDK).
//
// Three inputs, evaluated in this order:
//
//   1. `nodeEnv` — `development` / `test` ⇒ ALWAYS open. Contributors
//      need to spin tenants up end-to-end without provisioning a
//      Clerk invitation each time.
//
//   2. `invitationTicket` — when a non-empty `__clerk_ticket` query
//      parameter is present, the surface is open regardless of the
//      `signupsEnabled` flag. Clerk's invitation emails link to
//      `/sign-up?__clerk_ticket=<jwt>`; that path MUST stay
//      functional or pre-staged operators cannot complete enrollment.
//
//   3. `signupsEnabled` — environment opt-in flag
//      (`CLERK_SIGNUPS_ENABLED`). Defaults to `false`; production
//      environments turn it on explicitly when they want a public
//      sign-up surface. Anything else falls through to "closed".
//
// PHI invariant: this helper never reads patient or operator data;
// the inputs are environment / query metadata only.

import "server-only";

export type SignUpSurface = "open" | "closed";

export interface ResolveSignUpSurfaceInput {
  /** Process NODE_ENV at render time. */
  readonly nodeEnv: "development" | "test" | "production";
  /**
   * Environment opt-in flag. Defaults to `false` at the schema
   * level so a missed env var keeps the surface closed.
   */
  readonly signupsEnabled: boolean;
  /**
   * The `__clerk_ticket` query parameter when present, or `null`.
   * Empty strings count as absent (would never satisfy Clerk's
   * own validation downstream).
   */
  readonly invitationTicket: string | null;
}

export function resolveSignUpSurface(input: ResolveSignUpSurfaceInput): SignUpSurface {
  if (input.nodeEnv !== "production") return "open";
  if (typeof input.invitationTicket === "string" && input.invitationTicket.length > 0) {
    return "open";
  }
  if (input.signupsEnabled) return "open";
  return "closed";
}
