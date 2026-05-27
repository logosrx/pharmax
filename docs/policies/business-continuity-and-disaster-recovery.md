# Business Continuity and Disaster Recovery Policy

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

This policy states how Pharmax keeps the prescription workflow running through outages, what data we can lose without harming patient safety, what we can lose without losing money, and how we restore service after a disruption. It is the management-system parent of the [`../RUNBOOK.md`](../RUNBOOK.md) procedures (restoring from backup, rolling back a deploy, draining the outbox) and the operational complement of the [Incident Response Policy](./incident-response-policy.md).

This policy maps to:

- SOC 2 **A1 — Availability** (A1.1 management of availability commitments, A1.2 environmental protections, A1.3 recovery).
- SOC 2 **CC9.1** — risk mitigation.
- HIPAA **45 CFR § 164.308(a)(7)** — contingency plan, including data backup plan (§ (i)(A)), disaster recovery plan (§ (i)(B)), emergency-mode operation plan (§ (i)(C)), testing and revision procedures (§ (ii)(D)), and applications and data criticality analysis (§ (ii)(E)).

## 2. Scope

This policy covers the Pharmax production environment — the operator console (`apps/web`), the worker (`apps/worker`), the print agent (`apps/print-agent`), the PostgreSQL database, and the AWS-managed dependencies they rely on.

It also covers the operational dependencies that Pharmax relies on but does not run (Clerk, Stripe, EasyPost, FedEx, UPS, Sentry, Datadog or Honeycomb, Resend), to the extent that an outage at one of those vendors affects Pharmax's ability to deliver the workflow.

