-- migration: 20260802000000_invoice_approval
--
-- Invoice approval workflow — a review gate between DRAFT and OPEN.
--
-- Why:
--
--   - Enterprise billing requires a human review of per-clinic totals
--     BEFORE the invoice is locked and pushed to Stripe. Previously
--     FinalizeInvoice was a single unguarded action; now ApproveInvoice
--     (permission `billing.approve_invoice`) records the review, and
--     FinalizeInvoice refuses to run without a FRESH approval.
--   - "Fresh" is structural, not temporal: `approvedVersion` records
--     the invoice `version` at approval time. Every line append bumps
--     `version` (the materializer's atomic increment), so a late
--     shipped-order line landing after the review automatically
--     invalidates the approval — no cron, no race window.
--
-- The stamp is historical: finalization does NOT clear it, so the
-- audit trail always answers "who signed off on this invoice, and on
-- exactly which revision?".
--
-- PHI: none. User id, timestamp, integer version.

ALTER TABLE "invoice" ADD COLUMN "approvedAt" TIMESTAMP(3);
ALTER TABLE "invoice" ADD COLUMN "approvedByUserId" UUID;
ALTER TABLE "invoice" ADD COLUMN "approvedVersion" INTEGER;

-- RESTRICT — the approval is segregation-of-duties evidence; the
-- approving user row cannot be deleted out from under it.
ALTER TABLE "invoice"
    ADD CONSTRAINT "invoice_approvedByUserId_fkey"
    FOREIGN KEY ("approvedByUserId") REFERENCES "user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

COMMENT ON COLUMN "invoice"."approvedVersion" IS
  'Invoice version as of the ApproveInvoice commit. FinalizeInvoice requires approvedVersion = version; any line appended after the review bumps version and invalidates the approval.';
