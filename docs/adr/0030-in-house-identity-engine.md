# 0030 — In-house identity engine replaces Clerk; keep the authN/authZ split

- **Status:** Accepted
- **Date:** 2026-07-10
- **Deciders:** Platform team, Security officer
- **Tags:** `security`, `compliance`, `authentication`, `identity`, `tenancy`

## Context

ADR-0015 split identity cleanly: **Clerk owns authentication**
(sign-in, MFA, sessions, password reset, OAuth, hosted UI) and
**Pharmax owns authorization + tenancy** (`@pharmax/rbac`,
`@pharmax/tenancy`, the command bus, hash-chained audit). ADR-0025
hardened that boundary (Svix webhooks, sign-up gating, an
application-layer MFA floor). The split itself was correct and is
**retained**. What changes here is _who_ implements the
authentication half.

Forces in play:

- **Cost / control.** Clerk's per-MAU pricing and vendor coupling
  are acceptable for a bounded operator population but leave us
  without control over the identity surface as we scale toward
  patient-facing enrollment. The team has decided to own this
  surface end to end.
- **The schema was pre-wired for it.** `User` already carries
  `hashedPassword`, `mfaEnrolled`, and `lastLoginAt`
  (`prisma/schema.prisma`). Clerk was bridged only through the
  nullable, unique `User.clerkUserId` column. The blast radius of
  removing Clerk is therefore a single, well-tested seam:
  `apps/web/src/server/auth/resolve-tenancy.ts`.
- **We already own the hard primitives.** `@pharmax/crypto` provides
  AWS-KMS envelope encryption, blind indexing, HMAC, and
  timing-safe comparison. `@pharmax/rbac`, `@pharmax/tenancy`
  (RLS + session GUC), the command bus (idempotency, SoD, audit,
  outbox), and `@pharmax/cache` (Redis) are all in place. An
  in-house engine _composes_ these rather than reinventing security
  primitives.
- **The cautionary example is on file.** The prior evaluation of the
  eonpro custom auth stack surfaced concrete anti-patterns —
  authentication logic fused into a 1,300-line route, two divergent
  session systems, a JWT revocation gap, MFA defined but not
  enforced in the login path. This ADR's design exists specifically
  to _not_ repeat those.

We take on this decision knowing it **expands our own SOC 2 / HIPAA
control surface**: we now evidence password storage, session
management, MFA, lockout, and account recovery ourselves rather than
inheriting a vendor's controls. That obligation is accepted
deliberately and is the reason the design must be audit-clean from
the first commit, not retrofitted.

## Decision

**Replace Clerk with an in-house identity engine, `@pharmax/auth`,
that owns authentication only. Authorization and tenancy stay exactly
where they are.** Authentication state changes are modeled as
commands on the existing bus so that `command_log`, `audit_log`, and
`event_outbox` are written by the same centralized contract as every
other critical mutation.

This commits us to the following, each expanded in the referenced
implementation items:

- **Stateful, opaque sessions — never stateless JWT for the session
  itself.** A session is a 256-bit random token delivered in an
  `httpOnly` / `Secure` / `SameSite=Lax` cookie. Only the SHA-256
  hash of the token is stored. Postgres is the source of truth;
  Redis (`@pharmax/cache`) is a read-through cache. Every request
  resolves the session server-side, so **revocation is immediate** —
  the specific failure the eonpro JWT path could not achieve. Idle
  timeout and an absolute cap are enforced on every resolve.
- **Argon2id password hashing** (`@node-rs/argon2`, prebuilt — no
  native toolchain) with tuned memory/time parameters and a
  process-wide **pepper unwrapped via the KMS adapter** at boot.
  Password strength policy, a breach-list check, and a
  `password_history` anti-reuse window are enforced at the command
  boundary, not the route.
