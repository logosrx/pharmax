# Incident Response Policy

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

This policy is the management-system frame around incident response at Pharmax. The operational mechanics — how to acknowledge an alert, who runs the room, what the postmortem template looks like — are documented in [`../INCIDENT_RESPONSE.md`](../INCIDENT_RESPONSE.md). This policy adds the things that policy documents have to say so that engineers don't have to: who has classification authority, who has to be told what when, what the regulators expect, how evidence is preserved, how often we practice, and how the program is reviewed.

If you are responding to a live incident, **stop reading this policy and open** [`../INCIDENT_RESPONSE.md`](../INCIDENT_RESPONSE.md). Come back when the room is calm.

This policy maps to:

- SOC 2 **CC7.3** (security event evaluation), **CC7.4** (response to identified incidents), **CC7.5** (communication of incidents).
- HIPAA **45 CFR § 164.308(a)(6)** — security incident procedures.
- HIPAA **45 CFR § 164.404** — notification to individuals.
- HIPAA **45 CFR § 164.410** — notification by a Business Associate to the covered entity.

## 2. Scope

This policy covers any event that meets the SEV0 / SEV1 / SEV2 / SEV3 definitions in [`../INCIDENT_RESPONSE.md`](../INCIDENT_RESPONSE.md), plus any of:

- Suspected PHI exposure of any volume.
- Suspected credential compromise.
- Suspected cross-tenant data leak.
- A break in the hash-chained audit log.
- A vendor-disclosed security event that affects Pharmax data.

It also covers near-misses — events where a safeguard would have failed but a compensating control caught the issue. Near-misses are treated as SEV3-equivalent for postmortem purposes; we learn from them as a free preview of failures we would otherwise have to actually have.

## 3. Severity classification authority

Initial classification is set by the first responder — whoever acknowledges the alert. The runbook explicitly recommends classifying **up** when in doubt, because a SEV1-that-turns-out-to-be-SEV3 is a non-event and the inverse is a career-defining miss.

Classification can be **adjusted up** by anyone in the response. Classification can be **adjusted down** only by the Incident Commander (IC) and only with stated reasoning recorded in the incident channel.

The CTO has classification authority over any incident in this program. The CTO may step in as IC or appoint an IC for any SEV0 or SEV1.

The CEO is informed within one hour of any SEV0 or SEV1 (see §4 communications tree).

## 4. Communications tree

### 4.1 Internal communications

The internal cadence during an active incident is documented in [`../INCIDENT_RESPONSE.md`](../INCIDENT_RESPONSE.md) §"During the incident": the IC decides what gets done, a scribe posts stakeholder updates every 10–15 minutes on a fixed cadence with a factual no-speculation tone.

The communications tree for who gets notified when:

| Severity | Who is told                                     | When                          |
| -------- | ----------------------------------------------- | ----------------------------- |
| SEV3     | On-call engineer + the IC                       | When the issue is identified. |
| SEV2     | + CTO, + the team Slack channel                 | Within 1 hour.                |
| SEV1     | + CEO, + every engineer on the team             | Within 30 minutes.            |
| SEV0     | + Legal counsel (if engaged), + compliance lead | Immediately, in parallel.     |

Updates continue on the 10–15 minute cadence until mitigation. After mitigation, a wrap-up message states the current state and the next action.

### 4.2 External communications — customers

Customer notifications for incidents affecting their tenant are sent by the CTO or the CTO's delegate. The content rule is the same as the internal scribe rule: factual, no speculation, no premature root-cause assertions. The default cadence is:

- An initial notification within four hours of confirming customer impact for SEV1 / SEV0 events.
- A status update within 24 hours.
- A post-incident summary within five business days, drawn from the postmortem.

Customer notifications for PHI exposure follow the HIPAA Breach Notification Rule path (§5 below), not the general status-update path.

### 4.3 External communications — vendors

Where the incident involves a vendor's system, the vendor's incident channel (status page, support portal, security contact) is the primary channel. Pharmax pulls vendor status into the incident channel via the scribe.

### 4.4 External communications — regulators and law enforcement

Regulatory notification is the CTO's responsibility, supported by legal counsel where engaged. The CEO is informed before any regulatory notification is sent.

Law-enforcement engagement (e.g. ransomware events, suspected criminal conduct) is decided by the CEO with input from legal counsel. The decision is recorded in the incident channel.

### 4.5 Press and public communications

