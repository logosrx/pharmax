-- Persist purchased-label artifacts on shipment.
--
-- PurchaseShipmentLabel pays the carrier for a rendered label; the
-- adapter returns a carrier-hosted URL (EasyPost/UPS) and/or the
-- inline base64 PDF (FedEx). Neither was persisted, so the artifact
-- the org paid for was discarded at commit and could never be
-- printed (or re-printed) afterwards. Both columns are nullable:
-- manual BYO-tracking-number shipments have neither.
--
-- No RLS change needed: shipment already carries ENABLE + FORCE row
-- level security from the RLS baseline; new columns inherit the
-- table's policies.

ALTER TABLE "shipment" ADD COLUMN "labelUrl" TEXT;
ALTER TABLE "shipment" ADD COLUMN "labelPdfBase64" TEXT;
