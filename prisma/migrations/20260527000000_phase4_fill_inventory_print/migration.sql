-- migration: 20260527000000_phase4_fill_inventory_print
--
-- Inventory traceability (product, lot, lot_assignment,
-- inventory_transaction) and thermal label printing (label_printer,
-- print_template, print_job, vial_label). Promotes order_line.lotId
-- and order_line.vialLabelId from raw UUID placeholders to real FKs.

-- ---------------------------------------------------------------------
-- 1. Enums
-- ---------------------------------------------------------------------

CREATE TYPE "LotStatus" AS ENUM ('ACTIVE', 'ON_HOLD', 'DEPLETED');
CREATE TYPE "PrintJobStatus" AS ENUM ('PENDING', 'SENT', 'COMPLETED', 'FAILED', 'CANCELLED');
CREATE TYPE "LabelPrinterVendor" AS ENUM ('ZEBRA', 'SATO', 'TSC', 'OTHER_THERMAL');
CREATE TYPE "LabelPrinterProtocol" AS ENUM ('ZPL', 'EPL', 'TSPL');
CREATE TYPE "LabelPrinterConnection" AS ENUM ('WORKSTATION_AGENT', 'NETWORK_RAW');
CREATE TYPE "LabelStockKind" AS ENUM ('VIAL', 'SHIP_4X6');
CREATE TYPE "LabelPrinterStatus" AS ENUM ('ACTIVE', 'INACTIVE');
CREATE TYPE "InventoryTransactionReason" AS ENUM ('LOT_ASSIGNED', 'LOT_RELEASED', 'ADJUSTMENT');

-- ---------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------

CREATE TABLE "product" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "ndc" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "strength" TEXT,
    "form" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "product_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "lot" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "lotNumber" TEXT NOT NULL,
    "expirationDate" DATE NOT NULL,
    "status" "LotStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "lot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "lot_assignment" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "orderLineId" UUID NOT NULL,
    "lotId" UUID NOT NULL,
    "assignedByUserId" UUID NOT NULL,
    "commandLogId" UUID NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "lot_assignment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "inventory_transaction" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "lotId" UUID NOT NULL,
    "orderLineId" UUID,
    "quantityDelta" DECIMAL(18,4) NOT NULL,
    "reason" "InventoryTransactionReason" NOT NULL,
    "commandLogId" UUID NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "inventory_transaction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "label_printer" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "workstationId" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "vendor" "LabelPrinterVendor" NOT NULL,
    "protocol" "LabelPrinterProtocol" NOT NULL,
    "connection" "LabelPrinterConnection" NOT NULL,
    "labelStock" "LabelStockKind" NOT NULL,
    "networkAddress" TEXT,
    "status" "LabelPrinterStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "label_printer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "print_template" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "labelStock" "LabelStockKind" NOT NULL,
    "zplBody" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "print_template_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "print_job" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "orderLineId" UUID NOT NULL,
    "printerId" UUID NOT NULL,
    "workstationId" UUID,
    "printTemplateId" UUID NOT NULL,
    "printTemplateVersion" INTEGER NOT NULL,
    "status" "PrintJobStatus" NOT NULL DEFAULT 'PENDING',
    "renderedZpl" TEXT NOT NULL,
    "contentHash" BYTEA NOT NULL,
    "failureReason" TEXT,
    "isReprint" BOOLEAN NOT NULL DEFAULT false,
    "reprintReasonCode" TEXT,
    "requestedByUserId" UUID NOT NULL,
    "commandLogId" UUID NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "print_job_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "vial_label" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "orderLineId" UUID NOT NULL,
    "barcodeValue" TEXT NOT NULL,
    "activePrintJobId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "vial_label_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- 3. Indexes
-- ---------------------------------------------------------------------

CREATE UNIQUE INDEX "product_organizationId_ndc_key" ON "product"("organizationId", "ndc");
CREATE INDEX "product_organizationId_name_idx" ON "product"("organizationId", "name");

CREATE UNIQUE INDEX "lot_organizationId_siteId_productId_lotNumber_key" ON "lot"("organizationId", "siteId", "productId", "lotNumber");
CREATE INDEX "lot_organizationId_siteId_status_expirationDate_idx" ON "lot"("organizationId", "siteId", "status", "expirationDate");

CREATE INDEX "lot_assignment_organizationId_orderId_assignedAt_idx" ON "lot_assignment"("organizationId", "orderId", "assignedAt");
CREATE INDEX "lot_assignment_organizationId_orderLineId_assignedAt_idx" ON "lot_assignment"("organizationId", "orderLineId", "assignedAt");
CREATE INDEX "lot_assignment_organizationId_lotId_assignedAt_idx" ON "lot_assignment"("organizationId", "lotId", "assignedAt");

CREATE INDEX "inventory_transaction_organizationId_lotId_occurredAt_idx" ON "inventory_transaction"("organizationId", "lotId", "occurredAt");
CREATE INDEX "inventory_transaction_organizationId_orderLineId_occurredAt_idx" ON "inventory_transaction"("organizationId", "orderLineId", "occurredAt");

CREATE UNIQUE INDEX "label_printer_organizationId_siteId_code_key" ON "label_printer"("organizationId", "siteId", "code");
CREATE INDEX "label_printer_organizationId_siteId_status_labelStock_idx" ON "label_printer"("organizationId", "siteId", "status", "labelStock");

CREATE UNIQUE INDEX "print_template_organizationId_code_version_key" ON "print_template"("organizationId", "code", "version");
CREATE INDEX "print_template_organizationId_labelStock_isActive_idx" ON "print_template"("organizationId", "labelStock", "isActive");