It does not cover Pharmax customer-side infrastructure (the pharmacy's own systems, the physical pharmacy, the workstation, the printer hardware). Customer-side BCP/DR is the customer's responsibility; Pharmax provides the runbook for the integration boundary.

## 3. Recovery objectives

### 3.1 Recovery Time Objective (RTO) — 4 hours

Pharmax targets restoration of the order workflow to a fully operational state **within 4 hours** of the start of a disaster-class disruption (production database unavailable, primary AWS region failure, fatal application bug requiring a roll-forward fix).

The 4-hour target is justified by:

- The RDS PITR mechanism produces a restored instance within minutes for a single-database scenario; the dominant cost in a 4-hour budget is verification and cutover, not the restore itself.
- The pharmacy operating day permits a brief window of degraded service (operators continue manual workarounds, orders queue) without missing same-day shipping deadlines for the majority of orders. A 4-hour RTO keeps Pharmax inside that window for most events.
- A 4-hour target lets us absorb the second-order steps (rotate secrets if compromise is suspected, replay outbox items, reconcile Stripe webhooks) without compressing them.

A disruption that exceeds the 4-hour RTO is treated as a SEV0 escalation event and triggers an executive review post-incident.

### 3.2 Recovery Point Objective (RPO) — 5 minutes

Pharmax targets **maximum 5 minutes of data loss** in a disaster-class restore. This is justified by:

- AWS RDS automated backups plus point-in-time recovery (PITR) provide a continuous-recovery window with sub-minute granularity in the typical case.
- The cost of a tighter RPO — e.g. synchronous cross-region replication — is not justified at our current scale or against our current single-region posture. ADR 0022 (Proposed) will revisit this when multi-region tenancy lands.
- A 5-minute RPO bounds the volume of in-flight work that would need to be recreated post-restore. Typing workstations cache the in-progress entries client-side for short windows; PV1 and Final Verification decisions are point-in-time events whose loss is recoverable by re-execution.

A real-world disaster restore is verified against the RPO by checking the most recent `command_log` and `audit_log` entries in the restored instance: the gap to the disruption time is the achieved RPO. A drill that exceeds the RPO target is recorded as a finding and the recovery procedure is hardened.

### 3.3 Maximum Tolerable Downtime (MTD) — 24 hours

Beyond 24 hours of unavailability, the cumulative impact (delayed patient shipments, missed billing, customer trust) crosses into the territory of "we are damaging the product's value proposition". Restoration plans assume the MTD is not exceeded; an event projected to exceed MTD triggers an executive decision on temporary degradation alternatives (e.g. manual-workflow standup with downstream backfill).

## 4. Critical functions

The functions ranked by criticality:

### 4.1 Tier 1 — patient-safety critical

These functions cannot be down for an extended period without risk to patient outcomes.

- **The order workflow.** Typing → PV1 → Fill → Final Verification → Ready to Ship → Shipped, with the workflow-safety guarantees codified in `.cursor/rules/01-workflow-safety.mdc`.
- **The audit chain** (ADR 0006). The chain must continue to be writable. If the chain writer cannot reach the database, new orders cannot progress through transitions. Recovery prioritizes the audit-chain integrity check (`../RUNBOOK.md` §"Audit chain integrity check") as the first verification step after a restore.
- **Authentication via Clerk.** Operators must be able to sign in. Without Clerk, the operator console is inaccessible. Clerk runs at higher availability than Pharmax can supply itself; we monitor their status page and have a documented degradation plan (§5.2).

### 4.2 Tier 2 — financial-critical

- **Payments via Stripe.** Invoice push and refund issuance. Stripe outage delays billing but does not halt the workflow.
- **Shipping via EasyPost / FedEx / UPS.** Label purchase and shipment confirmation. Shipping outage prevents Ready-to-Ship → Shipped transitions but does not break upstream typing / PV1 / fill / final verification work.

### 4.3 Tier 3 — operational and analytical

- **Observability** (Sentry, Datadog or Honeycomb). Loss of observability is a SEV2: we lose the ability to detect and respond efficiently, but the workflow itself continues.
- **Notifications** (Resend or equivalent). Lost notifications can be reconstructed from the outbox once service returns.
- **Reporting and dashboards.** Stale dashboards do not affect the patient workflow.

## 5. Dependencies

### 5.1 Self-operated dependencies

- **AWS RDS** (PostgreSQL): the transactional source of truth. Multi-AZ enabled. Automated backups + PITR for the RPO target.
- **AWS KMS** (customer-managed keys for envelope encryption per ADR 0005). Without KMS, no PHI decrypt — the operator console can render but only on cached decrypts. KMS itself is highly available; loss of access to the KEK is the failure mode (e.g. a misconfigured policy), addressed by the KMS rotation runbook.
- **AWS S3** (documents, scans, labels). High durability; an outage prevents new uploads but reads from existing objects are typically unaffected at the AZ level.
- **AWS Secrets Manager** (runtime secrets). High availability; an outage prevents secret retrieval at service start. The pattern is "fail to start", so a running service survives a Secrets Manager outage.
- **AWS ECS / Fargate** (compute for `apps/web`, `apps/worker`). Multi-AZ.
- **AWS CloudWatch** (logs). Loss is an observability event, not a workflow event.
- **The Pharmax application code** in our GitHub repository, deployable via the standard pipeline.

### 5.2 Vendor dependencies — degradation matrix

| Vendor                     | If unavailable, Pharmax can…                                                                                                                                                | Maximum tolerated outage before customer impact               |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **Clerk**                  | Existing sessions remain valid through their TTL. New sign-ins are blocked. The operator console is read-only for unauthenticated visitors (zero, by design).               | 1 hour before operators report impact.                        |
| **Stripe**                 | Continue the operational workflow. Defer invoice push and refund issuance to the outbox. Webhook arrivals queue at Stripe's side for replay.                                | 4 hours before billing reconciliation gaps surface.           |
| **EasyPost / FedEx / UPS** | Continue typing / PV1 / fill / final verification. Defer label purchase. Carrier-side outages may force orders to remain at Ready-to-Ship until carrier recovery.           | 2 hours before same-day shipping cadence is at risk.          |
| **Sentry**                 | Continue all workflow functions. We lose centralized error capture; logs remain in CloudWatch as a backstop.                                                                | Indefinite; observability degradation only.                   |
| **Datadog / Honeycomb**    | Continue all workflow functions. We lose dashboards and alert routing; CloudWatch retains raw logs.                                                                         | Indefinite; observability degradation only.                   |
| **Resend** (or equivalent) | Continue all workflow functions. Notifications queue in the outbox; recipients receive on service restore. No notifications dropped.                                        | Indefinite; notification delay only.                          |
| **GitHub**                 | Continue all production workflow. We lose the ability to deploy new code and to read source for incident investigation. Local clones cover the latter for the on-call team. | 4 hours before deploy capability becomes an incident concern. |

The "maximum tolerated outage" column is the threshold at which the CTO triggers an explicit decision on degradation alternatives, customer notification, or escalation to the vendor.

## 6. Failover scenarios

### 6.1 AZ failure

AWS RDS Multi-AZ provides automatic failover within minutes for an Availability Zone failure. Pharmax's ECS / Fargate services are deployed across at least two AZs, so a single-AZ failure is absorbed by the load balancer without customer-visible disruption beyond a brief connection blip.

The expected RTO for an AZ failure is **under 15 minutes**, well inside the 4-hour disaster RTO. The expected RPO is **near zero** because the standby RDS replica is current.

Verification: synthetic monitors should be back to green within 15 minutes. The incident is recorded but does not necessarily generate a customer notification unless customer impact is observed.

### 6.2 Region failure

A full AWS region failure is **out of scope** for the current single-region architecture. The mitigation is documented in ADR 0022 (Proposed) — multi-region tenancy. Until that work lands:

- The expected RTO for a full-region failure is **longer than 4 hours**. The recovery path is to bring up a new environment in a secondary region from backups and re-attach DNS. This is acknowledged as a residual risk in the [risk register](../governance/risk-register.md).
- During a region failure, the CTO communicates the projected MTD to customers within one hour and provides updates per the [Incident Response Policy](./incident-response-policy.md) §4.2.
- An executive decision on whether to attempt cross-region restore, wait for AWS recovery, or stand up a manual-workflow alternative is made within two hours.

The multi-region project (ADR 0022) is the planned mitigation; the [risk register](../governance/risk-register.md) carries this as a high-impact medium-likelihood item until that ADR is implemented.

### 6.3 Vendor outage

For each vendor in §5.2, the runbook entry covers what to do during the outage. The general pattern:

1. Confirm the outage at the vendor's status page.
2. Pause the affected outbox dispatcher (e.g. `STRIPE_DRAIN_ENABLED=false` for a Stripe outage) so retries don't burn attempts. Don't `SKIP` rows; let them queue.
3. Communicate to affected customers if the outage exceeds the tolerance in §5.2.
4. When the vendor restores, re-enable the dispatcher. Watch the catch-up rate.
5. Reconcile any rows whose `attempts` exceeded the threshold during the outage. The runbook section for the specific vendor covers the reconciliation procedure.

### 6.4 Compromise event

A confirmed credential compromise or PHI exfiltration triggers the [Incident Response Policy](./incident-response-policy.md) at SEV0. BCP/DR considerations specific to a compromise:

- Forced password rotation across the affected scope.
- KMS key rotation if KEK compromise is suspected (the rotation procedure is in `../RUNBOOK.md` §"Rotating a KMS data key").
- Tenant-scoped read-only mode if necessary to contain ongoing exfiltration.

The compromise-recovery RTO target is also 4 hours, but the recovery surface is broader (revoke sessions, rotate secrets, audit recent activity) than a pure availability event.

### 6.5 Ransomware

Ransomware against Pharmax infrastructure is extremely unlikely in our managed-AWS posture (no on-premise file servers, no Windows endpoints in the production path, no SMB or RDP exposed to the internet). The residual concern is ransomware against workstations that hold Pharmax credentials.

The defense:

- The [Acceptable Use Policy](./acceptable-use-policy.md) §4 (encryption + lock screen + OS currency) bounds blast radius on a workstation.
- 1Password vault data is recoverable; the vault is the credential store.
- AWS backups are point-in-time and not deletable by application credentials. A ransomware payload that runs as a Pharmax application identity cannot corrupt the backup snapshots.
- The runbook restore procedure (`../RUNBOOK.md` §"Restoring from backup") is the recovery path; the RTO target is the same 4 hours.

## 7. Data backup plan

Per HIPAA 45 CFR § 164.308(a)(7)(ii)(A), the data backup plan:

- **PostgreSQL**: AWS RDS automated backups with PITR. Retention 35 days (the AWS maximum for automated backups) plus weekly manual snapshots retained for 90 days. All snapshots are encrypted at rest with KMS.
- **S3 objects** (documents, scans, labels): versioning enabled, lifecycle policy retains prior versions for 90 days, replication to a secondary US region for highly durable objects.
- **Application code**: GitHub plus local clones. The deploy pipeline can rebuild from any tagged commit.
- **Infrastructure code** (Terraform): in the same GitHub repo. The state file is backed by an S3 bucket with versioning enabled and a DynamoDB lock table.
- **Secrets**: AWS Secrets Manager retains prior versions for 30 days after rotation; 1Password retains version history for vault items.

Restore procedure: `../RUNBOOK.md` §"Restoring from backup". Restore is tested quarterly per §8 below.

## 8. Drill cadence

BCP/DR drills are conducted at least **quarterly**, with at least one annual full-procedure drill that exercises the disaster restore against the RTO and RPO targets.

The quarterly drill schedule:

- **Q1.** Restore-from-backup drill against a staging tier. Validate RPO and the procedural muscle memory.
- **Q2.** Vendor-outage tabletop. Pick a vendor from §5.2 and walk through the degradation plan.
- **Q3.** KMS rotation drill (once `AwsKmsAdapter` is in production). Rotate a non-production KEK and verify wrapped-DEK survival across the rotation.
- **Q4.** Full-stack failover tabletop. Walk through an AZ failure and a hypothetical region failure scenario. Document the gaps that ADR 0022 implementation will close.

Drill outputs are documented in `evidence/drills/<YYYY>/<drill-id>/`. Drills that identify a gap generate corrective tickets that are tracked to closure and reviewed in the next quarterly access review.

## 9. Emergency-mode operation

Per HIPAA 45 CFR § 164.308(a)(7)(ii)(C), an emergency-mode operations plan covers the procedures the workforce follows during a disruption that prevents normal operations.

For Pharmax, the emergency-mode plan defers to the customer's existing pharmacy procedures: the pharmacy continues to operate using their established manual workflows (paper queue, manual records) and reconciles into Pharmax once service is restored. Pharmax provides:

- A documented reconciliation runbook for operators to bulk-enter work performed in manual mode after the outage ends.
- A "manual mode" support channel staffed by the CTO during a SEV0/SEV1 to coordinate with affected customers.
- Outbox-replay procedures (`../RUNBOOK.md` §"Outbox drain stuck or backed up") to handle the catch-up wave.

The emergency-mode plan is exercised in the Q2 vendor-outage tabletop drill.

## 10. Review and revision

This policy is reviewed annually and after any of:

- A SEV0 or SEV1 incident that exercises the BCP/DR plan.
- A change in the production architecture (multi-region rollout, new critical vendor, change in the database posture).
- A change in the customer SLA commitments (a customer contract that tightens our RTO or RPO).
- A quarterly drill that surfaces a procedural gap.

Revisions are approved by the CEO and recorded in the revision history.

## 11. Cross-references

- [Information Security Policy](./information-security-policy.md) — parent.
- [Incident Response Policy](./incident-response-policy.md) — sibling for compromise and security events.
- [Change Management Policy](./change-management-policy.md) — emergency-change procedure during recovery.
- [`../RUNBOOK.md`](../RUNBOOK.md) — procedural recipes (restore, KMS rotate, outbox drain, audit chain check).
- [`../INCIDENT_RESPONSE.md`](../INCIDENT_RESPONSE.md) — first-responder mechanics.
- [Vendor Management Policy](./vendor-management-policy.md) — vendor degradation matrix detail.
- ADR 0004 — Multi-tenancy via Postgres RLS (data partitioning posture).
- ADR 0005 — Envelope encryption (the KMS dependency).
- ADR 0006 — Hash-chained audit log (the audit-chain dependency).
- ADR 0022 (Proposed) — Multi-region tenancy.
- HIPAA 45 CFR § 164.308(a)(7).

## Revision history

| Version | Date       | Author | Change           |
| ------- | ---------- | ------ | ---------------- |
| 0.1     | YYYY-MM-DD | CTO    | Initial drafting |
