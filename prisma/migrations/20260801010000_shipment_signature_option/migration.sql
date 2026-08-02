-- migration: 20260801010000_shipment_signature_option
--
-- Record the delivery-signature requirement a label was purchased
-- with (NO_SIGNATURE_REQUIRED / INDIRECT / DIRECT / ADULT; NULL =
-- carrier service default or manual/pre-migration shipment). This is
-- the compliance record for "was adult signature requested on this
-- controlled-substance shipment" — the request side; the delivery
-- side (signature proof) arrives via carrier tracking/POD.
--
-- Adapters that cannot honor a requested option throw
-- SIGNATURE_OPTION_UNSUPPORTED at purchase time, so a non-NULL value
-- here means the carrier ACCEPTED the requirement on the label.
--
-- No RLS change needed: shipment already carries ENABLE + FORCE row
-- level security; new columns inherit the table's policies.

ALTER TABLE "shipment" ADD COLUMN "signatureOption" TEXT;