- **MFA: TOTP (RFC 6238) + single-use recovery codes** in v1, with a
  WebAuthn/passkey adapter deferred behind the same interface. TOTP
  secrets are sealed with `@pharmax/crypto` envelope encryption;
  recovery codes are stored only as Argon2id hashes. The
  application-layer MFA floor for privileged roles from ADR-0025 is
  preserved and enforced inside the `SignIn` / step-up flow, not in
  middleware.
- **Auth commands on the bus.** `SignIn`, `SignOut`, `EnrollMfa`,
  `VerifyMfa`, `ChangePassword`, `RequestPasswordReset`,
  `ResetPassword`, and `RevokeSessions`. Pre-tenant commands
  (sign-in, reset) run as `SystemCommand`s (the same shape webhooks
  use), resolving the target organization before writing audit rows.
- **The bridge swap is the only change downstream sees.**
  `resolveOperatorTenancyContext()` swaps its `clerk auth()` call for
  `resolveSession(cookie)` and maps a session → `User.id` directly;
  `proxy.ts` gates on the session cookie instead of
  `clerkMiddleware`. The command bus, RBAC, SoD, tenancy, and every
  domain package (orders, fill, verification, shipping) are
  **untouched**.
- **No secrets in code or client-exposed env.** The password pepper
  and any signing material are KMS-managed and rotation-ready per
  ADR-0028; session token hashing uses SHA-256 with no stored
  secret.
- **Scope v1 is operators only**, mirroring the current Clerk usage.
  A patient-facing authentication surface, if built, is a separately
  scoped effort behind the same engine.

**ADR-0015 and ADR-0025 are superseded by this ADR** for the
authentication half. Their authZ/tenancy conclusions survive here
verbatim.

## Consequences

**Easier:**

- Immediate, complete session revocation (log-out-everywhere,
  on-termination) because sessions are server-side state, not
  self-validating tokens.
- No per-MAU cost and no vendor availability dependency on the
  sign-in path.
- Authentication events flow through the same audit + outbox
  contract as everything else — a `SignIn` failure or an `EnrollMfa`
  is a `command_log` + `audit_log` row by construction, so the
  compliance evidence is uniform.
- One vendor removed from the BAA tracker and vendor inventory.

**Harder / more expensive:**

- **We now own the full authentication control surface** for SOC 2
  CC6.x and HIPAA §164.308/312: password storage, session lifecycle,
  MFA, lockout, and account recovery are ours to implement, test,
  pen-test, and evidence — permanently.
- Account-recovery flows (the most common real-world account-takeover
  vector) must be designed defensively; there is no vendor to absorb
  that risk.
- Session-store availability becomes a sign-in and per-request
  dependency; Postgres is authoritative with a Redis cache, so a
  Redis outage degrades to a DB read rather than a hard failure.

**Ongoing obligations:**

- Every authentication state change goes through a bus command. A
  route handler that reads a password hash, mints a session, or
  mutates MFA state directly is a review red flag — the same rule
  the domain already lives by.
- Argon2id parameters, the pepper, and any signing keys are subject
  to the rotation policy in ADR-0028 and the key inventory in
  `docs/security/kms-key-inventory.md`.
- The `password_history` window, TOTP window, lockout thresholds,
  and session TTLs are canonicalized in `@pharmax/auth` config with
  tests; changing them requires updating `SECURITY.md`.

**Failure modes and detection:**

- **Session store compromise.** Only token _hashes_ are stored, so a
  read of the table does not yield usable tokens. Anomalous session
  creation rates surface via the security digest.
- **Pepper unavailable at boot.** `configureAuth` fails closed (same
  posture as `configureCrypto`), so the app refuses to start rather
  than hashing without the pepper.
- **Recovery-flow abuse.** Reset requests are rate-limited and
  audited; a spike is a detectable signal, not a silent event.

## Amendment 2026-08-18 — rate-limiter availability posture

**This section records a posture the ADR never stated.**
`packages/composition/src/rate-limit/ioredis-rate-limiter.ts` attributed
its fail-open behaviour to "ADR-0030", but no such decision appears above:
the ADR's only availability reasoning concerns the read-through cache
degrading to a DB read. The code cited a decision that existed nowhere,
which is how it went unreviewed for two months. Stating it here makes the
citation true and the posture reviewable.

