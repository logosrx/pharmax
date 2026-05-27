# Playbook: Incident Response (Framework View)

| Field                | Value                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Controls satisfied   | CC7.3-1, CC7.3-2, CC7.4-1, CC4.2-1, CC2.3-1                                                                               |
| Cadence              | Per-event; framework readiness reviewed quarterly                                                                         |
| Owner                | Security Officer (incident commander rotates; SO holds the framework)                                                     |
| Reviewers            | CTO (technical), Compliance Officer (notification)                                                                        |
| Final sign-off       | Security Officer signs the postmortem; CEO signs material-incident customer comms                                         |
| Evidence destination | `evidence/incidents/<year>/<incident-id>/`, `evidence/external-comms/<year>/`, `evidence/regulator-notifications/<year>/` |

## Purpose

This playbook is the **framework view** of incident response. The
operational runbook lives at
[`docs/INCIDENT_RESPONSE.md`](../../INCIDENT_RESPONSE.md); the policy
lives at
[`docs/policies/incident-response-policy.md`](../../policies/incident-response-policy.md).
This file describes how the framework verifies that the operational
process ran when it was supposed to and produced the evidence the
audit needs.

## Incident definition (recap)

An incident is any event that:

- Compromises or threatens confidentiality, integrity, or availability
  of Pharmax production systems, or
- Constitutes unauthorized access to (or disclosure of) PHI, or
- Triggers a regulator-notifiable threshold (HIPAA Breach
  Notification Rule, state breach laws, customer SLA), or
- Materially deviates from documented change-management or
  access-control processes.

Severity tiers per the IR policy: `CRITICAL`, `MAJOR`, `MINOR`,
`INFORMATIONAL`.

## Procedure (framework view)

### Step 1 — Triage and classification (within 1 hour of detection)

The on-call engineer (per [`docs/RUNBOOK.md`](../../RUNBOOK.md)
on-call schedule) opens an incident channel and a tracking entry. The
Security Officer (or alternate) classifies severity.

Evidence captured at this step:

- Incident ticket id (Linear / Jira / equivalent).
- Channel link.
- Initial severity.
- Detection source (Sentry alert, customer report, internal
  observation, security digest).

### Step 2 — Containment and investigation

Per the operational runbook. The framework's interest is in evidence
preservation:

- All commands run during containment are logged via the standard
  command bus (no direct DB writes; if a break-glass elevation is
  used, the elevation row in `audit_log` is the evidence).
- Conversations in the incident channel are exported at incident
  close (Slack export under `evidence/incidents/<year>/<id>/chat.zip`).
- Any logs pulled from CloudWatch / Sentry are saved under
  `evidence/incidents/<year>/<id>/logs/`.

### Step 3 — Customer notification (if required)

The IR policy §4.2 defines the customer-notification threshold. Where
notification is required:

- The CEO (or CTO as alternate) approves the customer comm draft.
- The comm is sent through the documented channel (email + status
  page).
- A copy of the sent comm lands at
  `evidence/external-comms/<year>/<incident-id>.md`.

### Step 4 — Regulator notification (if required)

The IR policy §5 defines the regulator-notification threshold (HIPAA
Breach Notification Rule, applicable state breach laws, applicable
sectoral rules). Where notification is required:

- The Compliance Officer drafts the notification.
- The CEO approves.
- The notification is filed through the regulator's documented
  channel.
- A copy of the filed notification lands at
  `evidence/regulator-notifications/<year>/<incident-id>.md`.

### Step 5 — Postmortem (within 5 business days of incident close)

The Security Officer drives the postmortem. Required sections:

- Timeline (detection → containment → recovery → comms).
- Root cause.
- Contributing factors.
- What went well.
- What did not go well.
- Action items (owner + target date per item).
- Risk-register reference (if a new systemic risk surfaced).

The postmortem lands at
`evidence/incidents/<year>/<incident-id>/postmortem.md` and is signed
by the Security Officer.

### Step 6 — Action-item tracking

Every action item is tracked in the engineering backlog with the
incident id in the title. Open action items are reviewed in the
quarterly readiness checklist; an action item open > 90 days is
escalated to the CTO.

### Step 7 — Quarterly framework review

As part of the audit-readiness checklist (Section 7), the Security
Officer:

- Runs `pnpm tsx scripts/soc2/export-incident-log.ts --from=<start>
--to=<end>`.
- Confirms every incident in the period has a postmortem on file.
- Confirms every `MAJOR`+ incident had a customer comm and (where
  required) a regulator notification.
- Confirms every action item is tracked or closed.

## Exception handling

- **No incidents in the period.** Land a one-line file at
  `evidence/incidents/<year>/no-incidents-<YYYY-Q#>.txt` so the audit
  can confirm the absence is intentional.
- **Incident discovered after the period closes.** Open the postmortem
  immediately; the audit framework treats the postmortem date, not the
  incident date, as the discovery anchor.
- **Postmortem misses the 5-business-day window.** Allowed once per
  year with CTO approval recorded; recurrence is a deficiency.

## Annual tabletop

Per CC7.5 / A1.3, the Security Officer runs an annual incident
tabletop exercise. The tabletop log lands at
`evidence/dr-drills/<year>/incident-tabletop.md`. The tabletop
exercises three classes of scenario: (1) PHI disclosure via a
mis-scoped query, (2) Stripe webhook spoof, (3) lost laptop with
production credentials.
