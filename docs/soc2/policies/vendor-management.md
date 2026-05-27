# Vendor Management Policy — STUB

> **THIS IS A STUB.** Authoritative version:
> [`../../policies/vendor-management-policy.md`](../../policies/vendor-management-policy.md).
> Vendor inventory:
> [`../../governance/vendor-inventory.md`](../../governance/vendor-inventory.md).
> BAA tracker:
> [`../../governance/baa-tracker.md`](../../governance/baa-tracker.md).
> Every `<TBD>` marker must be resolved by legal counsel and/or the
> SOC 2 auditor.

| Field          | Value                               |
| -------------- | ----------------------------------- |
| Owner          | Compliance Officer                  |
| Approver       | CEO                                 |
| Effective date | `<TBD>`                             |
| Last reviewed  | `<TBD>`                             |
| Next review    | `<TBD>`                             |
| Version        | 0.1-stub                            |
| Distribution   | Internal — Engineering + Compliance |

## 1. Purpose

Define how Pharmax onboards, monitors, and offboards third-party
vendors with access to Pharmax data or systems.

## 2. Scope

Every third party that:

- Stores, processes, or transmits Pharmax data, OR
- Has administrative access to Pharmax systems, OR
- Provides a security-relevant service (identity, encryption,
  monitoring, code hosting).

## 3. Policy statements

### 3.1 Onboarding

A new vendor requires:

- Vendor questionnaire completed.
- SOC 2 report on file (or alternative attestation justified in the
  questionnaire).
- BAA executed if the vendor will touch PHI.
- Data-processing addendum where required by applicable law.
- CTO + Security Officer co-approval.
- Inventory row added.

### 3.2 Continuous monitoring

- SOC 2 reports are tracked annually; renewal is requested before the
  prior report expires.
- BAA tracker is kept current; lapsed BAAs are a critical incident.
- Sub-processor lists are reviewed annually.
- Vendor scope changes (e.g. vendor begins touching PHI mid-year)
  trigger an out-of-cycle review.

### 3.3 Decommissioning

A vendor decommissioning requires:

- SDK and env-var configuration removed.
- Data deletion certificate received (where the vendor offers one).
- Inventory row updated with decommissioning date; row retained for
  lineage.

### 3.4 Direct PHI flows

Vendors that touch PHI by linkage (e.g. recipient address tied to a
pharmacy order) are PHI-touching. The classification is enforced in
the vendor inventory and confirmed at the annual review.

`<TBD by legal counsel: confirm the BAA template, indemnification
language, and termination-of-services language align with Pharmax's
contractual obligations to its customer clinics.>`

## 4. Roles and responsibilities

| Role               | Responsibility                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| Compliance Officer | Owns the vendor inventory; runs the annual review; signs the per-vendor and aggregate sign-offs. |
| CTO                | Approves new vendor onboarding; approves vendor decommissioning.                                 |
| Security Officer   | Reviews PHI-touching vendor scope changes; reviews vendor security incidents.                    |
| Engineering        | Implements the vendor SDK; raises any observed scope drift.                                      |

## 5. Enforcement and sanctions

`<TBD by legal counsel: sanctions for routing data to a non-approved
vendor, for missing a BAA, or for failing to remediate a vendor SOC 2
lapse.>`

## 6. Review cadence

Annual per the [`vendor-risk-review`](../playbooks/vendor-risk-review.md)
playbook, plus on-event for any onboarding or decommissioning.

## 7. References

- [`../../governance/vendor-inventory.md`](../../governance/vendor-inventory.md).
- [`../../governance/baa-tracker.md`](../../governance/baa-tracker.md).
- ADR-0013 (per-tenant carrier credentials).
- ADR-0014 (Stripe ports + adapters).

## 8. Revision history

| Version  | Date    | Author      | Change                  |
| -------- | ------- | ----------- | ----------------------- |
| 0.1-stub | `<TBD>` | Engineering | Initial framework stub. |
