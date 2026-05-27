# Incident Response Policy — STUB

> **THIS IS A STUB.** Authoritative version:
> [`../../policies/incident-response-policy.md`](../../policies/incident-response-policy.md).
> Operational runbook lives at
> [`../../INCIDENT_RESPONSE.md`](../../INCIDENT_RESPONSE.md).
> Every `<TBD>` marker must be resolved by legal counsel and/or the
> SOC 2 auditor.

| Field          | Value                |
| -------------- | -------------------- |
| Owner          | Security Officer     |
| Approver       | CEO                  |
| Effective date | `<TBD>`              |
| Last reviewed  | `<TBD>`              |
| Next review    | `<TBD>`              |
| Version        | 0.1-stub             |
| Distribution   | Internal — All staff |

## 1. Purpose

Define how Pharmax detects, contains, eradicates, recovers from, and
learns from security incidents, including incidents that may be
reportable to customers and regulators.

## 2. Scope

- All Pharmax-operated systems (production, non-production, build and
  deploy infrastructure).
- All Pharmax workforce.
- All vendor-related incidents that affect Pharmax data.

## 3. Policy statements

### 3.1 Definition of an incident

An incident is any event that:

- Compromises or threatens confidentiality, integrity, or availability
  of Pharmax production systems, OR
- Constitutes unauthorized access to or disclosure of PHI, OR
- Triggers a regulator-notifiable threshold, OR
- Materially deviates from documented change-management or
  access-control processes.

### 3.2 Severity classification

| Severity      | Definition (sketch)                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| CRITICAL      | PHI disclosure to an unauthorized party; production data integrity loss; total service outage > 1 hour. |
| MAJOR         | Significant degradation; controlled disclosure within scope; partial outage.                            |
| MINOR         | Localized degradation; near-miss; control failure without disclosure.                                   |
| INFORMATIONAL | Anomalous signal under investigation; not yet confirmed.                                                |

`<TBD by SOC 2 auditor: confirm the severity vocabulary and the
classification thresholds expected for the audit framework.>`

### 3.3 Detection sources

- Sentry alerts (application errors).
- CloudWatch alarms (infrastructure).
- Audit-chain verifier (`scripts/security/verify-audit-chain-all-orgs.ts`).
- Nightly security digest.
- Customer reports.
- Internal observation.

### 3.4 Response timeline

- Triage within 1 hour of detection.
- Containment plan within 4 hours for CRITICAL / MAJOR.
- Customer notification within `<TBD by legal counsel: cross-reference
customer SLAs and HIPAA Breach Notification Rule §164.404 timing
requirements>`.
- Regulator notification within `<TBD by legal counsel: HIPAA Breach
Notification Rule §164.408 and applicable state law>`.
- Postmortem within 5 business days of incident close.

### 3.5 Communications

`<TBD by legal counsel: communication tree, template language for
customer notifications and regulator notifications, attorney-client
privilege considerations during the investigation phase.>`

### 3.6 Evidence preservation

- All incident-channel chat is exported at close.
- All commands run during containment go through the standard command
  bus (audit-logged).
- Break-glass elevations are governed by the access-control policy.
- Pulled logs and forensic artifacts land under
  `evidence/incidents/<year>/<id>/`.

### 3.7 Postmortem and remediation

- Every incident at MINOR or above has a postmortem.
- The postmortem follows the framework template (see
  [`../playbooks/incident-response.md`](../playbooks/incident-response.md)).
- Action items are tracked to completion; open items > 90 days
  escalate to the CTO.

## 4. Roles and responsibilities

| Role                         | Responsibility                                                  |
| ---------------------------- | --------------------------------------------------------------- |
| Security Officer             | Holds the framework; classifies severity; signs the postmortem. |
| Incident Commander (on-call) | Runs the response; assigns sub-roles.                           |
| CTO                          | Final technical decision authority; alternate for CEO comms.    |
| Compliance Officer           | Drafts regulator notifications; tracks BAA implications.        |
| CEO                          | Approves customer comms and regulator notifications.            |

## 5. Enforcement and sanctions

`<TBD by legal counsel: sanctions for failure to report, for
unauthorized public disclosure, or for hindering the response.>`

## 6. Review cadence

Annual, plus annual tabletop exercise (cross-reference
[`business-continuity.md`](./business-continuity.md)).

## 7. References

- ADR-0006 (hash-chained audit log).
- ADR-0024 (Merkle root signing).
- [`../../INCIDENT_RESPONSE.md`](../../INCIDENT_RESPONSE.md) (runbook).
- [`../playbooks/incident-response.md`](../playbooks/incident-response.md).

## 8. Revision history

| Version  | Date    | Author      | Change                  |
| -------- | ------- | ----------- | ----------------------- |
| 0.1-stub | `<TBD>` | Engineering | Initial framework stub. |
