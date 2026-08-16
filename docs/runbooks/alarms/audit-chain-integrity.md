# `<prefix>-audit-chain-integrity`

> Commands below use the primary-region prefix `pharmax-prod-ue1`.

## What fired and what it means

- **Metric:** `AuditChainIntegrityFailure` (custom namespace
  `Pharmax/Audit`), Sum. Emitted by the worker's daily audit-chain verifier
  loop (`apps/worker/src/security/audit-chain-verifier-loop.ts`): the
  number of organizations whose hash chain failed verification, `0` on a
  clean run.
- **Threshold:** > 0 in a **single 5-minute period** — any non-zero value
  fires immediately. Missing data does not breach (the verifier is daily;
  most periods have no datapoint).
- **User-visible symptom:** none — and that is the danger. The tamper-evident
  record of who did what to a prescription is broken for at least one
  tenant: either a bug is corrupting the audit log, or someone edited it.
  Both get worse the longer they run unobserved.

Defined in
[`infra/terraform/modules/cloudwatch/main.tf`](../../../infra/terraform/modules/cloudwatch/main.tf)
(`audit_chain_integrity_failure`).

## Severity + who is paged

**Critical** → `pharmax-prod-ue1-alerts-critical` SNS topic → paging
provider + on-call mailbox. The first response (freeze, capture forensics)
is time-sensitive even at 03:00.

## First 5 minutes

1. **Do NOT "fix" anything in the audit tables.** Every row you touch is
   evidence.
2. **Identify the tenant and the first broken sequence number** —
   [RUNBOOK § Audit chain integrity check](../../RUNBOOK.md#audit-chain-integrity-check).
   Capture the output verbatim into the incident record.
3. **Read the verifier's own logs:**

   ```bash
   aws logs start-query --log-group-name /ecs/pharmax-prod-ue1/worker \
     --start-time $(($(date +%s) - 86400)) --end-time $(date +%s) \
     --query-string 'fields @timestamp, @message | filter @message like /audit/ | sort @timestamp desc | limit 50'
   ```

4. **Grafana:** _Pharmax · Audit Chain_ → **“Verifier failures (per minute,
   by tenant)”** names the tenant; **“audit_log rows per second (by
   tenant)”** shows whether writes to that tenant spiked around the break;
   **“Audit chain log events (Loki)”** has the structured trail.
5. **Bound the damage:** check whether the signed Merkle manifest for the
   affected day still verifies —
   [RUNBOOK § Verifying a Merkle manifest from S3](../../RUNBOOK.md#backup-automation--tested-restore).
   Manifests are held under S3 Object Lock COMPLIANCE; a chain break with
   intact manifests bounds the tampering window to after the last signed
   root.

## Likely causes (ranked)

1. **A bug in a code path writing audit rows** — a migration or a new
   feature that bypassed the append-only contract (most common in
   practice).
2. **A restore/drill or migration that rewrote audit rows** in a
   non-production database pointed at the production metric namespace —
   verify which database the verifier read before treating it as real, but
   **verify, never assume**.
3. **Direct manual editing of audit rows** — the scenario the chain exists
   to catch. Treat as a potential insider/security event.

## Mitigations

- **Preserve, don't repair.** No UPDATEs, no re-hashing, no "fixing" the
  chain — bounding and evidence first.
- Freeze write access for the affected tenant only if the security lead
  directs it (human decision — it stops their pharmacy).
- The chain repair itself, if any, happens after forensics under the
  security path — never as an on-call solo action.

## Escalation

**SEV1, immediately, on the SECURITY path** —
[`docs/INCIDENT_RESPONSE.md`](../../INCIDENT_RESPONSE.md) — not the
availability path. "Was this a bug or a person" must be answered by someone
awake, and the answer determines whether this becomes a HIPAA
breach-assessment matter. Paging mechanics: the
[alerting runbook](../alerting.md).

## False-positive notes

- **This is the alarm the quarterly fire drill uses by convention**
  ([alerting runbook § Proving the pipe works](../alerting.md#proving-the-pipe-works)):
  `aws cloudwatch set-alarm-state --alarm-name pharmax-prod-ue1-audit-chain-integrity --state-value ALARM ...`.
  **Check `StateReason` first** — a drill names itself and a ticket. A
  forced state transition does NOT mean the metric was ever non-zero:
  confirm with

  ```bash
  aws cloudwatch get-metric-statistics --namespace Pharmax/Audit \
    --metric-name AuditChainIntegrityFailure --statistics Sum --period 300 \
    --start-time $(date -u -v-24H +%Y-%m-%dT%H:%M:%SZ) --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ)
  ```

- A non-production database emitting into the production namespace (cause
  #2 above) is the only other known benign path — and it still deserves a
  ticket, because the namespace bleed itself is a bug.
