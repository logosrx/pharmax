-- migration: 20260530000000_phase4_shipment_tracking_event
--
-- Carrier tracking event ingestion (EasyPost-style). Inbound webhooks
-- write a `shipment_tracking_event` row per normalized carrier event;
-- the shipment's cached status is updated when the event is newer.

-- Expand ShipmentStatus enum with carrier lifecycle values. The
-- existing `CREATED` and `CONFIRMED` values stay; new values describe
-- post-handoff carrier states reported via tracking webhooks.
ALTER TYPE "ShipmentStatus" ADD VALUE 'IN_TRANSIT';
ALTER TYPE "ShipmentStatus" ADD VALUE 'OUT_FOR_DELIVERY';
ALTER TYPE "ShipmentStatus" ADD VALUE 'DELIVERED';
ALTER TYPE "ShipmentStatus" ADD VALUE 'EXCEPTION';
ALTER TYPE "ShipmentStatus" ADD VALUE 'RETURN_TO_SENDER';
ALTER TYPE "ShipmentStatus" ADD VALUE 'FAILED_DELIVERY';

-- Normalized tracking event kind. Mirrors `ShipmentStatus` for the
-- post-handoff lifecycle, plus operational events that don't change
-- shipment status but are useful for audit (e.g. label scanned at
-- carrier facility).
CREATE TYPE "ShipmentTrackingEventKind" AS ENUM (
    'CREATED',
    'IN_TRANSIT',
    'OUT_FOR_DELIVERY',
    'DELIVERED',
    'EXCEPTION',
    'RETURN_TO_SENDER',
    'FAILED_DELIVERY',
    'UNKNOWN'
);

-- Carrier source identifier. EasyPost is the first integration;
-- additional carriers add new values in later migrations.
CREATE TYPE "ShipmentTrackingSource" AS ENUM ('EASYPOST', 'MANUAL');

CREATE TABLE "shipment_tracking_event" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "shipmentId" UUID NOT NULL,
    "source" "ShipmentTrackingSource" NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "kind" "ShipmentTrackingEventKind" NOT NULL,
    "carrierStatus" TEXT NOT NULL,
    "carrierStatusDetail" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "rawPayload" JSONB NOT NULL,
    "signatureVerifiedAt" TIMESTAMP(3) NOT NULL,
    "commandLogId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "shipment_tracking_event_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shipment_tracking_event_source_external_idx"
    ON "shipment_tracking_event"("organizationId", "source", "externalEventId");
CREATE INDEX "shipment_tracking_event_shipmentId_occurredAt_idx"
    ON "shipment_tracking_event"("organizationId", "shipmentId", "occurredAt");
CREATE INDEX "shipment_tracking_event_organizationId_kind_occurredAt_idx"
    ON "shipment_tracking_event"("organizationId", "kind", "occurredAt");

ALTER TABLE "shipment_tracking_event" ADD CONSTRAINT "shipment_tracking_event_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment_tracking_event" ADD CONSTRAINT "shipment_tracking_event_shipmentId_fkey"
    FOREIGN KEY ("shipmentId") REFERENCES "shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment_tracking_event" ADD CONSTRAINT "shipment_tracking_event_commandLogId_fkey"
    FOREIGN KEY ("commandLogId") REFERENCES "command_log"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Cache the last applied carrier event on the shipment row for fast
-- queue/list rendering. Authoritative history lives in
-- `shipment_tracking_event`.
ALTER TABLE "shipment" ADD COLUMN "lastTrackingEventAt" TIMESTAMP(3);
ALTER TABLE "shipment" ADD COLUMN "lastTrackingEventKind" "ShipmentTrackingEventKind";

DO $$
DECLARE
    tbl TEXT;
BEGIN
    FOREACH tbl IN ARRAY ARRAY['shipment_tracking_event']
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