CREATE INDEX "print_job_organizationId_orderId_status_requestedAt_idx" ON "print_job"("organizationId", "orderId", "status", "requestedAt");
CREATE INDEX "print_job_organizationId_orderLineId_status_requestedAt_idx" ON "print_job"("organizationId", "orderLineId", "status", "requestedAt");
CREATE INDEX "print_job_organizationId_printerId_status_idx" ON "print_job"("organizationId", "printerId", "status");

CREATE UNIQUE INDEX "vial_label_orderLineId_key" ON "vial_label"("orderLineId");
CREATE UNIQUE INDEX "vial_label_activePrintJobId_key" ON "vial_label"("activePrintJobId");
CREATE INDEX "vial_label_organizationId_barcodeValue_idx" ON "vial_label"("organizationId", "barcodeValue");

-- ---------------------------------------------------------------------
-- 4. Foreign keys
-- ---------------------------------------------------------------------

ALTER TABLE "product" ADD CONSTRAINT "product_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "lot" ADD CONSTRAINT "lot_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "lot" ADD CONSTRAINT "lot_siteId_fkey"
    FOREIGN KEY ("siteId") REFERENCES "pharmacy_site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "lot" ADD CONSTRAINT "lot_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "lot_assignment" ADD CONSTRAINT "lot_assignment_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "lot_assignment" ADD CONSTRAINT "lot_assignment_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "lot_assignment" ADD CONSTRAINT "lot_assignment_orderLineId_fkey"
    FOREIGN KEY ("orderLineId") REFERENCES "order_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "lot_assignment" ADD CONSTRAINT "lot_assignment_lotId_fkey"
    FOREIGN KEY ("lotId") REFERENCES "lot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "lot_assignment" ADD CONSTRAINT "lot_assignment_assignedByUserId_fkey"
    FOREIGN KEY ("assignedByUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "lot_assignment" ADD CONSTRAINT "lot_assignment_commandLogId_fkey"
    FOREIGN KEY ("commandLogId") REFERENCES "command_log"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "inventory_transaction" ADD CONSTRAINT "inventory_transaction_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_transaction" ADD CONSTRAINT "inventory_transaction_lotId_fkey"
    FOREIGN KEY ("lotId") REFERENCES "lot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_transaction" ADD CONSTRAINT "inventory_transaction_orderLineId_fkey"
    FOREIGN KEY ("orderLineId") REFERENCES "order_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_transaction" ADD CONSTRAINT "inventory_transaction_commandLogId_fkey"
    FOREIGN KEY ("commandLogId") REFERENCES "command_log"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "label_printer" ADD CONSTRAINT "label_printer_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "label_printer" ADD CONSTRAINT "label_printer_siteId_fkey"
    FOREIGN KEY ("siteId") REFERENCES "pharmacy_site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "label_printer" ADD CONSTRAINT "label_printer_workstationId_fkey"
    FOREIGN KEY ("workstationId") REFERENCES "workstation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "print_template" ADD CONSTRAINT "print_template_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "print_job" ADD CONSTRAINT "print_job_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "print_job" ADD CONSTRAINT "print_job_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "print_job" ADD CONSTRAINT "print_job_orderLineId_fkey"
    FOREIGN KEY ("orderLineId") REFERENCES "order_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "print_job" ADD CONSTRAINT "print_job_printerId_fkey"
    FOREIGN KEY ("printerId") REFERENCES "label_printer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "print_job" ADD CONSTRAINT "print_job_workstationId_fkey"
    FOREIGN KEY ("workstationId") REFERENCES "workstation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "print_job" ADD CONSTRAINT "print_job_printTemplateId_fkey"
    FOREIGN KEY ("printTemplateId") REFERENCES "print_template"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "print_job" ADD CONSTRAINT "print_job_requestedByUserId_fkey"
    FOREIGN KEY ("requestedByUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "print_job" ADD CONSTRAINT "print_job_commandLogId_fkey"
    FOREIGN KEY ("commandLogId") REFERENCES "command_log"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "vial_label" ADD CONSTRAINT "vial_label_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vial_label" ADD CONSTRAINT "vial_label_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vial_label" ADD CONSTRAINT "vial_label_orderLineId_fkey"
    FOREIGN KEY ("orderLineId") REFERENCES "order_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vial_label" ADD CONSTRAINT "vial_label_activePrintJobId_fkey"
    FOREIGN KEY ("activePrintJobId") REFERENCES "print_job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "order_line" ADD CONSTRAINT "order_line_lotId_fkey"
    FOREIGN KEY ("lotId") REFERENCES "lot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_vialLabelId_fkey"
    FOREIGN KEY ("vialLabelId") REFERENCES "vial_label"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------
-- 5. Grants + RLS (standard tenant isolation)
-- ---------------------------------------------------------------------

DO $$
DECLARE
    tbl TEXT;
BEGIN
    FOREACH tbl IN ARRAY ARRAY[
        'product',
        'lot',
        'lot_assignment',
        'inventory_transaction',
        'label_printer',
        'print_template',
        'print_job',
        'vial_label'
    ]
    LOOP
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO pharmax_app, pharmax_system', tbl);
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I FOR ALL USING (
                current_setting(''pharmax.system_context'', true) = ''on''
                OR "organizationId" = NULLIF(current_setting(''pharmax.organization_id'', true), '''')::uuid
            ) WITH CHECK (
                current_setting(''pharmax.system_context'', true) = ''on''
                OR "organizationId" = NULLIF(current_setting(''pharmax.organization_id'', true), '''')::uuid
            )',
            tbl
        );
    END LOOP;
END $$;
