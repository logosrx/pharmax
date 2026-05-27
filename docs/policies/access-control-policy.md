# Access Control Policy

| Field          | Value                       |
| -------------- | --------------------------- |
| Owner          | [Owner: CTO]                |
| Approver       | [Approver: CEO]             |
| Effective date | [Effective date: TBD]       |
| Last reviewed  | [Last reviewed: YYYY-MM-DD] |
| Next review    | [Next review: YYYY-MM-DD]   |
| Version        | 0.1                         |
| Distribution   | Internal — All staff        |

## 1. Purpose

This policy states how Pharmax controls access to its systems and data — who gets in, how they authenticate, what they're authorized to do once they're in, how multi-tenant isolation is enforced, and how access is reviewed and revoked.

The policy is the operational expression of:

- SOC 2 **CC6 — Logical and Physical Access Controls**: CC6.1 (logical access provisioning), CC6.2 (registration and authorization), CC6.3 (segregation of duties), CC6.6 (transmission of credentials), CC6.7 (restricted access to information).
- HIPAA Security Rule **45 CFR § 164.308(a)(3)** (workforce security), **§ 164.308(a)(4)** (information access management), **§ 164.312(a)(1)** (access control technical safeguard), **§ 164.312(d)** (person or entity authentication).

The architectural decisions that this policy ratifies are recorded in ADR 0004 (RLS-based multi-tenancy), ADR 0011 (separation of duties at the command bus), and ADR 0015 (Clerk-backed authentication, Pharmax-owned authorization).

## 2. Scope

This policy applies to:

- Every Pharmax-managed system (production, staging, internal tooling).
- Every vendor portal that holds Pharmax-managed credentials (AWS, Clerk, Stripe, EasyPost, FedEx, UPS, GitHub, Sentry, Datadog or Honeycomb, Vercel, 1Password, Resend).
- Every Pharmax database role, both human-attached and service-attached.
- Every API surface of the operator console.

## 3. Identity

### 3.1 Authentication is Clerk's job; authorization is Pharmax's

Per ADR 0015, Pharmax delegates authentication — sign-in, MFA, session management, password reset, OAuth — to **Clerk**. We own authorization (permissions, role templates, separation of duties, audit) and tenancy resolution in `@pharmax/rbac` and `@pharmax/tenancy`. The only bridge between Clerk and Pharmax is the `User.clerkUserId` column.

This split is deliberate. Authentication is a commodity surface that benefits from a specialist vendor; authorization is product-specific and safety-critical, so it stays in the codebase and the audit trail.

### 3.2 One human, one identity

Every account is owned by exactly one identified human (or one named service identity). Shared logins are forbidden per the [Acceptable Use Policy](./acceptable-use-policy.md) §3.1. System identities for workstation print agents and webhook services (`shipping-webhook@*`, `print-agent@*`) are intentionally non-human and never have a `clerkUserId` — they authenticate to the database via service credentials managed in AWS Secrets Manager.

### 3.3 Pre-provisioning

Operators are pre-provisioned in Pharmax via `bootstrap-org` before they sign in:

1. The admin creates the Pharmax `User` row with the appropriate role template and `clerkUserId` set to the Clerk user's id.
2. The operator signs into Clerk normally (`/sign-in`).
3. `resolveOperatorTenancyContext()` in `apps/web/src/server/auth/resolve-tenancy.ts` looks up the Pharmax `User` by `clerkUserId` in system context and builds the standard `TenancyContext`.

A sign-in that does not match a pre-provisioned Pharmax `User` row surfaces `RESOLVE_TENANCY_USER_NOT_LINKED` and the operator sees "contact your admin". This is intentional: a fresh Clerk sign-up should not be able to access Pharmax data just by signing in.

## 4. Authentication

### 4.1 MFA

MFA is mandatory for every operator account. The Clerk side is configured to require a second factor; users without an enrolled factor cannot sign in.

For two role templates, MFA is **enforced specifically on sign-in**:

| Role             | MFA required           | Reasoning                                                                                                                       |
| ---------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `BillingManager` | Yes                    | Can issue refunds and adjust invoices. Account takeover translates directly to financial harm.                                  |
| `OrgAdmin`       | Yes                    | Can change role assignments, invite/remove users, and configure tenant-wide settings.                                           |
| Other roles      | Yes (org-wide default) | Pharmacist / Tech / ShippingClerk all see PHI and execute workflow-altering commands. Account takeover is a SEV1 by definition. |