**Decision.** Sign-in rate limiting **degrades, it does not disable**. On
a Redis transport error the limiter delegates to a process-local
`InMemoryRateLimiter` rather than returning `allowed: true`.

**Why the original fail-open was half right.** Its stated reason — a Redis
outage must not lock every operator out, and the durable per-email lockout
in `login_attempt` is the backstop for sustained attacks — is sound, and
the backstop is real: `countRecentFailedAttempts` is a Postgres query with
no Redis dependency.

But `signIn` enforces **two** keys, `signin:ip:<ip>` and
`signin:email:<email>`, and the DB lockout replaces only the email half
because it counts failures per email. With Redis down and a blanket allow,
per-IP throttling vanished. Single-account brute force stayed bounded;
what became free was **credential spraying and user enumeration** from one
source across many accounts. Same exposure on the provider-portal sign-in
and credential-setup paths.

**Trade-off accepted.** Process-local counting is weaker than the
distributed limiter — each web task counts independently, so the effective
limit multiplies by instance count — and strictly stronger than nothing.
It preserves the property this ADR actually cares about: no global lockout
when Redis is unavailable. The fallback is bounded by `maxKeys` with a
sweep, so a spray across many keys cannot turn a Redis outage into memory
exhaustion.

**Residual risk.** An attacker who can both take Redis down and distribute
across many source IPs still gets more attempts than the distributed
limiter would permit. Closing that needs the limit enforced somewhere
authoritative — a per-IP ledger in Postgres alongside `login_attempt`, or
throttling at the edge (WAF rate rules) rather than in the application.
Neither is in scope here; both are better answers than a larger in-memory
cap.

## Alternatives Considered

- **Stay on Clerk (ADR-0015 status quo).** Lowest engineering cost
  and best inherited compliance posture; rejected by explicit team
  decision to own cost and control of the identity surface.
- **Self-host an open-source IdP (Keycloak / Zitadel / Ory).**
  Delivers cost/control without writing auth primitives and remains
  a documented contingency. Rejected for v1 because it still
  introduces a separate service to operate and an OIDC round-trip,
  where the engine composes primitives we already own behind a
  single in-process seam. Revisit if patient-scale MAU or SSO/SAML
  demand arrives.
- **Stateless JWT sessions.** Cheaper per request; rejected because
  it reintroduces the exact revocation gap seen in the eonpro
  evaluation. We use short-lived signed artifacts only for
  transient, single-purpose tokens (e.g. password-reset links),
  never for the session itself.
- **Lift-and-shift the eonpro auth code.** Rejected: it fuses
  authN/authZ/tenancy, is route-heavy (contrary to the thin-route
  rule), and carries the gaps documented in its evaluation. We
  harvest its _patterns_ (Redis-backed sessions with revocation,
  durable lockout, login-audit model, TOTP) and re-implement them
  behind the command bus and tenancy boundary.

## References

- Superseded: `0015-clerk-authentication-pharmax-authorization.md`,
  `0025-clerk-hardening.md`
- Companion: `0006` (hash-chained audit), `0007` (command-bus
  contract), `0011` (Separation of Duties), `0028` (KMS key rotation)
- Code (bridge seam): `apps/web/src/server/auth/resolve-tenancy.ts`,
  `apps/web/proxy.ts`
- Code (primitives to compose): `packages/crypto/`, `packages/rbac/`,
  `packages/tenancy/`, `packages/command-bus/`, `packages/cache/`
- Schema: `prisma/schema.prisma` (`User.hashedPassword`,
  `User.mfaEnrolled`, `UserStatus`)
- External: OWASP Password Storage Cheat Sheet (Argon2id); RFC 6238
  (TOTP); RFC 4226 (HOTP); NIST SP 800-63B (authenticator
  assurance); HIPAA 45 CFR §164.308(a)(5), §164.312(a)(2)(iii),
  (d); SOC 2 CC6.1
