-- migration: 20260528000000_phase5_shipment
--
-- Shipment records for carrier label purchase and handoff confirmation.

CREATE TYPE "ShipmentCarrier" AS ENUM ('USPS', 'UPS', 'FEDEX', 'DHL', 'OTHER');
CREATE TYPE "ShipmentStatus" AS ENUM ('CREATED', 'CONFIRMED');

CREATE TABLE "shipment" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'CREATED',
    "carrier" "ShipmentCarrier" NOT NULL,
    "serviceLevel" TEXT NOT NULL,
    "trackingNumber" TEXT NOT NULL,
    "externalShipmentId" TEXT,
    "externalTrackerId" TEXT,
    "createdByUserId" UUID NOT NULL,
    "confirmedByUserId" UUID,
    "createCommandLogId" UUID NOT NULL,
    "confirmCommandLogId" UUID,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "shipment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shipment_organizationId_orderId_key" ON "shipment"("organizationId", "orderId");
CREATE INDEX "shipment_organizationId_siteId_status_createdAt_idx" ON "shipment"("organizationId", "siteId", "status", "createdAt");
CREATE INDEX "shipment_organizationId_trackingNumber_idx" ON "shipment"("organizationId", "trackingNumber");

ALTER TABLE "shipment" ADD CONSTRAINT "shipment_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_siteId_fkey"
    FOREIGN KEY ("siteId") REFERENCES "pharmacy_site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_confirmedByUserId_fkey"
    FOREIGN KEY ("confirmedByUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_createCommandLogId_fkey"
    FOREIGN KEY ("createCommandLogId") REFERENCES "command_log"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_confirmCommandLogId_fkey"
    FOREIGN KEY ("confirmCommandLogId") REFERENCES "command_log"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

DO $$
DECLARE
    tbl TEXT;
BEGIN
    FOREACH tbl IN ARRAY ARRAY['shipment']
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
