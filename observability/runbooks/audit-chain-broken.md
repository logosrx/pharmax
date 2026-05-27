# Runbook: Audit chain broken / Merkle manifest stale

> Triggered by: `AuditChainVerifierFailing`, `AuditManifestStale`.
> **Severity: SEV1 by default.** This is a compliance event.

## Symptoms

- `pharmax_audit_verifier_failures_total` rising for one or more
  `organization_id` values.
- `time() - pharmax_audit_manifest_latest_signed_at_seconds > 26 * 3600`
  for one or more tenants.
- Nightly security digest email (`digest.published` log event in worker)
  reports `brokenChains > 0`.

## Likely causes

1. **Out-of-band DB mutation.** Someone wrote to `audit_log` outside the
   command bus, breaking the prev-hash chain. This is the worst case —
   it's evidence that the bus contract was bypassed.
2. **Schema drift.** A migration altered `audit_log` columns in a way
   the encoder did not anticipate, producing a hash mismatch.
3. **KMS failure** (manifest only). Daily Merkle signing failed because
   the signing key is disabled, the IAM role drifted, or the loop
   crashed. The chain itself is fine; the signature is just missing.
4. **Scheduler stopped.** `daily-merkle-root-loop` is not running in the
   worker (deploy regression, container restart loop).

## Investigation

1. Open Grafana **Audit Chain** dashboard. Note the affected
   `organization_id` and the panel that's red (verifier vs manifest age).
2. **For verifier failures** — find the first broken row:

   ```sql
   SET LOCAL pharmax.system_context = 'on';

   -- The verifier writes the first failing seq to audit_chain_state
   -- when it tries to advance the cursor and bails.
   SELECT organization_id, last_verified_seq, last_verified_at,
          last_failure_seq, last_failure_reason
   FROM   audit_chain_state
   WHERE  organization_id = '<org-uuid>';
   ```

   Then read the row at the failing seq:

   ```sql
   SELECT id, seq, organization_id, event_kind, actor_user_id,
          encode(prev_hash, 'hex') AS prev_hash,
          encode(hash, 'hex')      AS hash,
          created_at
   FROM   audit_log
   WHERE  organization_id = '<org-uuid>'
   ORDER  BY seq
   OFFSET <failing_seq - 2>
   LIMIT  5;
   ```

3. **For manifest staleness** — check the worker:

   ```bash
   # In the worker log aggregator
   {service="pharmacy-worker"} |= "merkle.run"
   ```

   Look for `merkle.run.start` without a corresponding
   `merkle.run.complete`, or `merkle.run.complete` with `failed > 0`.

4. Confirm scheduler is alive:

   ```bash
   {service="pharmacy-worker"} |= "merkle" |~ "loop|scheduler"
   ```

## Mitigation

- **Out-of-band mutation (true chain break)** — this is a SEV1.
  1. Snapshot the affected tenant immediately (use the managed-DB
     point-in-time-restore feature; do NOT pg_dump).
  2. File a SEV1 ticket and start the IR playbook
     ([`docs/INCIDENT_RESPONSE.md`](../../docs/INCIDENT_RESPONSE.md)).
  3. Do NOT attempt to "repair" the chain. The break is the evidence.
  4. Notify the privacy officer; HIPAA breach assessment may be
     required depending on what was mutated.
- **Schema drift** — check Prisma migration history. If a migration
  changed `audit_log` shape, write a forward-only migration to
  re-encode the affected rows. Coordinate with the encoder unit tests
  in `packages/audit/src/chain/encoder.test.ts`.
- **KMS failure** — see [`kms-misconfig.md`](./kms-misconfig.md).
  Once KMS is healthy, the next scheduled run will sign a fresh manifest.
- **Scheduler stopped** — restart the worker. If it crash-loops, see
  Sentry for the boot exception.

## Escalation path

- Page on-call immediately on `AuditChainVerifierFailing`. Stack with
  privacy officer once cause is "true chain break".
- `AuditManifestStale` is critical but rarely needs immediate paging —
  triage during business hours unless it correlates with KMS errors.

## Post-mortem

Mandatory for any verifier failure. Use the IR template; include the
encoded prev-hash chain around the break in the timeline section.
