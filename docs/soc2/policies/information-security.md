# Information Security Policy — STUB

> **THIS IS A STUB.** Authoritative version:
> [`../../policies/information-security-policy.md`](../../policies/information-security-policy.md).
> This file is the SOC 2 framework's structural placeholder and is
> **not** a legally-binding policy. Every `<TBD>` marker must be
> resolved by legal counsel and/or the SOC 2 auditor before this
> document is treated as authoritative.

| Field          | Value                                                  |
| -------------- | ------------------------------------------------------ |
| Owner          | CTO                                                    |
| Approver       | CEO                                                    |
| Effective date | `<TBD by legal counsel: pending policy adoption date>` |
| Last reviewed  | `<TBD: set on first annual review>`                    |
| Next review    | `<TBD: Effective date + 1 year>`                       |
| Version        | 0.1-stub                                               |
| Distribution   | Internal — All staff                                   |

## 1. Purpose

This policy is the umbrella that organizes Pharmax's security program.
It states the security program's objectives, names the roles
responsible for the program, and references every sub-policy that
implements those objectives.

`<TBD by legal counsel: language tying the policy to HIPAA Security
Rule §164.308(a)(1)(i) (Security Management Process), state breach
notification statutes applicable to the customer footprint, and any
customer contractual commitments.>`

## 2. Scope

This policy applies to:

- All Pharmax employees, contractors, and contingent workers.
- All Pharmax production and non-production systems.
- All Pharmax data classifications (Public, Internal, Confidential,
  Restricted-PHI) defined in
  [`data-classification.md`](./data-classification.md).
- All third parties with access to Pharmax data, governed by
  [`vendor-management.md`](./vendor-management.md).

## 3. Policy statements

### 3.1 Security program objectives

`<TBD by SOC 2 auditor: precise wording of the security objectives
expected for SOC 2 Type I design adequacy and Type II operating
effectiveness. The current engineering objectives are summarized in
the controls inventory.>`

### 3.2 Risk-based approach

Pharmax operates a risk-based security program, refreshed annually
per [`../../governance/risk-assessment-procedure.md`](../../governance/risk-assessment-procedure.md).

### 3.3 Defense in depth

Pharmax operates layered controls: authentication (Clerk), authorization
(`@pharmax/rbac`), tenancy isolation (RLS), envelope encryption per
PHI field, hash-chained audit log, and ongoing monitoring (Sentry,
CloudWatch, nightly digest).

### 3.4 Sub-policies

This policy is implemented through the bundle:

- [`access-control.md`](./access-control.md)
- [`change-management.md`](./change-management.md)
- [`incident-response.md`](./incident-response.md)
- [`data-classification.md`](./data-classification.md)
- [`backup-and-recovery.md`](./backup-and-recovery.md)
- [`vendor-management.md`](./vendor-management.md)
- [`acceptable-use.md`](./acceptable-use.md)
- [`business-continuity.md`](./business-continuity.md)

## 4. Roles and responsibilities

| Role               | Responsibility                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| CEO                | Final policy approval; HIPAA Privacy Official `<TBD by legal counsel: confirm the title used in the BAA template>`. |
| CTO                | Accountable for the engineering security posture; HIPAA Security Official.                                          |
| Security Officer   | Day-to-day operation of the security program; on-call for incidents; runs access reviews and chain verifications.   |
| Compliance Officer | Policy lifecycle; vendor risk; data-subject requests; training program.                                             |
| Engineering Lead   | CI/CD gates; change-management operation; SLA on the engineering controls.                                          |
| Workforce Lead     | Onboarding, off-boarding, training records, acceptable-use acknowledgments.                                         |
| All workforce      | Adherence to this policy and every sub-policy.                                                                      |

`<TBD by legal counsel: confirm titles in the BAA, MSA, and employee
handbook align with the role labels above.>`

## 5. Enforcement and sanctions

`<TBD by legal counsel: precise sanctions schedule. Coordinate with
People and Legal. The current draft posture is that violations are
addressed per the employee handbook progressive-discipline schedule,
with material PHI mishandling or willful policy violation as
grounds for immediate termination and potential civil/criminal
referral.>`

## 6. Review cadence

This policy is reviewed:

- Annually per the [annual policy review playbook](../playbooks/annual-policy-review.md).
- On material change (new vendor with PHI access, new sub-processor,
  significant change in regulatory posture, change in the modular
  monolith blast-radius boundaries).

## 7. References

- ADR set (`../../adr/`).
- Controls inventory ([`../controls-inventory.md`](../controls-inventory.md)).
- TSC mapping ([`../trust-service-criteria-mapping.md`](../trust-service-criteria-mapping.md)).
- Risk register ([`../../governance/risk-register.md`](../../governance/risk-register.md)).

## 8. Revision history

| Version  | Date    | Author      | Change                  |
| -------- | ------- | ----------- | ----------------------- |
| 0.1-stub | `<TBD>` | Engineering | Initial framework stub. |