Public statements about an incident are issued only by the CEO or a designated communications lead. Engineers and operators do not make public statements about incidents — including on personal social channels — until the response is closed and the CEO has approved the message. The reason is not censorship; it's that early-incident facts are usually wrong and an unintended public commitment from an engineer's personal account can become a regulatory or contractual exposure.

## 5. Regulatory notification obligations

### 5.1 HIPAA — Pharmax as Business Associate

Pharmax processes PHI under BAAs with our pharmacy customers. When a breach of unsecured PHI affects customer data, our BA-side obligation under **45 CFR § 164.410** is to notify the affected covered entity **without unreasonable delay and in no case later than 60 calendar days** from the discovery of the breach. The notification includes:

- Identification of each individual whose PHI has been (or is reasonably believed to have been) accessed, acquired, used, or disclosed during the breach.
- The information the covered entity needs for its own notification under 45 CFR § 164.404.

In practice, we aim to notify the covered entity **within 24 hours of confirmation** for any incident involving PHI exposure of any volume, not at the 60-day statutory limit. The customer is the covered entity and has their own downstream obligations — they cannot meet them if we delay.

A "breach" for these purposes is the acquisition, access, use, or disclosure of PHI in a manner not permitted under the Privacy Rule which compromises the security or privacy of the PHI. The encryption posture documented in [`../security/encryption-overview.md`](../security/encryption-overview.md) is relevant: PHI rendered unreadable by encryption that meets the HHS specification is **not** unsecured PHI, and a disclosure of encrypted ciphertexts (without the keys) does not trigger the breach notification rule. The CTO consults with legal counsel before classifying any disclosure as not-a-breach on this basis.

Bringing in the individual-notification timeline under 45 CFR § 164.404: the covered entity (the pharmacy customer) is the party that notifies affected individuals, not Pharmax. Pharmax supplies the information the customer needs to do so.

### 5.2 State breach notification laws

Many US states have breach-notification statutes that apply on top of HIPAA. Notification timelines and content requirements vary. Where state law applies, the CTO works with legal counsel to identify the obligation and meet it.

State notifications are tracked separately from HIPAA notifications in the incident postmortem under the compliance-notes section.

### 5.3 Other regulators

If the incident involves payment-card data (Stripe), the CTO works with Stripe's incident program and any applicable PCI obligations. Pharmax does not handle raw payment-card data directly — Stripe is the processor — so the surface here is narrow.

If the incident involves a state board of pharmacy or another regulator that the customer is required to notify, Pharmax cooperates with the customer's notification by providing factual information about the incident.

## 6. Evidence preservation

The integrity of the audit chain (ADR 0006), the command log, the order-event stream, the outbox, and the Sentry / log aggregator history is essential to incident response and to regulatory cooperation. Evidence preservation rules:

- **Do not edit production data without a corresponding `command_log` + `audit_log` entry.** Period. Restated from [`../INCIDENT_RESPONSE.md`](../INCIDENT_RESPONSE.md) §"What we never do".
- **Do not run `prisma migrate resolve` to "clean up" after a failed migration.** Investigate the partial state first; resolution is forensic before it is operational.
- **Do not disable RLS to "investigate faster".** Use the `pharmax_system` role inside a documented session per [Access Control Policy](./access-control-policy.md) §5.7 and `../OBSERVABILITY.md` §"Layer 4 — operational tables".
- **Do not delete or modify log files, Sentry events, or audit rows after an incident is identified.** The retention floor for incident-relevant evidence is six years per HIPAA 45 CFR § 164.530(j). In practice we retain operational logs longer where the volume is manageable.
- **Capture screenshots and saved queries inside the incident channel.** The channel itself is part of the evidence pack; we export it to `evidence/incidents/<YYYY>/<incident-id>/` at incident close.

If an incident involves a suspected criminal act, evidence preservation includes preserving the original logs, audit rows, and any artifacts the investigation would require, without modification. The CTO consults with legal counsel before any action that could alter the evidence base.

## 7. Postmortem cadence

Per [`../INCIDENT_RESPONSE.md`](../INCIDENT_RESPONSE.md) §"After the incident", a blameless postmortem is published **within 48 hours of mitigation** for every SEV0, SEV1, and SEV2 incident, and at the IC's discretion for SEV3.

Policy-level requirements on top of the runbook's template:

