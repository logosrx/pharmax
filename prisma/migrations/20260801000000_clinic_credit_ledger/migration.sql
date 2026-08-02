-- migration: 20260801000000_clinic_credit_ledger
--
-- Clinic credit ledger — append-only record of clinic-level credit
-- movements, plus the CREDIT_BALANCE payment method that spends it.
--
-- Why:
--
--   - Overpayments (a clinic's check exceeds the invoice balance)
--     previously had NO home: RecordManualPayment rejects amounts
--     above amountDue, and silently driving amountDue negative would
--     corrupt aging. The excess now lands here as a GRANT.
--   - Applying stored credit to a later invoice must keep the
--     payment-ledger / invoice-projection parity that the nightly
--     reconciler enforces — so an APPLICATION writes a normal
--     payment-ledger row with method CREDIT_BALANCE in the same
--     transaction, and the reconciler needs no changes.
--
-- Invariants (enforced at the command layer; documented here):
--
--   - Rows are IMMUTABLE — corrections are new offsetting rows.
--   - `amountCents` is always POSITIVE; direction comes from `kind`.
--   - Balance = Σ GRANT − Σ APPLICATION per (clinic, currency),
--     never negative. Commands serialize on a clinic-row lock
--     (SELECT ... FOR UPDATE) before reading the balance.
--
-- PHI: none. Clinic ids, cents amounts, timestamps, operator ids.

-- ---------------------------------------------------------------------
-- 0. New PaymentMethod value. Settlements from stored credit are
--    payment-ledger rows so the invoice projection parity holds;
--    CREDIT_BALANCE marks them as "no new cash arrived".
-- ---------------------------------------------------------------------

ALTER TYPE "PaymentMethod" ADD VALUE 'CREDIT_BALANCE';

CREATE TYPE "ClinicCreditEntryKind" AS ENUM (
    'GRANT',
    'APPLICATION'
);

CREATE TYPE "ClinicCreditSource" AS ENUM (
    'OVERPAYMENT',
    'GOODWILL',
    'OTHER'
);

-- ---------------------------------------------------------------------
-- 1. Table.
-- ---------------------------------------------------------------------

CREATE TABLE "clinic_credit_entry" (
    "id" UUID NOT NULL,

    "organizationId" UUID NOT NULL,
    "clinicId" UUID NOT NULL,

    "kind" "ClinicCreditEntryKind" NOT NULL,
    -- GRANT rows only; NULL for APPLICATION.
    "source" "ClinicCreditSource",

    "amountCents" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,

    -- Idempotency anchor:
    --   "credit-grant:{ulid}"  (GrantClinicCredit)
    --   "credit-apply:{ulid}"  (ApplyClinicCredit)
    "creditEventKey" TEXT NOT NULL,

    -- APPLICATION rows only: the invoice settled and the
    -- payment-ledger row that carried the settlement.
    "appliedToInvoiceId" UUID,
    "appliedPaymentId" UUID,

    "occurredAt" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clinic_credit_entry_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- 2. Indexes.
--
--    - creditEventKey unique = idempotency.
--    - appliedPaymentId unique-when-present = one APPLICATION entry
--      per payment-ledger row.
--    - (org, clinic, currency, occurredAt) serves the balance sum
--      and per-clinic credit history; (appliedToInvoiceId) serves
--      the invoice-detail money timeline.
-- ---------------------------------------------------------------------

CREATE UNIQUE INDEX "clinic_credit_entry_creditEventKey_key"
    ON "clinic_credit_entry"("creditEventKey");
CREATE UNIQUE INDEX "clinic_credit_entry_appliedPaymentId_key"
    ON "clinic_credit_entry"("appliedPaymentId");
CREATE INDEX "clinic_credit_entry_organizationId_clinicId_currency_occurr_idx"
    ON "clinic_credit_entry"("organizationId", "clinicId", "currency", "occurredAt");
CREATE INDEX "clinic_credit_entry_appliedToInvoiceId_idx"
    ON "clinic_credit_entry"("appliedToInvoiceId");

-- ---------------------------------------------------------------------
-- 3. Foreign keys. All RESTRICT — credit entries are financial
--    records; parents cannot be deleted out from under them.
-- ---------------------------------------------------------------------

ALTER TABLE "clinic_credit_entry"
    ADD CONSTRAINT "clinic_credit_entry_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "clinic_credit_entry"
    ADD CONSTRAINT "clinic_credit_entry_clinicId_fkey"
    FOREIGN KEY ("clinicId") REFERENCES "clinic"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "clinic_credit_entry"
    ADD CONSTRAINT "clinic_credit_entry_appliedToInvoiceId_fkey"
    FOREIGN KEY ("appliedToInvoiceId") REFERENCES "invoice"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "clinic_credit_entry"
    ADD CONSTRAINT "clinic_credit_entry_appliedPaymentId_fkey"
    FOREIGN KEY ("appliedPaymentId") REFERENCES "payment"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------
-- 4. Grants for application roles. Mirrors the baseline (see the
--    payment_ledger migration for the immutability posture).
-- ---------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "clinic_credit_entry"
    TO pharmax_app, pharmax_system;

-- ---------------------------------------------------------------------
-- 5. Enable + FORCE row-level security.
-- ---------------------------------------------------------------------

ALTER TABLE "clinic_credit_entry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "clinic_credit_entry" FORCE  ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- 6. Tenant isolation policy. Identical shape to the baseline.
-- ---------------------------------------------------------------------

DO $$
DECLARE
  t text;
  new_tables text[] := ARRAY[
    'clinic_credit_entry'
  ];
BEGIN
  FOREACH t IN ARRAY new_tables LOOP
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      'USING ('
      '  current_setting(''pharmax.system_context'', true) = ''on'' '
      '  OR "organizationId" = NULLIF(current_setting(''pharmax.organization_id'', true), '''')::uuid'
      ') '
      'WITH CHECK ('
      '  current_setting(''pharmax.system_context'', true) = ''on'' '
      '  OR "organizationId" = NULLIF(current_setting(''pharmax.organization_id'', true), '''')::uuid'
      ');',
      t
    );
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------
-- 7. Sanity comment.
-- ---------------------------------------------------------------------

COMMENT ON TABLE "clinic_credit_entry" IS
  'Append-only ledger of clinic-level credit movements. GRANT adds (overpayment excess, goodwill), APPLICATION consumes against an OPEN invoice via a CREDIT_BALANCE payment-ledger row written in the same transaction. Balance per (clinic, currency) never negative; creditEventKey is the idempotency anchor.';
