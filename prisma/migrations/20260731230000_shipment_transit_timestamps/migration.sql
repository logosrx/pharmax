-- migration: 20260731230000_shipment_transit_timestamps
--
-- Every order must carry the time its package took from carrier
-- pickup to delivery. The shipment row (1:1 with the order) gains
-- three columns, maintained by RecordShipmentTrackingEvent from the
-- carrier scan ledger regardless of which channel (AIV webhook or
-- Track API poll) delivered the scan:
--
--   pickedUpAt     — occurredAt of the EARLIEST movement scan
--                    (IN_TRANSIT / OUT_FOR_DELIVERY kinds). Min
--                    semantics: a backfilled earlier scan pulls the
--                    pickup time back; later scans never push it
--                    forward.
--   deliveredAt    — occurredAt of the EARLIEST DELIVERED scan (the
--                    physical delivery moment, not the poll time and
--                    not `lastTrackingEventAt`, which post-delivery
--                    events can advance).
--   transitSeconds — deliveredAt - pickedUpAt, recomputed whenever
--                    either endpoint changes. Persisted (not
--                    view-computed) so order-level queries, exports,
--                    and partner API payloads can read it without
--                    date math. NULL until both endpoints are known;
--                    never negative (clock-skew pairs are left NULL).
--
-- No RLS change needed: shipment already carries ENABLE + FORCE row
-- level security; new columns inherit the table's policies.

ALTER TABLE "shipment" ADD COLUMN "pickedUpAt" TIMESTAMP(3);
ALTER TABLE "shipment" ADD COLUMN "deliveredAt" TIMESTAMP(3);
ALTER TABLE "shipment" ADD COLUMN "transitSeconds" INTEGER;