- **Action items are tracked to closure.** A postmortem with open action items remains "open" in the incident tracker until the items are resolved.
- **Compliance notes are mandatory** for SEV0 and SEV1 incidents. They cover PHI exposure (yes/no, what, who, how long), notification obligations triggered, evidence captured, and the regulatory timer reset point.
- **Cross-incident pattern review.** The CTO reviews postmortems quarterly for recurring patterns; recurring patterns become risks in the [risk register](../governance/risk-register.md).
- **Customer-shared summary** for SEV0 / SEV1 incidents affecting customer data: the postmortem is distilled into a customer-facing summary by the CTO and shared with affected customers within five business days.

Postmortems are archived in `evidence/incidents/<YYYY>/<incident-id>/postmortem.md`.

## 8. Drill cadence

Incident-response drills are conducted at least **annually**, more frequently for new or high-risk scenarios. The annual program includes at minimum:

- One **tabletop exercise** simulating a SEV0 (cross-tenant data leak or PHI exfiltration). Walk through the response with the team. Document the time-to-classify, time-to-contain, time-to-notify-customer, and the decisions made along the way.
- One **technical drill** of a runbook procedure. The 2026 candidate procedures include:
  - The KMS data-key rotation procedure once `AwsKmsAdapter` lands.
  - The restore-from-backup procedure against a staging-tier RDS snapshot, measuring against the RTO and RPO in [BCP/DR](./business-continuity-and-disaster-recovery.md).
  - The break-glass `pharmax_system` access flow.
- One **vendor-outage exercise**. Pick a vendor (Stripe, EasyPost, Clerk), pretend they're offline, walk through the degradation behavior, and confirm the on-call playbook is intact.

Drill outputs are documented in `evidence/drills/<YYYY>/<drill-id>/` and fed into the [risk register](../governance/risk-register.md) where they identify a gap.

The drill schedule is set at the start of each year by the CTO and tracked alongside the quarterly access reviews.

## 9. On-call posture

The runbook's [`../INCIDENT_RESPONSE.md`](../INCIDENT_RESPONSE.md) §"On-call expectations" sets the current posture: the rotation is informal while the team is small (~5 engineers), with primary + secondary weekly rotation formalizing as the team grows.

Policy-level expectations:

- On-call SLOs: SEV0 ack < 5 min, SEV1 ack < 15 min, SEV2 ack < 1 hr.
- Handoff at the start of each rotation — review open incidents, ongoing concerns, recent deploys.
- The on-call engineer has authority to invoke any emergency-change procedure from the [Change Management Policy](./change-management-policy.md) §4, including rolling back a deploy, scaling workers to zero, or pulling a feature flag.
- Compensation for on-call hours per the company on-call policy (separate document, owned by HR/People).

## 10. Communications during an incident — special rules

These overlap with §4 but are restated here for emphasis:

- **No PHI in the incident channel.** Reference patients by `patient_id` and orders by `order_id`. The incident channel is treated as Confidential, not Restricted, and PHI in it is a separate disclosure event.
- **No screenshots of the operator console with patient data visible.** If a screenshot is needed for investigation, scrub the PHI first or use a UI element identifier in text form.
- **No customer name in the channel name.** Incident channels are named `inc-<YYYY-MM-DD>-<short-handle>` (e.g. `inc-2026-05-25-stripe-webhook-replay`). The affected tenant is identified inside the channel by `organizationId` or by an internal customer identifier, not by name.

## 11. Cross-references

- [`../INCIDENT_RESPONSE.md`](../INCIDENT_RESPONSE.md) — the operational runbook. Always read first.
- [`../RUNBOOK.md`](../RUNBOOK.md) — procedure recipes referenced during response.
- [`../OBSERVABILITY.md`](../OBSERVABILITY.md) — where to look during the first five minutes.
- [Information Security Policy](./information-security-policy.md) — parent.
- [Business Continuity and Disaster Recovery Policy](./business-continuity-and-disaster-recovery.md) — the availability counterpart to this policy.
- [Change Management Policy](./change-management-policy.md) — emergency-change procedure.
- [Vendor Management Policy](./vendor-management-policy.md) — vendor-side incident handling.
- HIPAA 45 CFR § 164.308(a)(6), § 164.404, § 164.410, § 164.530(j).

## Revision history

| Version | Date       | Author | Change           |
| ------- | ---------- | ------ | ---------------- |
| 0.1     | YYYY-MM-DD | CTO    | Initial drafting |
