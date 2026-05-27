# 0015 — Clerk owns authentication; Pharmax owns authorization + tenancy

- **Status:** Accepted
- **Date:** pre-2026-05
- **Deciders:** Platform team
- **Tags:** auth, identity, tenancy

## Context

Authentication for the operator console requires sign-in, MFA,
password reset, OAuth, sessions, hosted UI, and credential-stuffing
protection — a deep specialist surface, hostile to homegrowing. The
same codebase also requires fine-grained authorization: per-tenant
scope, role templates, per-permission grants, SoD (ADR 0011),
break-glass elevation, and full audit chaining (ADR 0006).

These are different problems with different correct shapes.
Authentication is a commodity; we should not run our own.
Authorization is **product-specific and safety-critical**; it belongs
in the codebase and the audit trail.

We also need a clean bridge so the operator console can dispatch
commands through the standard bus (ADR 0007) with a real Pharmax
tenancy context derived from the signed-in user — without inventing
a per-route auth surface.

## Decision

**Clerk owns authentication** (sign-in, MFA, sessions, password reset,
OAuth, hosted UI). **Pharmax owns authorization** (`@pharmax/rbac`
permissions, role templates, SoD, break-glass) **and tenancy**
(`@pharmax/tenancy` `TenancyContext`, scope resolution, audit
attribution). The only bridge between the two systems is the
**`User.clerkUserId` column** in the Pharmax database.

- Migration `20260606000000_phase5_user_clerk_id` adds
  `User.clerkUserId` (`String? @unique`, partial unique index).
  Nullable because system-only users (`shipping-webhook@*`,
  `print-agent@*`) never sign in.
- `apps/web` wires `@clerk/nextjs`: `ClerkProvider dynamic`, plus
  `proxy.ts` running `clerkMiddleware` with a `createRouteMatcher`
  allowlist for `/api/health`, `/api/webhooks/(.*)`, `/sign-in(.*)`,
  `/sign-up(.*)` — webhook routes stay public because **signatures
  are the auth**. Everything else gates through `auth.protect()`.
- Hosted sign-in / sign-up at `/sign-in/[[...sign-in]]` and
  `/sign-up/[[...sign-up]]` use Clerk's built-in components — zero
  custom UI.
- **The bridge primitive** is `resolveOperatorTenancyContext()` in
  `apps/web/src/server/auth/resolve-tenancy.ts`. It calls Clerk's
  `auth()`, takes the Clerk `userId`, looks up the Pharmax `User` by
  `clerkUserId` in **system context**, and builds the standard
  `TenancyContext` with a fresh `correlationId` per request. The
  output is the shape the command bus already understands.
- Three failure paths surface as typed reasons
  (`RESOLVE_TENANCY_NO_SESSION`, `RESOLVE_TENANCY_USER_NOT_LINKED`,
  `RESOLVE_TENANCY_USER_NOT_ACTIVE`) so the UI renders an actionable
  "contact your admin" message instead of crashing.
- ESLint **Override 3c** allowlists `apps/web/src/server/auth/**` for
  `withSystemContext` — same shape as Override 3b (worker drains in
  ADR 0009).

## Consequences

**Easier:**

- We do not maintain auth UI, MFA, password flows, OAuth, or
  session storage. Clerk is the source of truth for "is this a
  real human and which Clerk user are they?".
- Pharmax stays the source of truth for "what can this human do in
  this organization?". Every permission grant, role template, audit
  chain entry, and SoD rule lives in the Pharmax database.
- Operators are pre-provisioned via `bootstrap-org`; the
  `User.clerkUserId` column is set at provisioning time and the
  user signs in normally.

**Harder:**

- A new sign-in must match an existing Pharmax `User` row by
  `clerkUserId`. If the row does not exist, the bridge surfaces
  `RESOLVE_TENANCY_USER_NOT_LINKED` and the operator sees "contact
  your admin". A future `user.created` Clerk webhook handler will
  auto-link new sign-ins to a pre-staged Pharmax row.
- Two systems mean two failure surfaces. Clerk outages block sign-in
  but not API or worker activity. Pharmax DB outages block the
  bridge.
- Production hardening (disable `/sign-up` for non-admin emails,
  force MFA for `BillingManager` + `OrgAdmin`) is a tightening pass
  that lives outside this ADR.

**Ongoing obligations:**

- `User.clerkUserId` stays nullable forever — system users (webhook
  services, agents) never have one.
- Every operator API route resolves tenancy via
  `resolveOperatorTenancyContext()` and dispatches through the
  command bus. Direct DB writes from route handlers are a review
  red flag.

## Alternatives Considered

- **Homegrown auth.** Wastes engineering on a commodity surface;
  loses MFA / password-reset / OAuth maturity; expands the
  compliance footprint.
- **Auth0 or AWS Cognito instead of Clerk.** Functionally
  equivalent for the bridge pattern; Clerk's Next.js integration
  (Keyless mode for dev, server-component-friendly `auth()`) is the
  best fit for the existing app stack.
- **Bake Pharmax users inside Clerk's metadata.** Couples
  authorization to the auth vendor, blocks ports/adapters style
  vendor swap, and pulls SoD / audit chaining into Clerk's blast
  radius. Reject.

## References

- ADR 0006 — Hash-chained audit log
- ADR 0007 — Twenty-step command-bus contract
- ADR 0011 — Separation of Duties at the command bus
- `prisma/migrations/20260606000000_phase5_user_clerk_id/`
- `apps/web/proxy.ts`
- `apps/web/src/server/auth/resolve-tenancy.ts`
- `eslint.config.js` — Override 3c (apps/web/src/server/auth allowlist)
