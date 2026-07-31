-- migration: 20260724000000_payment_ledger
--
-- Payment ledger — append-only record of settled money movements
-- (payments + refunds), one row per movement.
--
-- Why a table (vs. the aggregate columns on `invoice`):
--
--   - `invoice.amountPaidCents` is a PROJECTION — it answers "what
--     does this invoice owe now?" but cannot answer "what payments
--     did clinic X make in June?" or "how much was refunded this
--     quarter and why?". Financial reporting needs the movements,
--     not just the resulting balance.
--   - Refund budget checks currently string-prefix-scan CREDIT
--     invoice lines (`billingEventKey LIKE 'stripe-refund:%'`);
--     a first-class ledger row is indexed and immune to key-naming
--     drift.
--   - A nightly reconciliation verifier (follow-up slice) can
--     cross-check `invoice.amountPaidCents` against the ledger sum
--     and surface drift — accuracy as a checked invariant.
--
-- Invariants (enforced at the command layer; documented here):
--
--   - Rows are IMMUTABLE — no UPDATE path exists in the domain
--     package; corrections are new offsetting rows.
--   - `amountCents` is always POSITIVE; direction comes from `kind`.
--   - Only SETTLED movements land here. Failed payment attempts and
--     pending refunds are not ledger rows.
--   - `paymentEventKey` is the idempotency anchor (same pattern as
--     `invoice_line.billingEventKey`).
--
-- PHI: none. Stripe identifiers, cents amounts, timestamps.

CREATE TYPE "PaymentKind" AS ENUM (
    'PAYMENT',
    'REFUND'
);

CREATE TYPE "PaymentMethod" AS ENUM (
    'STRIPE',
    'MANUAL'
);

-- ---------------------------------------------------------------------
-- 1. Table.
-- ---------------------------------------------------------------------

CREATE TABLE "payment" (
    "id" UUID NOT NULL,

    -- Tenancy scope (denormalized for fast filtering; matches
    -- invoice_line's shape).
    "organizationId" UUID NOT NULL,
    "clinicId" UUID NOT NULL,

    -- The invoice this movement settles against. RESTRICT — an
    -- invoice with recorded money movements can never be purged.
    "invoiceId" UUID NOT NULL,

    "kind" "PaymentKind" NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,

    -- Idempotency anchor:
    --   "stripe-paid:{stripeEventId}"    (invoice.paid webhook)
    --   "stripe-refund:{stripeRefundId}" (refund settled)
    --   "manual:{ulid}"                  (future RecordManualPayment)
    "paymentEventKey" TEXT NOT NULL,

    "stripeEventId" TEXT,
    "stripeChargeId" TEXT,
    "stripeRefundId" TEXT,

    -- When the money actually moved (Stripe's timestamp, not ours).
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- 2. Indexes.
--
--    - paymentEventKey unique = idempotency (concurrent webhook
--      replays converge via P2002).
--    - stripeRefundId unique-when-present = one ledger row per
--      Stripe refund regardless of which path recorded it.
--    - (org, clinic, occurredAt) serves "payments received by
--      clinic/period" reports; (org, kind, occurredAt) serves
--      org-wide cash / refund reports; (invoiceId) serves the
--      refund-budget sum and the invoice-detail money timeline.
-- ---------------------------------------------------------------------

CREATE UNIQUE INDEX "payment_paymentEventKey_key"
    ON "payment"("paymentEventKey");
CREATE UNIQUE INDEX "payment_stripeRefundId_key"
    ON "payment"("stripeRefundId");
CREATE INDEX "payment_organizationId_clinicId_occurredAt_idx"
    ON "payment"("organizationId", "clinicId", "occurredAt");
CREATE INDEX "payment_organizationId_kind_occurredAt_idx"
    ON "payment"("organizationId", "kind", "occurredAt");
CREATE INDEX "payment_invoiceId_idx"
    ON "payment"("invoiceId");

-- ---------------------------------------------------------------------
-- 3. Foreign keys. All RESTRICT — payment rows are financial
--    records; parents cannot be deleted out from under them.
-- ---------------------------------------------------------------------

ALTER TABLE "payment"
    ADD CONSTRAINT "payment_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payment"
    ADD CONSTRAINT "payment_clinicId_fkey"
    FOREIGN KEY ("clinicId") REFERENCES "clinic"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payment"
    ADD CONSTRAINT "payment_invoiceId_fkey"
    FOREIGN KEY ("invoiceId") REFERENCES "invoice"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------
-- 4. Grants for application roles. Mirrors the baseline. Note:
--    UPDATE/DELETE are granted for operational parity with the
--    baseline grant shape, but no domain code path issues either —
--    immutability is a command-layer invariant (same posture as
--    other append-only ledgers written through the bus).
-- ---------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "payment"
    TO pharmax_app, pharmax_system;

-- ---------------------------------------------------------------------
-- 5. Enable + FORCE row-level security.
-- ---------------------------------------------------------------------

ALTER TABLE "payment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment" FORCE  ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- 6. Tenant isolation policy. Identical shape to the baseline.
-- ---------------------------------------------------------------------

DO $$
DECLARE
  t text;
  new_tables text[] := ARRAY[
    'payment'
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

COMMENT ON TABLE "payment" IS
  'Append-only ledger of settled money movements (payments + refunds). One row per movement; amounts always positive with direction in kind. paymentEventKey is the idempotency anchor. Invoice aggregate columns are the operational projection; this table is what financial reports sum over.';