Hardware security keys (YubiKey or equivalent) are preferred over TOTP for `BillingManager`, `OrgAdmin`, and any Pharmax employee with `WebhookService` or platform-administration capability. TOTP is acceptable for everyday operator roles. SMS-only MFA is **not** acceptable for any role that touches PHI or money; SMS is acceptable as a fallback recovery channel only.

### 4.2 Password requirements

Password strength is configured at the Clerk policy level. The current settings:

- Minimum length 12 characters.
- Disallowed common-password list enabled.
- Breached-password lookup (HIBP-style) enabled.
- Maximum age: no expiration. We follow NIST SP 800-63B current guidance — periodic forced rotation degrades password quality without measurable security benefit. We rely on breach detection and prompt rotation on suspicion.

The detailed configuration lives in the Clerk dashboard; changes go through the [Change Management Policy](./change-management-policy.md) and are recorded in the access-review evidence pack.

### 4.3 Session management

Clerk manages session lifetimes:

- Operator console session timeout: 12 hours of inactivity, or 24 hours total — whichever is shorter.
- Re-authentication required after a session is invalidated, after a password change, after a role change, or after the operator signs out.
- Clerk-side session revocation is available to `OrgAdmin` users from the Clerk dashboard; we use this during incident response to terminate all active sessions for a suspected-compromised account.

## 5. Authorization — RBAC

### 5.1 Permission registry

Permissions live in `@pharmax/rbac` as a frozen registry of capability strings (e.g. `order:pv1:approve`, `invoice:finalize`, `patient:search:by-blind-index`). The registry is the source of truth. A `permission` database table is seeded from the registry; admin grants happen against the seeded rows; a parity test in `packages/rbac/permissions.test.ts` ensures the registry and the database stay in sync.

### 5.2 Role templates

Roles are templates of permission sets, seeded from `role_template` constants:

| Role                 | Purpose                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `PharmacyTechnician` | Typing, fill, scan, print. Cannot approve verifications.                                  |
| `Pharmacist`         | PV1 and Final Verification approvals. Subject to Separation of Duties (ADR 0011).         |
| `BillingManager`     | Invoice operations, refund issuance. MFA-enforced.                                        |
| `ShippingClerk`      | Shipping queue, label purchase, carrier credential management for own org.                |
| `OrgAdmin`           | Tenant-wide settings, user management, role assignment for own org. MFA-enforced.         |
| `WebhookService`     | System identity for Clerk / Stripe / EasyPost webhook handlers. Not human-signin-capable. |

Per-tenant custom roles are supported via the same registry pattern. A custom role is just a saved set of permission grants, owned by the tenant's `OrgAdmin`.

### 5.3 Per-permission overrides

Individual users may receive grant or revoke overrides on top of their role:

- `granted` and `revoked` overrides each carry `grantedByUserId`, `expiresAt`, and `reasonCode`. No silent forever-grants.
- The override store is `User.permissions: Json` per the EONPRO heritage, hardened per `../ARCHITECTURE_PRINCIPLES.md` §B.2.
- A "source-aware" effective view (`getEffectivePermissionsWithSource()`) explains every permission as `role_default | override_granted | override_revoked | not_available` so the role editor UI is auditable.

### 5.4 Scoping — every permission is contextual

Permissions are scoped to `(organization | site | clinic | team | bucket)`. A user can be `Pharmacist` on clinic A and `PharmacyTechnician` on clinic B. The `appliesInContext()` resolver computes the effective permission set per request given the active `TenancyContext`. The result is cached in a `WeakMap` keyed on the frozen context object.

### 5.5 Separation of Duties

Per ADR 0011, the SoD rules below are **enforced at the command bus**, not at the UI or the handler. The bus loads `order_event` history with a minimal select and rejects the attempt with `AuthorizationError(SOD_VIOLATION)` if any rule fires:

- `sod.typing-pv1-same-actor` — the technician who typed an order cannot be the pharmacist who approves PV1.
- `sod.pv1-final-same-actor` — the pharmacist who approves PV1 cannot also approve final verification (two-pharmacist sign-off).
- `sod.fill-final-same-actor` — the technician who completed the fill cannot also be the pharmacist who approves final verification.

SoD applies to sign-offs (`APPROVE`), not to opens (`START`) or rejections (`REJECT`). A pharmacist may self-reject a final verification because catching their own error is healthier than forcing a workaround.

