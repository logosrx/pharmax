# Incident Response

How we respond when something goes wrong. The shorter version: **stay calm, follow the runbook, write the postmortem.**

## Severities

| Severity | Definition                                                                                                          | Response time         | Examples                                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **SEV0** | Critical compliance breach. PHI exposed, data exfiltrated, audit chain broken with active write traffic.            | Immediate, all hands. | RLS misconfig leaking patient data to another tenant. Audit chain hash mismatch detected.                                                   |
| **SEV1** | Patient safety or workflow integrity at risk. Workflow safety rule violated, encryption failure, KMS outage.        | < 15 min ack.         | `verifyAuditChain` returns invalid. Encryption rotation deleted the wrong key. A bug allowed `current_status` mutation outside command bus. |
| **SEV2** | Significant operational degradation. >5% of orders breaching SLA, primary DB elevated latency, worker drains stuck. | < 1 hr ack.           | Outbox drain backlog > 1000 rows. EasyPost API unreachable for >30 min. p95 PV1-to-fill spikes 2x.                                          |
| **SEV3** | Degraded experience, no patient impact. Slow page load, non-critical webhook delays, dashboard glitches.            | Next business day.    | Reporting dashboard slow. One clinic's saved view broken.                                                                                   |

When in doubt, **escalate up** — a SEV1 that turns out to be SEV3 is a non-event. A SEV3 that turns out to be SEV1 is a career-defining miss.

## The first 5 minutes

1. **Acknowledge.** Whoever is on call posts in the incident channel: _"I'm investigating [observation]. SEV?-tentative. Updates every 10 min."_
2. **Open Sentry.** Filter by the time window. Look for fingerprints with abnormal volume.
3. **Open the operations dashboard.** Look at error rate, p95 latency, queue depths, outbox backlog.
4. **Check the deploy log.** Was there a release in the last hour? If yes, [roll it back first](RUNBOOK.md#rolling-back-a-deploy), investigate after.
5. **Containment before forensics.** If patient data is at risk, take the surface offline (feature-flag the affected route, scale workers to 0) BEFORE diving into root cause.

## During the incident

- **One person leads.** The Incident Commander (IC) decides what gets done, in what order. Everyone else acts on IC's word.
- **Comms run in parallel.** A second person (the "scribe") posts updates to stakeholders every 10–15 min, on a fixed cadence. Tone: factual, no speculation.
- **Don't make it worse.** Two rules:
  1. Never mutate `order.current_status` directly. Use commands.
  2. Never bypass the command bus to "just fix this one row." If you need to, write a one-shot migration / script that _uses_ the bus.
- **Write down what you're doing in the channel.** Future-you (and the postmortem) need a timeline.

## After the incident

A blameless postmortem within 48 hours of mitigation. Template:

```markdown
# Postmortem: <short description>

- Date: <YYYY-MM-DD>
- Severity: <SEV0 | SEV1 | SEV2 | SEV3>
- Duration: <start>–<end> (UTC)
- Authors: <names>

## Summary

One paragraph: what happened, who noticed, what we did.

## Timeline

UTC timestamps, one event per line. Include detection, triage, mitigation, resolution.

## Root cause

The single thing that, if different, would have prevented this incident.

## What went well

The detection / response steps we want to keep doing.

## What went poorly

Honest assessment. Tone: process-focused, not person-focused.

## Action items

| Item | Owner | Severity | Due |
| ---- | ----- | -------- | --- |

| Concrete, owned, dated.

## Compliance notes (SEV0 / SEV1 only)

- Was PHI exposed? To whom? For how long?
- Notification obligations (HIPAA: 60 days for breaches affecting > 500 individuals).
- SOC 2 evidence to capture.
```

## On-call expectations

Today the on-call rotation is informal (small team). When the team grows past ~5 engineers, formalize:

- Primary + secondary, weekly rotation.
- Pager response SLO: SEV0 ack < 5 min, SEV1 ack < 15 min, SEV2 ack < 1 hr.
- Handoff at the start of each rotation — review open incidents, ongoing concerns, recent deploys.
- Compensation for on-call hours per company policy.

## Reportable events

For SEV0 / SEV1 incidents involving PHI exposure, additional steps:

1. **Within 1 hour:** legal + compliance leads notified internally.
2. **Within 24 hours:** preliminary forensic report (what data, how long, which tenants).
3. **HIPAA Breach Notification Rule:** affected individuals notified within 60 days. Breaches affecting 500+ individuals also notified to HHS and (sometimes) prominent media outlets — see 45 CFR §§ 164.404–408.
4. **SOC 2:** preserve all logs, audit chain state, Sentry events. The auditor will ask for these during the next periodic review.

## What we never do

- **Edit production data without a corresponding `command_log` + `audit_log` entry.** Period.
- **Disable RLS to "investigate faster".** Use the `pharmax_system` role inside a documented session instead.
- **Skip the postmortem because "we know what happened".** The point isn't the analysis — it's the record.
- **Blame an individual.** A blameworthy mistake means the system permitted a single human to break things; the system is what gets fixed.
