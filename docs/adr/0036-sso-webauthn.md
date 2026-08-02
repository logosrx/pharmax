# 0036 — WebAuthn second factor and SSO federation behind the auth engine

- **Status:** Accepted (slice 1 — WebAuthn — shipped; slice 2 — OIDC SSO — planned)
- **Date:** 2026-08-01
- **Deciders:** Platform team, Security officer
- **Tags:** `security`, `authentication`, `mfa`, `webauthn`, `sso`

## Context

ADR-0030 shipped the in-house identity engine with TOTP + recovery
codes as the v1 second factor and explicitly deferred two things
behind existing seams:

- a **WebAuthn/passkey adapter** "behind the same interface" as the
  TOTP verifier, and
- **SSO/SAML federation** as the documented contingency ("revisit if
  patient-scale MAU or SSO/SAML demand arrives").

Both are now in scope (roadmap P1). Forces:

- **Phishing resistance.** TOTP codes are phishable and relayable;
  HIPAA §164.312(d) plus NIST SP 800-63B AAL3 guidance push regulated
  operators toward origin-bound authenticators (security keys,
  platform passkeys). Pharmacist and admin roles carry the MFA floor
  (ADR-0025 → ADR-0030); the floor should be satisfiable by a
  hardware token, not only a shared-secret code.
- **Enterprise customers arrive with an IdP.** Multi-site pharmacy
  groups run Okta/Entra and expect operator sign-in federated to
  their directory, with offboarding driven by the IdP.
- **The engine's boundaries were built for this.** MFA verification
  is already a private branch inside the `SignIn` command; sessions
  are opaque server-side rows; every auth state change is a bus
  command. Both features compose behind those boundaries without
  touching downstream packages.

## Decision

Ship in two slices behind `@pharmax/auth`. Neither changes the
session model, the RBAC/tenancy split, nor any domain package.

### Slice 1 — WebAuthn second factor (this change)

1. **Port-and-adapter, not a protocol implementation.** A
   `WebAuthnAdapter` port (generate/verify for registration and
   authentication ceremonies) lives in the engine configuration next
   to the password hasher. The production adapter wraps
   `@simplewebauthn/server` (attestation `none`, user verification
   `preferred` — the password is always the first factor, so the
   authenticator is presence-bound, not PIN-mandatory). Tests inject
   a deterministic fake; we do not re-implement CBOR/COSE.
2. **Credentials are rows, not enrollment blobs.** A
   `webauthn_credential` row stores the base64url credential id
   (unique), COSE public key, signature counter, transports, AAGUID,
   and a user-visible label. Multiple credentials per user are
   allowed (a phone passkey plus a backup YubiKey is the norm);
   `excludeCredentials` prevents double-registering the same key.
   Public keys are public — they are not sealed with KMS (unlike
   TOTP secrets, possession of the row is useless without the
   private key, which never leaves the authenticator).
3. **Challenges are single-use server rows.** Both ceremonies persist
   a `webauthn_challenge` row (purpose `REGISTRATION` or
   `AUTHENTICATION`, 5-minute TTL). Verification consumes the row in
   the same transaction — a challenge can never verify twice, and a
   replayed assertion dies on the consumed row before any
   cryptographic check runs.
4. **Enrollment is two bus commands**, mirroring `EnrollMfa` /
   `ConfirmMfa`: `EnrollWebAuthnCredential` (mint challenge, return
   creation options) and `ConfirmWebAuthnCredential` (verify
   attestation, store credential, flip `user.mfaEnrolled`, and mint
   recovery codes if this is the user's first authenticator of any
   kind — recovery codes stay the account-recovery backstop for both
   factor types).
5. **Sign-in stays one command.** The assertion ceremony needs a
   server round-trip before `navigator.credentials.get`, so a
   `StartWebAuthnAuthentication` system command (password-gated, so
   credential ids are never enumerable without the first factor;
   fronted by the same rate-limit + lockout gates as `signIn`) mints
   the challenge and returns request options. The client then
   re-submits `SignIn` with the assertion in place of a TOTP code —
   the MFA branch inside `SignIn` verifies whichever proof arrives,
   so `mfaSatisfied`, audit, outbox, and the login ledger are
   identical for both factor types. `MFA_REQUIRED` now carries the
   user's available `methods` so the form can offer the right UI.
6. **Counter regressions hard-fail.** The stored signature counter is
   passed to verification; a cloned-authenticator signal (counter not
   advancing) rejects the assertion. Counters are `BIGINT` (the spec
   allows the full uint32 range, which overflows int4).
7. **RP identity comes from the request, not config.** Operator
   sign-in is per-org-subdomain, so the web tier derives `rpId`
   (hostname) and `origin` per request from the same trusted host
   resolution that picks the organization; the engine treats them as
   inputs to verify against, never trusts the client for them.

### Slice 2 — SSO federation (next)

1. **OIDC first, SAML later.** v1 federates via OpenID Connect
   authorization-code + PKCE (Okta, Entra, Google Workspace all speak
   it). SAML remains deferred; if demanded, it arrives as a second
   adapter behind the same `SsoProvider` port, not a parallel path.
2. **Org-scoped provider config.** An `sso_provider` row per
   organization: issuer URL, client id, KMS-sealed client secret,
   allowed email domains. Discovery + JWKS are fetched and cached;
   ID-token signature, `iss`, `aud`, `nonce`, and `exp` are all
   verified server-side.
3. **Federation maps to existing users — no JIT user creation in
   v1.** The verified IdP email must match an ACTIVE `User` in the
   provider's organization; an `sso_identity` row links
   `(provider, subject)` to the user after first sign-in. Unknown
   emails are rejected (invitation stays the provisioning path,
   ADR-0030's SoD posture).
4. **Sessions and audit are unchanged.** A successful federation runs
   an `SsoSignIn` system command that mints the same opaque session
   row (`mfaSatisfied` true only when the IdP asserts a compliant
   AMR/ACR, else step-up applies), writes the same ledger/audit/outbox
   rows, and drops the same cookie. Password lockout, reset, and MFA
   floors are simply bypassed-by-construction only where the IdP is
   authoritative — never silently for password users.

## Consequences

**Easier:**

- Phishing-resistant MFA for the floor roles; security keys satisfy
  the same `mfaSatisfied` gate with no changes to
  `dispatch-ops-with-mfa` or any privileged route.
- Both ceremonies are auditable bus commands — enrollment and use of
  a hardware token are `command_log`/`audit_log`/`event_outbox` rows
  by construction.
- The adapter port keeps the engine testable without authenticator
  hardware and keeps `@simplewebauthn/server` swappable.

**Harder / obligations:**

- One new third-party dependency in the auth-critical path
  (`@simplewebauthn/server`) — pinned, reviewed on upgrade, and
  isolated behind the adapter port.
- The account-security surface must make lost-authenticator recovery
  obvious (recovery codes remain the backstop; admin-driven
  credential removal is `RevokeSessions` + credential disable).
- Challenge rows need TTL hygiene; expired rows are purged
  opportunistically at mint time (no cron dependency).

**Failure modes:**

- **Stolen credential row** — useless without the private key;
  counters + unique credential id contain cloning.
- **Origin/rpId mismatch** (subdomain confusion) — verification
  fails closed; rpId derives from the same host resolution as the
  org, so a cross-org replay targets the wrong rpId hash.
- **Adapter library CVE** — single import site (the adapter file),
  version pinned in one package.json.

## Alternatives Considered

- **Passkeys as a first factor (passwordless).** Deferred: the
  engine's lockout, ledger, and floor semantics are password-first
  today; usernameless adds discoverable-credential UX work without
  advancing the P1 goal (second-factor hardware tokens). The schema
  (resident-key friendly) does not preclude it.
- **Implementing WebAuthn verification in-house.** Rejected —
  CBOR/COSE/attestation parsing is exactly the "don't reinvent
  security primitives" territory ADR-0030 carved out.
- **SAML first.** Rejected — every target IdP speaks OIDC; SAML's
  XML-signature attack surface is larger, and the port design lets
  it arrive later without rework.
- **Sealing WebAuthn public keys with KMS.** Rejected — they are
  public by definition; sealing adds a KMS round-trip per sign-in
  for zero confidentiality gain.

## References

- Supersedes nothing; extends ADR-0030 (in-house identity engine).
- Companion: 0007 (command-bus contract), 0028 (KMS rotation — TOTP
  secrets only), 0025 (MFA floor, carried through 0030).
- Code: `packages/auth/src/mfa/webauthn.ts` (port + adapter),
  `packages/auth/src/commands/enroll-webauthn.ts`,
  `packages/auth/src/commands/confirm-webauthn.ts`,
  `packages/auth/src/commands/start-webauthn-authentication.ts`,
  `packages/auth/src/commands/sign-in.ts` (assertion branch),
  `apps/web/app/api/auth/webauthn/`, `apps/web/app/ops/account/security/`.
- Schema: `prisma/schema.prisma` (`WebAuthnCredential`,
  `WebAuthnChallenge`).
- External: W3C WebAuthn Level 2; FIDO2 CTAP2; NIST SP 800-63B
  (AAL2/AAL3); RFC 6749 §4.1 + RFC 7636 (PKCE); OpenID Connect Core
  1.0; HIPAA 45 CFR §164.312(d).