### 5.6 Break-glass

Standing high-privilege grants are forbidden. Break-glass elevation is the documented path when an emergency requires a permission a user does not normally hold:

- The user requests break-glass via the admin UI with a stated reason.
- An `OrgAdmin` (or the CTO for platform-tier capabilities) approves.
- The grant is **time-limited to a maximum of four hours**.
- A `BREAK_GLASS` audit event is written immediately, plus a daily report to the security alias.
- An auto-revoke job removes the grant at the expiration time. The audit chain records both the grant and the revoke.

The break-glass path itself is privileged. Approval requires MFA reverification. The full audit metadata names the granting user, the receiving user, the permission, the reason, and the expiration.

### 5.7 The `pharmax_system` role — the database-side break-glass

For data-layer operations that need to span tenants (cross-tenant forensic queries during a SEV0, bootstrap CLIs, worker drains that legitimately operate without a tenant context), the `pharmax_system` database role exists per ADR 0004:

- It has `BYPASSRLS`. Its sole purpose is to operate when the RLS guard would otherwise block legitimate cross-tenant access.
- Its use is constrained by an ESLint allowlist to four locations: the definition site, the bus's `executeSystemCommand`, the `scripts/` directory, and `*.test.ts` fixtures.
- Every `withSystemContext` call records the actor and the reason in `audit_log`.
- Routine application code uses `withTenancyContext` and the `pharmax_app` role, which is subject to RLS.

The `pharmax_system` role is operationally the most powerful identity in the system. Its credential lives in AWS Secrets Manager, rotated per [`../security/secrets-management.md`](../security/secrets-management.md), and is never embedded in application configuration.

## 6. Tenancy isolation

### 6.1 The two-layer wall

Per ADR 0004, tenancy is enforced at two layers:

1. **Postgres Row-Level Security**, forced (`FORCE RLS`) on every tenant-scoped table. The `tenant_isolation` policy predicate is `current_setting('pharmax.system_context', true) = 'on' OR <tenant clause>`. The tenant clause uses `NULLIF` so an unset GUC collapses to NULL — **fail closed**.
2. **Application-layer `TenancyContext`** in `@pharmax/tenancy`, carried via Node's `AsyncLocalStorage`. The Prisma `$extends` middleware throws `AuthorizationError(TENANCY_NO_CONTEXT)` on any tenant-scoped query that runs without an active frame, passes through under `withSystemContext`, and throws `TENANCY_CROSS_ORG_WRITE` on a mismatched write.

The session GUCs (`pharmax.system_context`, `pharmax.organization_id`) are written by `applyTenancySessionGuc` and `applySystemSessionGuc` as the **first statement inside every transaction**, with the GUC value passed as a bound parameter — no string interpolation, no injection surface.

### 6.2 The migration linter

A migration that creates a new tenant-scoped table without an RLS policy fails CI. `scripts/check-migration-rls.ts` walks every migration in apply order and rejects any `CREATE TABLE` not paired with `ENABLE ROW LEVEL SECURITY` + `CREATE POLICY`. Exemptions live in `prisma/migrations/rls-exempt.txt` and require a documented justification.

### 6.3 The anti-leak property test

`packages/tenancy/anti-leak.test.ts` runs 100 parallel queries across N orgs and asserts cardinality. It stays green on every change to the Prisma extension. A regression in this test is a SEV0-equivalent build break — it doesn't deploy.

## 7. Provisioning and deprovisioning

### 7.1 Provisioning workflow

A new operator is provisioned as follows:

1. The hiring manager (or customer admin) opens a provisioning ticket: name, work email, intended role, tenant scope.
2. The provisioning owner (CTO for Pharmax internal, `OrgAdmin` for a customer org) creates the Clerk user (if not already present) and runs `bootstrap-org` to create the Pharmax `User` row with the requested role and scope.
3. The new operator receives the Clerk sign-in invitation, sets up MFA at first sign-in (mandatory), and signs into the operator console.
4. The provisioning is recorded in the `audit_log` with the actor, the new user, the role, the scope, and the timestamp.

Provisioning for a non-human identity (a print agent on a new workstation, a webhook service for a new integration) follows the same pattern with the relevant `WebhookService` or workstation role template and a credential issued from AWS Secrets Manager.

### 7.2 Deprovisioning workflow

A departing operator is deprovisioned as follows:

