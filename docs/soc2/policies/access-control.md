# Access Control Policy — STUB

> **THIS IS A STUB.** Authoritative version:
> [`../../policies/access-control-policy.md`](../../policies/access-control-policy.md).
> Every `<TBD>` marker must be resolved by legal counsel and/or the
> SOC 2 auditor.

| Field          | Value                |
| -------------- | -------------------- |
| Owner          | CTO                  |
| Approver       | CEO                  |
| Effective date | `<TBD>`              |
| Last reviewed  | `<TBD>`              |
| Next review    | `<TBD>`              |
| Version        | 0.1-stub             |
| Distribution   | Internal — All staff |

## 1. Purpose

Define how identities are established, how access is granted and
revoked, how privileges are scoped, and how access is reviewed.

## 2. Scope

All Pharmax workforce and all third-party identities (vendor support,
contractors) that touch Pharmax production systems.

## 3. Policy statements

### 3.1 Identity establishment (authentication)

- Identity is established by the in-house identity engine (ADR-0030),
  which superseded the Clerk split of ADR-0015. `User.clerkUserId`
  remains in the schema as a nullable legacy column with no live writer.
- MFA is required for **high-privilege roles**, not yet for every
  operator. ADR-0030 carries forward the floor from ADR-0025 §3; the
  role set is `MFA_REQUIRED_ROLE_CODES` at
  `packages/auth/src/configure.ts:68` and today contains `OrgAdmin` and
  `BillingManager` only. It is enforced in the sign-in path at
  `packages/auth/src/commands/sign-in.ts:104`, where a second factor is
  demanded if the user holds a floor role **or** has voluntarily
  enrolled. An operator outside the floor set who has not enrolled signs
  in with a password alone. Whether the policy should read
  MFA-everywhere or role-conditional is `<TBD by SOC 2 auditor: confirm
wording; the implemented posture is role-conditional (gate: PRE-T1)>`.
- Passwordless / SSO supplements the default password+MFA mechanism
  where the organization's IdP supports it.

### 3.2 Authorization (RBAC)

- Authorization is enforced through `@pharmax/rbac` permissions and
  role templates.
- Every role template is reviewed at least annually.
- Per-permission overrides (grants outside the template) carry an
  `expires_at` timestamp.

### 3.3 Tenancy isolation

- Every tenant-scoped query goes through the application-layer
  tenancy context (`@pharmax/tenancy`).
- RLS enforces the wall at the database layer (ADR-0004).
- Cross-tenant access requires the system-context bypass, which is
  audited and limited to documented call sites (bootstrap, webhook
  drains, security scripts).

### 3.4 Separation of duties

SoD rules are encoded as declarative rules in
`packages/rbac/src/separation-of-duties.ts` (ADR-0011) and enforced
inside the command bus. Canonical rules:

- Typing tech who completes typing cannot approve PV1.
- Pharmacist who approves PV1 cannot approve final verification.
- Fill tech who completes fill cannot approve final verification.

`<TBD by SOC 2 auditor: confirm any additional SoD rules expected by
the auditor for pharmacy operations (gate: PRE-T1).>`

### 3.5 Provisioning and deprovisioning

- New users are pre-provisioned via `bootstrap-org` and complete
  enrollment through the invite flow (`AcceptInvite`) under ADR-0030.
- Termination is actioned by an administrator dispatching
  `DeactivateUser`
  (`packages/auth/src/commands/deactivate-user.ts`), which flips
  `User.status` to `SUSPENDED` or `TERMINATED` **and** revokes every
  active session in the same transaction, so the next request from a
  stale session is rejected at `resolveSession`. The command writes
  `command_log` and `audit_log` like any other.
- This step is **manual**. The automated Clerk `user.deleted` webhook
  that previously translated a termination into a status flip was
  removed with Clerk (ADR-0030) and nothing replaced it. There is no
  identity-provider or HR-system trigger, so the system cannot detect a
  termination that nobody actioned. CC6.5-1 is recorded as `Partial` for
  this reason; see `EI-6` in
  [`../evidence-integrity-findings.md`](../evidence-integrity-findings.md).
- The deprovisioning SLA is `<TBD by legal counsel: 24 hours
from termination is the current engineering target; confirm against
employment-law obligations and any customer contractual SLAs (gate:
PRE-T1)>`.

### 3.6 Break-glass

Emergency elevated access is granted through the break-glass primitive
in `@pharmax/rbac` with a 4-hour cap (ADR-0011). Every break-glass
elevation requires:

- A written justification (lands in `evidence/break-glass/<year>/`).
- A peer second on the elevation request (recorded in the `audit_log`
  scope payload).
- Auto-expiry at 4 hours; no extension without a fresh elevation
  request.

### 3.7 Access reviews

Per the [`quarterly-access-review`](../playbooks/quarterly-access-review.md)
playbook. Every active organization is reviewed once per quarter.

## 4. Roles and responsibilities

| Role                  | Responsibility                                                              |
| --------------------- | --------------------------------------------------------------------------- |
| Security Officer      | Quarterly access reviews; break-glass governance; audit-chain verification. |
| OrgAdmin (per-tenant) | Reviews their organization's access at the quarterly cadence.               |
| Workforce Lead        | Triggers provisioning on hire; triggers deprovisioning on termination.      |
| Engineering           | Implements the access primitives; reviews access-touching PRs.              |

## 5. Enforcement and sanctions

`<TBD by legal counsel: sanctions wording for misuse of access,
unauthorized elevation, or failure to comply with the quarterly
review (gate: PRE-T1).>`

## 6. Review cadence

Annual, plus on any material change to the access primitives (new
role template, new SoD rule, new MFA factor required).

## 7. References

- ADR-0004 (RLS).
- ADR-0011 (SoD).
- ADR-0030 (in-house identity engine; supersedes ADR-0015 and ADR-0025,
  both retained for lineage).
- ADR-0036 (SSO and WebAuthn second factor).
- `packages/auth/`, `packages/rbac/`, `packages/tenancy/`.

## 8. Revision history

| Version  | Date    | Author      | Change                  |
| -------- | ------- | ----------- | ----------------------- |
| 0.1-stub | `<TBD>` | Engineering | Initial framework stub. |
