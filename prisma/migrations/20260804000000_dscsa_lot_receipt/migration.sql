-- Compounding domain, slice 3 (ADR-0035): DSCSA lot-receipt records.
--
-- Adds:
--   * `LOT_RECEIVED` on InventoryTransactionReason — the inbound
--     receipt credit written by ReceiveLot, so on-hand stays a pure
--     ledger fold (receipts +, assignments/consumptions -).
--   * `dscsa_transaction` — one row PER RECEIPT (a lot can arrive in
--     multiple shipments): a structured Transaction Information
--     snapshot (21 USC 360eee(26)) plus the seller's Transaction
--     Statement attestation gate. Post-2023 enhanced-security
--     exchange: TI + TS electronically; Transaction History is no
--     longer exchanged and is not modeled. Supply-chain data only, no
--     PHI. Statutory retention 6 years — append-only.

ALTER TYPE "InventoryTransactionReason" ADD VALUE 'LOT_RECEIVED';

CREATE TABLE "dscsa_transaction" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,

    "lotId" UUID NOT NULL,

    "productName" TEXT NOT NULL,
    "strength" TEXT NOT NULL,
    "dosageForm" TEXT NOT NULL,
    "ndc" TEXT NOT NULL,
    "containerSize" TEXT NOT NULL,
    "containerCount" INTEGER NOT NULL,
    "lotNumber" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "transactionDate" DATE NOT NULL,
    "shipmentDate" DATE,

    "sellerName" TEXT NOT NULL,
    "sellerAddress" TEXT NOT NULL,
    "buyerName" TEXT NOT NULL,
    "buyerAddress" TEXT NOT NULL,

    "transactionStatementReceived" BOOLEAN NOT NULL,
    "sourceDocumentRef" TEXT,

    "receivedByUserId" UUID NOT NULL,
    "commandLogId" UUID NOT NULL,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dscsa_transaction_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "dscsa_transaction"
    ADD CONSTRAINT "dscsa_transaction_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "dscsa_transaction"
    ADD CONSTRAINT "dscsa_transaction_lotId_fkey"
    FOREIGN KEY ("lotId") REFERENCES "lot"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "dscsa_transaction"
    ADD CONSTRAINT "dscsa_transaction_receivedByUserId_fkey"
    FOREIGN KEY ("receivedByUserId") REFERENCES "user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "dscsa_transaction"
    ADD CONSTRAINT "dscsa_transaction_commandLogId_fkey"
    FOREIGN KEY ("commandLogId") REFERENCES "command_log"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "dscsa_transaction_organizationId_lotId_idx"
    ON "dscsa_transaction"("organizationId", "lotId");
CREATE INDEX "dscsa_transaction_organizationId_transactionDate_idx"
    ON "dscsa_transaction"("organizationId", "transactionDate");

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "dscsa_transaction"
    TO pharmax_app, pharmax_system;

ALTER TABLE "dscsa_transaction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dscsa_transaction" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "dscsa_transaction"
    USING (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    )
    WITH CHECK (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    );

COMMENT ON TABLE "dscsa_transaction" IS
  'DSCSA transaction record for an inbound lot receipt (ADR-0035 slice 3; 21 USC 360eee): structured Transaction Information snapshot + Transaction Statement attestation, one row per receipt. Post-2023 enhanced-security exchange — Transaction History is not modeled. Append-only; statutory retention 6 years. Written only by ReceiveLot.';
