# Runbook: Command bus failures

> Triggered by: `CommandBusErrorRateHighWarning`, `CommandBusErrorRateHighCritical`,
> `CommandBusConcurrencyRetryStorm`, `HighP99HttpLatency`, `High5xxErrorRate`,
> `HighEventLoopLag`, `HighMemoryUsage`, `PgPoolSaturated`.

## Symptoms

- Operators report commands failing in the UI ("Save failed", "Could not start typing").
- Sentry "issues" panel for `pharmacy-os` / `pharmacy-worker` lights up.
- Grafana **Command Bus** dashboard shows error ratio rising; one or more
  `command_name` series are red.
- p99 HTTP latency rising on **Platform Health**; pool saturation > 90%.

## Likely causes (ordered by recency)

1. **Bad release.** A recent deploy introduced a regression. Check the
   Sentry release filter — does the error appear only on the latest SHA?
2. **Datastore degradation.** Postgres primary CPU > 85%, replication lag,
   or pool exhaustion. Common after a long-running query landed.
3. **External dependency outage.** Stripe / EasyPost / FedEx / KMS down.
   Look for one command (e.g. `RegisterCarrierCredential`) failing while
   the rest are healthy.
4. **CAS retry storm.** A thundering herd is mutating the same row. The
   `CommandBusConcurrencyRetryStorm` alert isolates this.
5. **Hot path CPU.** Sync `JSON.parse` of a large payload, sync crypto,
   or unbounded loop on the request thread. `HighEventLoopLag` fires.

## Investigation

1. Open Grafana **Command Bus** dashboard. Identify the failing
   `command_name`. Note the `outcome` distribution (validation_error,
   sod_rejected, error).
2. Open Sentry. Filter by `command:<command_name>`. Inspect the top
   exception's stack and `correlationId`.
3. SQL into the live primary (read-only session). Replace
   `<correlation-id>` with the value from Sentry:

   ```sql
   SET LOCAL pharmax.system_context = 'on';

   SELECT id, organization_id, command_name, status,
          attempts, idempotency_key, completed_at, error_message
   FROM   command_log
   WHERE  correlation_id = '<correlation-id>'
   ORDER  BY started_at DESC
   LIMIT  20;
   ```

4. Check pool saturation on Platform Health → "Postgres pool
   utilization". If > 90%, find the long-running query:

   ```sql
   SELECT pid, now() - query_start AS duration, state, query
   FROM   pg_stat_activity
   WHERE  state = 'active'
   ORDER  BY duration DESC
   LIMIT  10;
   ```

5. If `HighEventLoopLag` fired, profile with the `--cpu-prof` flag in
   the next deploy (or attach `clinic.js` to a long-running worker).

## Mitigation

- **Bad release** — roll back to the last-known-good SHA. See
  [`docs/RUNBOOK.md` → "Rolling back a deploy"](../../docs/RUNBOOK.md#rolling-back-a-deploy).
- **External dependency** — wait. Confirm via vendor status page. Do not
  retry storms — the outbox already retries with exponential backoff.
- **CAS retry storm** — find the source. Usually a worker drain that
  fans out to one row. Throttle the source.
- **Pool saturation** — `pg_cancel_backend(pid)` the offending query
  (read-only DBA session). Ship the index fix in a hotfix.
- **Hot path CPU** — move sync work to a worker, or behind an async
  boundary. Ship hotfix.

## Escalation path

- `warning` for 30m → ticket to on-call team.
- `critical` immediately → page on-call via PagerDuty. If the bus is
  > 5% errors for 5m, pharmacy operations are blocked — declare SEV1.
- Customer-impacting outage → notify status page channel.

## Post-mortem

Use the template at [`docs/INCIDENT_RESPONSE.md`](../../docs/INCIDENT_RESPONSE.md).
Required for any SEV1 or any incident lasting > 30 minutes.
