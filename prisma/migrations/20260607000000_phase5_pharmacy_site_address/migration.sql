-- migration: 20260607000000_phase5_pharmacy_site_address
--
-- Add plaintext business-address columns to `pharmacy_site` so
-- the operator console can resolve a ship-from address for the
-- carrier-label auto-purchase flow (PurchaseShipmentLabel).
--
-- Why plaintext rather than envelope-encrypted:
--   - Pharmacy site addresses are PUBLIC business addresses (the
--     pharmacy's physical location). They are NOT patient PHI under
--     HIPAA Safe Harbor — same category as the `provider` model's
--     practice address, which is also stored plaintext today.
--   - Carrier APIs (EasyPost, FedEx, UPS) require the from-address
--     in clear bytes in every request; encrypting at rest would
--     buy nothing but operational cost (KMS round-trip on every
--     label purchase) without adding any compliance surface.
--   - Operator search and admin display read these fields directly;
--     no decrypt-per-render overhead.
--
-- All columns are nullable because:
--   - Existing pharmacy_site rows from before this migration must
--     remain readable.
--   - A pharmacy can exist before address is configured (the auto-
--     purchase form gates on address-complete and surfaces a "go to
--     site admin to configure" message when missing).
--
-- `country` defaults to "US" since the platform's carrier adapters
-- today only ship US domestic. A non-US value would fail downstream
-- at the EasyPost / FedEx / UPS adapter, not here.
--
-- Phone is included because EasyPost (and friends) require a phone
-- number on the shipper address for many service levels; collecting
-- it on the site admin avoids a "fix your data" round trip when
-- the operator tries to purchase a label.

ALTER TABLE "pharmacy_site"
    ADD COLUMN "addressLine1" TEXT,
    ADD COLUMN "addressLine2" TEXT,
    ADD COLUMN "city"         TEXT,
    ADD COLUMN "state"        TEXT,
    ADD COLUMN "postalCode"   TEXT,
    ADD COLUMN "country"      TEXT NOT NULL DEFAULT 'US',
    ADD COLUMN "phone"        TEXT;
