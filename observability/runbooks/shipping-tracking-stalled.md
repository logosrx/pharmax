# Runbook: Shipping tracking stalled / EXCEPTION bucket growing

> Triggered by: `ShippingPollFailingForCarrier`, `ShippingExceptionBucketGrowing`.

## Symptoms

- Grafana **Shipping & Tracking** dashboard: carrier poll failure ratio
  > 10% for `<carrier>` over 15m.
- EXCEPTION bucket size growing or stuck above 25 for more than 30
  minutes.
- Operators report "shipments not updating" in the UI.

## Likely causes

1. **Carrier API outage.** FedEx / UPS / EasyPost down — usually all
   tenants affected on the same carrier.
2. **Credential rotation gone wrong.** A tenant's carrier API key was
   rotated incorrectly; the old key was disabled before the new one
   was registered.
3. **Rate limit.** Sustained polling above the carrier's quota. The
   `skippedNoStatus` counter will rise alongside `failed`.
4. **Worker drain not running.** `fedex-tracking-poller` or
   `ups-tracking-poller` is not ticking.
5. **EasyPost webhook inbox stuck.** Webhook events recorded but not
   drained by `easypost-webhook-event-drainer`.

## Investigation

1. Open Grafana **Shipping & Tracking** dashboard. Identify the
   affected `carrier` and observe the failure ratio over the last 24h
   to spot regressions vs steady-state.
2. Confirm carrier-side status — vendor status pages:
   - FedEx Developer Status
   - UPS Developer Portal Status
   - EasyPost Status (https://status.easypost.com/)
3. Check worker log activity for the poller:

   ```bash
   {service="pharmacy-worker"} |= "fedex-tracking-poller" or |= "ups-tracking-poller"
   ```

   Look for `tick.complete` rows. If they're not appearing, the loop
   is dead — check Sentry for a boot exception in the worker.

4. Check carrier credential table (read-only DBA session):

   ```sql
   SET LOCAL pharmax.organization_id = '<org-uuid>';

   SELECT id, organization_id, provider, status, created_at, disabled_at,
          envelope_id, last_use_at
   FROM   carrier_credential
   WHERE  provider = 'FEDEX'   -- or 'UPS' or 'EASYPOST'
   ORDER  BY created_at DESC
   LIMIT  5;
   ```

   Confirm exactly one ACTIVE row per (org, provider).

5. For the EXCEPTION bucket, list the affected shipments:

   ```sql
   SELECT s.id, s.tracking_number, s.carrier, s.status,
          s.last_tracked_at, b.kind AS bucket_kind
   FROM   shipment s
   JOIN   bucket_membership bm ON bm.shipment_id = s.id
   JOIN   bucket b              ON b.id = bm.bucket_id
   WHERE  b.kind = 'SHIPPING_EXCEPTION'
     AND  s.organization_id = '<org-uuid>'
   ORDER  BY s.last_tracked_at DESC
   LIMIT  50;
   ```

## Mitigation

- **Carrier outage** — wait. Do nothing. The poller is idempotent and
  picks up where it left off when the carrier returns.
- **Credential issue** — rotate per
  [`docs/RUNBOOK.md` → "Rotating a carrier credential"](../../docs/RUNBOOK.md#rotating-a-carrier-credential).
  Use the `RegisterCarrierCredential` command — never UPDATE the row in
  place.
- **Rate limit** — temporarily reduce poll cadence. The poller config
  reads `SHIPPING_POLLER_INTERVAL_MS` from env; bump to back off. Open a
  ticket with the carrier to raise the quota.
- **Worker drain not running** — restart the worker. If it crash-loops
  see Sentry.
- **EasyPost inbox stuck** — query the inbox:

  ```sql
  SELECT status, count(*) FROM easypost_webhook_event GROUP BY status;
  ```

  If `PENDING` count is climbing, the drainer is not running. Restart
  the worker.

## Escalation path

- `warning` for 1h with no improvement → ticket on-call.
- Operations director if the EXCEPTION bucket > 100 (customer-impacting).
- Carrier outage that lasts > 1h: notify customer success.

## Post-mortem

Not required for vendor outages unless customer-facing impact > 1h.
Required for any incident where the chain `auth → DB → poller` broke
internally (we own that path; we are accountable for it).
