# Business Continuity Policy — STUB

> **THIS IS A STUB.** Authoritative version:
> [`../../policies/business-continuity-and-disaster-recovery.md`](../../policies/business-continuity-and-disaster-recovery.md).
> The recovery side of the same policy is summarized in
> [`backup-and-recovery.md`](./backup-and-recovery.md).
> Every `<TBD>` marker must be resolved by legal counsel and/or the
> SOC 2 auditor.

| Field          | Value                               |
| -------------- | ----------------------------------- |
| Owner          | CTO                                 |
| Approver       | CEO                                 |
| Effective date | `<TBD>`                             |
| Last reviewed  | `<TBD>`                             |
| Next review    | `<TBD>`                             |
| Version        | 0.1-stub                            |
| Distribution   | Internal — Engineering + leadership |

## 1. Purpose

Define how Pharmax maintains business operations during and after a
disruptive event, including system outages, vendor failures, and
workforce-impacting events.

## 2. Scope

- Pharmax-operated production systems.
- Critical vendor dependencies (AWS, Clerk, Stripe, EasyPost).
- Workforce availability for the operations-critical roles
  (on-call engineering, customer-support, pharmacy operations
  coordination on the customer side).

## 3. Policy statements

### 3.1 Critical functions

| Function                                          | Criticality | Recovery priority |
| ------------------------------------------------- | ----------- | ----------------- |
| Order intake (typing → PV1 → fill → final → ship) | Critical    | 1                 |
| PHI confidentiality and integrity                 | Critical    | 1                 |
| Billing and invoicing                             | High        | 2                 |
| Reporting                                         | Medium      | 3                 |
| Non-production environments                       | Low         | 4                 |

`<TBD by SOC 2 auditor: confirm the criticality vocabulary and the
recovery priority numbering against the auditor's expectations.>`

### 3.2 Recovery objectives

Cross-reference [`backup-and-recovery.md`](./backup-and-recovery.md)
§3.5.

### 3.3 Single points of failure

The CTO maintains a register of single points of failure in the
Pharmax architecture and a remediation plan for each. The register
is reviewed annually.

### 3.4 Vendor continuity

For each critical vendor, the vendor-management policy review
includes:

- Vendor's documented continuity plan.
- Pharmax's contingency plan if the vendor experiences a multi-day
  outage.
- Pharmax's data-extraction plan if the vendor goes out of business.

### 3.5 Workforce continuity

- On-call rotation covers 24/7/365 per the runbook.
- Cross-training: every critical operational role has at least two
  trained alternates.
- Succession plan for the CTO, CEO, Security Officer, and Compliance
  Officer roles is documented `<TBD by legal counsel: detail
succession instruments and authority transfer language>`.

### 3.6 Testing

- Annual DR tabletop exercise; log lands at
  `evidence/dr-drills/<year>/tabletop.md`.
- Quarterly restore drill; log lands at
  `evidence/dr-drills/<period>/<date>.txt`.
- Annual incident-response tabletop (cross-reference
  [`incident-response.md`](./incident-response.md) §6).

### 3.7 Communications during a disruption

- Internal: incident channel, on-call paging.
- External: customer status page; customer comms per the IR policy
  §4.2.
- Regulatory: per the IR policy §5 where applicable.

## 4. Roles and responsibilities

| Role               | Responsibility                                              |
| ------------------ | ----------------------------------------------------------- |
| CTO                | Owns the continuity posture; chairs the annual DR tabletop. |
| Engineering Lead   | Operates the restore-drill cadence.                         |
| Security Officer   | Confirms post-recovery audit-chain integrity.               |
| Compliance Officer | Manages vendor continuity reviews.                          |
| Workforce Lead     | Maintains the cross-training matrix.                        |
| CEO                | Approves the continuity plan; named in the succession plan. |

## 5. Enforcement and sanctions

`<TBD by legal counsel: sanctions for failure to participate in
required drills, for failure to maintain cross-training, or for
disruption of the continuity process.>`

## 6. Review cadence

Annual, plus on any material change to the architecture, the vendor
set, or the workforce structure.

## 7. References

- [`backup-and-recovery.md`](./backup-and-recovery.md).
- [`incident-response.md`](./incident-response.md).
- [`vendor-management.md`](./vendor-management.md).
- [`../../operations/restore-drill.md`](../../operations/restore-drill.md).

## 8. Revision history

| Version  | Date    | Author      | Change                  |
| -------- | ------- | ----------- | ----------------------- |
| 0.1-stub | `<TBD>` | Engineering | Initial framework stub. |
