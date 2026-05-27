-- migration: 20260605000000_phase5_invoice_stripe_charge_id
--
-- Add `stripeChargeId` to the `invoice` table so refunds can be
-- issued without an extra Stripe lookup. Stripe accepts either a
-- `payment_intent` or `charge` id as the source for a refund;
-- charge id is the more direct hop and matches the `latest_charge`
-- field Stripe surfaces on `invoice.paid` events.
--
-- Nullable because:
--   - DRAFT / OPEN invoices have no charge yet.
--   - Historical invoices created before this column existed
--     remain readable.
--   - Pharmax invoices that were never paid through Stripe never
--     get a charge id.
--
-- Unique-when-present index: a Stripe charge can map to AT MOST
-- ONE Pharmax invoice in our model (charges are 1:1 with invoice
-- payments). A collision would indicate cross-org leakage and
-- should fail loud.

ALTER TABLE "invoice" ADD COLUMN "stripeChargeId" TEXT;

CREATE UNIQUE INDEX "invoice_stripeChargeId_unique"
    ON "invoice"("stripeChargeId")
    WHERE "stripeChargeId" IS NOT NULL;
