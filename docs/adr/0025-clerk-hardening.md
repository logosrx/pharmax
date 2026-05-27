# 0025 — Clerk hardening: webhooks, sign-up gating, MFA floor

- **Status:** Accepted
- **Date:** 2026-05-25
- **Deciders:** Platform team, Security officer
- **Tags:** `security`, `compliance`, `authentication`, `clerk`

## Context

ADR-0015 sets the split: Clerk owns identity (sign-in, sessions, MFA
enrollment, password reset, social/SSO); Pharmax owns authorization
(RBAC, tenancy, command-bus checks). That split assumed three things
the codebase did not yet enforce:

1. **Lifecycle sync.** When Clerk creates a user (from an invitation),
   Pharmax's `user` row needs to flip from `INVITED` to `ACTIVE` and
   pick up the `clerkUserId`. When Clerk deletes a user, Pharmax must
   stop honouring that identity. Without a webhook, this happened
   lazily at first sign-in via `tryAutoLinkClerkIdentity` — which is
   fine for the common case but leaves termination as a manual step.
2. **Sign-up surface.** `/sign-up` rendered Clerk's open form in every
   environment. In a HIPAA-eligible production deployment, an open
   sign-up form is a credential-spray vector; even when no Pharmax
   `user` row links to the new Clerk identity (so the operator can't
   do anything), the form itself is a noisy attack surface.
3. **MFA floor.** Clerk supports MFA, but enforcement was deferred to
   the Clerk dashboard org policy. SOC 2 CC6.1 and HIPAA
   § 164.308(a)(5)(ii)(D) both call out a second factor for accounts
   that can read or change PHI or financial data. We want the
   platform itself to refuse access for those roles, independent of
   what the customer's Clerk policy says.

## Decision

Three concrete changes, all of them server-side.

### 1. `POST /api/webhooks/clerk` — Svix-verified lifecycle handler

A new route at `apps/web/app/api/webhooks/clerk/route.ts`:

- Reads the raw request body (Svix signs raw bytes).
- Verifies the `svix-id` / `svix-timestamp` / `svix-signature`
  headers against `CLERK_WEBHOOK_SECRET` using `svix.Webhook`.
- 503s when the secret is unset (dev / mis-configured prod).
- Hands the parsed event to a dispatcher in
  `apps/web/src/server/auth/clerk-webhook-handlers.ts`.

The dispatcher handles four event types:

- `user.created` — looks up a matching `INVITED` `user` row by
  primary email (case-normalised). If exactly one match exists and
  it is not already linked to a different Clerk id, link
  `clerkUserId` and flip to `ACTIVE`. Otherwise no-op.
- `user.updated` — syncs primary email + display name onto the
  row keyed by `clerkUserId`. Never creates a row.
- `user.deleted` — flips the linked row to `TERMINATED` and
  clears `clerkUserId`. We never delete the row — the audit log
  references it for retention.
- `session.created` — logs a structured audit signal. No mutation.

All handlers run inside `withSystemContext` (cross-tenant lookup
allowed for a webhook with no tenant in scope) and are
**idempotent** by construction: link/sync/terminate are guarded
updates. Clerk retries on 5xx; the same delivery twice doesn't
double-apply.

### 2. Production sign-up gate

`apps/web/app/sign-up/[[...sign-up]]/page.tsx` now renders one of
two surfaces:

- **dev / test:** the existing Clerk `<SignUp>` form. Lets contributors
  spin tenants up end-to-end.
- **production:** a static "sign-up is closed; contact your admin"
  page UNLESS the request carries a Clerk invitation token
  (`?__clerk_ticket=...`). When the token is present the standard
  `<SignUp>` form renders so the invitation flow completes.

We do not remove the route — Clerk's invitation emails point at
`/sign-up?__clerk_ticket=...` and that's the only sanctioned path
for new operators to enroll. Gating on the token preserves that
path while closing the open form.

The `proxy.ts` public-route allowlist still includes `/sign-up(.*)`
so unauthenticated visitors can see the message.

### 3. MFA floor at the application layer

`apps/web/src/server/auth/require-mfa.ts` exports:

- `MFA_REQUIRED_ROLE_CODES = { "OrgAdmin", "BillingManager" }`.
  Other built-in roles (Pharmacist, PharmacyTechnician,
  ShippingClerk, ClinicViewer, WebhookService) are NOT on the
  floor — they should still enable MFA, and customer admins can
  require it via Clerk's org policy, but the platform itself does
  not refuse them.
