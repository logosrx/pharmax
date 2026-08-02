-- migration: 20260801000000_shipment_address_validation
--
-- Record the pre-purchase carrier address-validation outcome on the
-- shipment row. `PurchaseShipmentLabel` now validates the ship-to
-- address against the carrier's address database before buying a
-- label (blocking carrier-confirmed-INVALID addresses; proceeding on
-- UNCONFIRMED; failing OPEN when the validation service itself is
-- down):
--
--   addressDeliverability — CONFIRMED / UNCONFIRMED as verified at
--                           purchase time. NULL when the provider
--                           has no validation API, validation was
--                           unavailable, or the row predates this
--                           column. INVALID never lands here — those
--                           purchases are blocked.
--   addressClassification — carrier's BUSINESS / RESIDENTIAL /
--                           MIXED / UNKNOWN classification. Feeds
--                           residential-surcharge cost analysis.
--   addressValidatedAt    — when the check ran.
--
-- PHI note: these are verdicts about an address, not the address —
-- no address content is stored here, and the columns stay out of
-- audit metadata echoes of the address itself.
--
-- No RLS change needed: shipment already carries ENABLE + FORCE row
-- level security; new columns inherit the table's policies.

ALTER TABLE "shipment" ADD COLUMN "addressDeliverability" TEXT;
ALTER TABLE "shipment" ADD COLUMN "addressClassification" TEXT;
ALTER TABLE "shipment" ADD COLUMN "addressValidatedAt" TIMESTAMP(3);
