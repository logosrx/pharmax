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

- Identity is established through Clerk; the bridge to Pharmax is
  `User.clerkUserId` (ADR-0015).
- MFA is required for every operator (ADR-0025 §3 sets the floor for
  high-privilege roles; the broader workforce posture is `<TBD by SOC
2 auditor: confirm MFA-everywhere wording vs role-conditional
wording>`).
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
the auditor for pharmacy operations.>`

### 3.5 Provisioning and deprovisioning

- New users are pre-provisioned via `bootstrap-org` (`User.clerkUserId`
  set at provisioning time). First Clerk sign-in completes the link.
- Termination triggers a Clerk webhook `user.deleted`, which the
  webhook handler (ADR-0025 §1) translates into `User.status =
INACTIVE` and writes an `audit_log` row.
- The deprovisioning SLA is `<TBD by legal counsel: 24 hours
from termination is the current engineering target; confirm against
employment-law obligations and any customer contractual SLAs>`.

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
review.>`

## 6. Review cadence

Annual, plus on any material change to the access primitives (new
role template, new SoD rule, new MFA factor required).

## 7. References

- ADR-0004 (RLS).
- ADR-0011 (SoD).
- ADR-0015 (Clerk + Pharmax authorization split).
- ADR-0025 (Clerk hardening).
- `packages/rbac/`, `packages/tenancy/`.

## 8. Revision history

| Version  | Date    | Author      | Change                  |
| -------- | ------- | ----------- | ----------------------- |
| 0.1-stub | `<TBD>` | Engineering | Initial framework stub. |
