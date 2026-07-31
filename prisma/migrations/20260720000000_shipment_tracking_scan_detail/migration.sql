-- migration: 20260720000000_shipment_tracking_scan_detail
--
-- Full-fidelity FedEx tracking ingestion. Two changes:
--
-- 1. `shipment_tracking_event` gains structured scan-location
--    columns. Until now the carrier's scan location (city / state /
--    country of the sorting facility or delivery stop) was buried
--    inside `rawPayload` JSON, which made "where is this package
--    right now" and location-based reporting impossible without
--    JSON path scans. City-level carrier-facility location is
--    operational logistics data, not PHI; the columns stay out of
--    audit metadata and outbox payloads regardless.
--
-- 2. `shipment` gains `estimatedDeliveryAt` — the carrier's current
--    delivery estimate, refreshed on every applied tracking event.
--    Needed for on-time-vs-estimate reporting and for surfacing
--    "running late" shipments before they become exceptions.
--
-- No RLS change needed: both tables already carry ENABLE + FORCE
-- row level security from the RLS baseline; new columns inherit
-- the table's policies.

ALTER TABLE "shipment_tracking_event" ADD COLUMN "scanCity" TEXT;
ALTER TABLE "shipment_tracking_event" ADD COLUMN "scanStateOrProvince" TEXT;
ALTER TABLE "shipment_tracking_event" ADD COLUMN "scanCountry" TEXT;

ALTER TABLE "shipment" ADD COLUMN "estimatedDeliveryAt" TIMESTAMP(3);