- `requireOperatorMfa({ clerkUserId, roleCodes })` returns one of
  four outcomes:
  - `mfa_not_required` — no enforcing role present.
  - `mfa_satisfied` — Clerk reports ≥ 1 enrolled factor.
  - `mfa_required_not_enrolled` — caller must redirect to
    enrollment or return 403 with a structured error.
  - `mfa_lookup_failed` — Clerk Backend API unreachable. Caller
    decides whether to fail open or closed; the recommendation
    is fail-closed for write paths, fail-open for read paths
    (this is operational, not adversarial).

The gate is **opt-in at the call site**, not in `proxy.ts`. Most
operator pages do not need MFA, so checking on every request
would be wasted Clerk Backend API calls (and a noisy dependency
on Clerk's availability for unrelated read paths). The
recommended placement is inside any API route or server action
that mutates billing or org-admin state.

## Consequences

### Easier

- Operator off-boarding becomes a single Clerk dashboard action.
  Clerk fires `user.deleted` → Pharmax flips status to
  `TERMINATED` → the next request from any stale session is
  rejected at `resolveOperatorTenancyContext` because the user
  row is no longer `ACTIVE`.
- Production sign-up is no longer an open form. Credential-spray
  attempts hit a static "contact your admin" page instead of
  Clerk's API.
- The platform owns the MFA floor for privileged roles. Customer
  admins can still tighten further via Clerk policy, but cannot
  loosen below the floor.

### Harder

- Production deployments now have a **new required secret**
  (`CLERK_WEBHOOK_SECRET`). The Terraform lane sets this via
  Secrets Manager; the runbook needs to call it out explicitly so
  a missed env var doesn't silently break lifecycle sync.
- MFA enforcement adds a Clerk Backend API roundtrip on
  privileged-write paths. The cost is one HTTP call per request
  per MFA-required role; for typical billing / admin throughput
  this is negligible, but very high-volume admin endpoints should
  cache the snapshot per-request.

## Ongoing obligations

- The Clerk dashboard for the production instance MUST be
  configured to deliver `user.created`, `user.updated`,
  `user.deleted`, and `session.created` to
  `https://<app-host>/api/webhooks/clerk`.
- `CLERK_WEBHOOK_SECRET` MUST be rotated whenever the Clerk
  dashboard secret is rotated — both values must stay in sync or
  every webhook delivery returns 400.
- The MFA gate set is canonicalised in code. Adding a new role to
  the floor requires editing `require-mfa.ts` and the corresponding
  test, AND noting the change in `SECURITY.md` (forthcoming via the
  CI hardening lane).

## Failure modes

- **Clerk webhook secret leaks.** An attacker can forge events
  and (e.g.) trigger spurious `user.deleted` to lock real
  operators out. Mitigation: the secret is in Secrets Manager,
  not in env files; rotation is a one-step Clerk dashboard
  action; webhook deliveries are observable in CloudWatch (
  forthcoming via the OTel lane) so anomalous spikes surface.
- **Clerk Backend API outage during MFA lookup.** Falls into
  `mfa_lookup_failed`. Today every caller fails closed. If
  Clerk's availability becomes a recurring problem we add a
  short-TTL cache of `(clerkUserId, factorCount)` keyed on the
  Clerk session; ADR-0015's "Clerk owns identity" boundary
  prevents us from caching anything more.
- **`session.created` audit gap.** We emit a log line but do not
  yet correlate to a user-row activity event. The break-glass
  audit work in the Tier 3 ops lane closes that gap by writing
  a structured `audit_log` row per session creation.

## Alternatives considered

- **Clerk's `verifyWebhook` helper from `@clerk/backend`.**
  Equivalent to using `svix` directly. We chose `svix` so the
  signing-scheme dependency is explicit and decoupled from
  Clerk SDK version churn.
- **Auto-link on first sign-in only (no webhook).** This is the
  shape we had. Works for `user.created`, but offers no signal
  for `user.deleted`. The webhook is the only place to learn
  that an operator was off-boarded; without it, termination is a
  manual operator workflow that's easy to miss.
- **MFA enforced in `proxy.ts` for every authenticated route.**
  Cheaper to reason about, but wastes Clerk Backend API calls on
  read paths that do not require MFA. We chose call-site
  enforcement to keep the cost proportional to the privilege
  being exercised.

## Implementation notes

The following files implement the design above. Listed here as a
"what landed" pointer for reviewers; the design itself above is
the authoritative description.

### 1. Webhook receiver

- `apps/web/app/api/webhooks/clerk/route.ts` — transport layer
  (Svix signature verification, `clerk_webhook_event` ledger
  insert with `svixMessageId`-unique idempotency, PENDING-row
  retry recovery, dispatch + ledger-finalize). 503 on unset
  secret, 400 on missing headers / bad signature / bad payload
  shape, 200 on applied / noop / replay, 500 on dispatcher
  failure (Svix retries).
- `apps/web/app/api/webhooks/clerk/route.test.ts` — happy path,
  bad signature, missing-header matrix, P2002 replay
  (APPLIED / PENDING / race-not-found), dispatcher-throws
  failure shape, unknown-event-type 200, raw-body verification
  invariant.
- `apps/web/src/server/auth/clerk-webhook-handlers.ts` —
  dispatcher with per-event branches: `user.created`,
  `user.updated`, `user.deleted`, `session.created`. Each branch
  is structurally idempotent (guarded updates) and audited via
  `writeAuditLogInTx`. Cross-tenant reads use `withSystemContext`
  per ESLint Override 3c.
- `apps/web/src/server/auth/clerk-webhook-handlers.test.ts` —
  per-event-type contract suite (link / refused-relink /
  multi-match noop / TERMINATED idempotency / session signal /
  unknown event).

### 2. Production sign-up gate

- `apps/web/src/server/env.ts` — adds `CLERK_SIGNUPS_ENABLED`
  (defaults `false`; case- and whitespace-normalized; only
  `"true"` / `"1"` open the surface). The Clerk + support-email
  vars stay required-in-prod via the bootstrap gate below.
- `apps/web/src/server/bootstrap.ts` — `enforceClerkProductionConfig`
  hard-fails boot when production is missing
  `CLERK_SECRET_KEY` / `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` /
  `CLERK_WEBHOOK_SECRET` / `SUPPORT_EMAIL`.
- `apps/web/app/sign-up/[[...sign-up]]/page.tsx` — RSC entry;
  delegates to the pure resolver below.
- `apps/web/app/sign-up/[[...sign-up]]/resolve-surface.ts` — pure
  `(nodeEnv, signupsEnabled, invitationTicket) → "open" | "closed"`
  helper. Dev/test always open; production opens with a Clerk
  invitation ticket OR when the env flag is true.
- `apps/web/app/sign-up/[[...sign-up]]/resolve-surface.test.ts` —
  full truth-table coverage.
- `apps/web/proxy.ts` — middleware defence-in-depth: returns
  `404` on `/sign-up` when `shouldDenySignUpInMiddleware` says
  the surface is closed (no ticket, flag not truthy, prod). The
  rule is re-implemented locally (not imported) so a bug in the
  page-tier resolver does not also open the middleware.
- `apps/web/proxy.test.ts` — full truth-table on the
  middleware-tier decision (case/whitespace normalization,
  unrecognised values fail closed, ticket bypass).

### 3. MFA floor

- `apps/web/src/server/auth/require-mfa.ts` —
  `MFA_REQUIRED_ROLE_CODES = { "OrgAdmin", "BillingManager" }`.
  `requireOperatorMfa` returns one of four typed outcomes;
  `enforceMfaForCommand` is the throw-on-denial wrapper used by
  privileged-write routes. Per-request memoization via
  `React.cache` so the same render does not double-call the
  Clerk Backend API.
- `apps/web/src/server/auth/require-mfa.test.ts` — every
  outcome branch + case-sensitivity invariants on the role-code
  set.
- `apps/web/src/server/auth/dispatch-ops-with-mfa.ts` — wraps
  `dispatchOpsCommand`; resolves tenancy, loads role codes via
  `load-operator-role-codes.ts`, calls `enforceMfaForCommand`
  BEFORE bus dispatch, redirects with a structured error code
  on denial. Use this in any operator route that mutates
  billing or org-admin state.
- `apps/web/src/server/auth/load-operator-role-codes.ts` — cheap
  2-table read (`user_role` ⋈ `role`) returning the operator's
  role codes; runs in system context because the call site
  precedes the per-request tenancy frame.

### Operational dependencies

- Production deployments must set `CLERK_WEBHOOK_SECRET` to the
  signing secret from the Clerk dashboard's webhook endpoint.
  Rotating the secret is a one-step dashboard action; both
  values must stay in sync or every delivery returns 400.
- Production deployments that want a public sign-up form set
  `CLERK_SIGNUPS_ENABLED=true`. Default is closed.
- See `docs/RUNBOOK.md → "Rotating CLERK_WEBHOOK_SECRET"` for
  the runbook procedure.