1. The departure trigger event reaches the CTO (employee exit, contractor end-date, customer removal of a sub-user).
2. The CTO (or `OrgAdmin` for a customer) executes the deprovisioning command, which:
   - Disables the Pharmax `User` row (`status: 'DISABLED'`).
   - Revokes the Clerk user's sessions and removes them from the org.
   - Removes the user from the AWS SSO directory (if applicable).
   - Removes the user from every vendor portal they had access to (1Password, GitHub, Stripe, EasyPost, etc.) — the access-review report is the checklist.
   - Records the deprovisioning in `audit_log`.
3. The deprovisioning is verified in the next quarterly access review — the departed user should not appear in any access report.

The deprovisioning **must complete the same business day** for involuntary departures. For voluntary departures, deprovisioning happens on the last day of work.

### 7.3 Role changes

A role change (promotion, lateral move, scope change) is a `ChangeRoleAssignment` command:

- Recorded in `audit_log` with the granting user, the affected user, the prior role, the new role, and the reason.
- Effective on the next session (or after force-session-invalidation if immediate effect is required).
- Counted in the quarterly access review as an explainable change.

## 8. Access reviews

Quarterly access reviews are mandatory. The detailed procedure lives at [`../governance/access-review-procedure.md`](../governance/access-review-procedure.md); the policy-level summary:

- **Scope.** Every system listed in §2: Clerk users + Pharmax role assignments, AWS IAM principals, Stripe dashboard users, EasyPost / FedEx / UPS portal users, GitHub repo collaborators, Sentry / Datadog (or Honeycomb) users, Resend users, 1Password vault membership.
- **Cadence.** Quarterly (Q1 / Q2 / Q3 / Q4). The review window opens at the start of each quarter and closes by the 15th of the second month of the quarter.
- **Reviewer.** Each report is reviewed by the named owner (CTO for Pharmax internal; `OrgAdmin` for a customer's own users).
- **Sign-off.** The CTO signs the consolidated review at the end of each quarter. The signed report is archived in `evidence/access-reviews/<YYYY-Q#>/`.
- **Anomalies.** Anything found out-of-policy (a user who shouldn't be there, a role that's too broad, a stale account) generates a corrective ticket. Corrective action is tracked in the next quarter's review.

The supporting SQL and CLI scripts to generate the access-review reports live in `scripts/security/access-review/` (delivered by the Tier 3 access-review lane).

## 9. Privileged access — special handling

A small set of accounts and roles is treated as privileged and held to a higher bar:

- **AWS root.** Hardware MFA, no routine use, password in 1Password under CTO + CEO joint custody.
- **AWS Organization management account.** SSO with hardware MFA. SCPs deny everything not explicitly required.
- **GitHub org owner.** Hardware MFA, limited to the smallest set of people (today: CTO, one delegate).
- **Clerk admin.** Hardware MFA. The Clerk admin role is the lever for changing the auth policy itself.
- **Stripe live owner.** Hardware MFA. The Stripe owner can issue refunds and download financial reports.
- **`pharmax_system` database role.** Per §5.7, ESLint-allowlisted, audit-logged, no human-attached credential — it is reached via the application layer in documented session contexts.
- **AWS KMS administrators.** The role allowed to schedule key deletion is held by the CTO; the role allowed to enable / disable / rotate keys is held by the CTO and one delegate.

Privileged access is reviewed not just quarterly but **on every change** — promotion, departure, scope change. The privileged-access list is in `evidence/access-reviews/<YYYY-Q#>/privileged.csv`.

## 10. Cross-references

- [Information Security Policy](./information-security-policy.md) — parent.
- [Acceptable Use Policy](./acceptable-use-policy.md) — credential hygiene that this policy depends on.
- [`../governance/access-review-procedure.md`](../governance/access-review-procedure.md) — quarterly review SOP.
- [`../security/control-matrix.md`](../security/control-matrix.md) — CC6 and HIPAA technical-safeguard mapping.
- ADR 0004 — Multi-tenancy via Postgres RLS.
- ADR 0011 — Separation of Duties at the command bus.
- ADR 0015 — Clerk authentication, Pharmax authorization.
- ADR 0006 — Hash-chained audit log (where the access-control events land).

## Revision history

| Version | Date       | Author | Change           |
| ------- | ---------- | ------ | ---------------- |
| 0.1     | YYYY-MM-DD | CTO    | Initial drafting |
