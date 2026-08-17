-- Compound batch + unit labels (Products/Compounds, PR 3).
--
-- Makes `print_job` polymorphic in what it labels.
--
-- Before this migration a print job always belonged to an order line:
-- `orderId` and `orderLineId` were both NOT NULL. Compound stock labels
-- do not fit that shape — a batch is compounded BEFORE any patient
-- order exists, so a batch label has no order to reference.
--
-- The alternative was a second print-job table with its own worker
-- drain and its own print-agent claim path. That would have duplicated
-- the lease/claim query, the raw-TCP send, and the Zebra `~HS`
-- fail-closed status check — the machinery that implements "no silent
-- printer failures". Two copies of fail-closed logic is how one copy
-- quietly stops being fail-closed, so the target became polymorphic
-- instead and the delivery pipeline stayed singular.
--
-- Relaxing NOT NULL gives up a real guarantee, so the CHECK below has
-- to replace it in full: it pins each `targetKind` to exactly the
-- columns that value is allowed to populate, and forbids every other
-- combination. A row with no target, two targets, or a unit without
-- its batch is not storable.

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------

-- Batch labels get their own stock kind rather than reusing VIAL so a
-- site can dedicate a printer to them: the batch label is a stock-room
-- artifact, and its printer is not the one at the fill bench loading
-- patient vials. Printer selection already filters on labelStock, so a
-- distinct value is what makes that separation enforceable.
ALTER TYPE "LabelStockKind" ADD VALUE 'BATCH_2X1';

CREATE TYPE "PrintJobTargetKind" AS ENUM ('ORDER_LINE', 'COMPOUND_BATCH', 'COMPOUND_UNIT');

-- ---------------------------------------------------------------------
-- print_job: polymorphic target
-- ---------------------------------------------------------------------

-- Default ORDER_LINE so every pre-existing row is correctly classified
-- by the backfill implicit in the default, before the CHECK is added.
ALTER TABLE "print_job"
    ADD COLUMN "targetKind" "PrintJobTargetKind" NOT NULL DEFAULT 'ORDER_LINE',
    ADD COLUMN "compoundBatchId"     UUID,
    ADD COLUMN "compoundBatchUnitId" UUID;

ALTER TABLE "print_job"
    ALTER COLUMN "orderId"     DROP NOT NULL,
    ALTER COLUMN "orderLineId" DROP NOT NULL;

ALTER TABLE "print_job"
    ADD CONSTRAINT "print_job_compoundBatchId_fkey"
    FOREIGN KEY ("compoundBatchId") REFERENCES "compound_batch"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "print_job"
    ADD CONSTRAINT "print_job_compoundBatchUnitId_fkey"
    FOREIGN KEY ("compoundBatchUnitId") REFERENCES "compound_batch_unit"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- The guarantee that replaces the two dropped NOT NULLs. Every branch
-- is exhaustive in both directions: the columns that must be present,
-- AND the columns that must be absent. Without the "must be absent"
-- half, a job could name an order line and a batch at once and the
-- delivery path would have no defined target.
ALTER TABLE "print_job"
    ADD CONSTRAINT "print_job_exactly_one_target"
    CHECK (
        CASE "targetKind"
            WHEN 'ORDER_LINE' THEN
                "orderId"             IS NOT NULL
            AND "orderLineId"         IS NOT NULL
            AND "compoundBatchId"     IS NULL
            AND "compoundBatchUnitId" IS NULL
            WHEN 'COMPOUND_BATCH' THEN
                "compoundBatchId"     IS NOT NULL
            AND "compoundBatchUnitId" IS NULL
            AND "orderId"             IS NULL
            AND "orderLineId"         IS NULL
            -- A unit label also names its batch: the batch number is
            -- printed on the unit label and the unit serial is derived
            -- from it, so a unit job without its batch is incoherent.
            WHEN 'COMPOUND_UNIT' THEN
                "compoundBatchId"     IS NOT NULL
            AND "compoundBatchUnitId" IS NOT NULL
            AND "orderId"             IS NULL
            AND "orderLineId"         IS NULL
        END
    );

-- Short explicit names: the conventional
-- "<table>_<col>_<col>…_idx" form runs to 67 characters here, past
-- Postgres's 63-character identifier limit, so the server would
-- silently truncate it and permanently diverge from schema.prisma.
-- The matching `map:` values are on the @@index entries there.
CREATE INDEX "print_job_compound_batch_status_idx"
    ON "print_job"("organizationId", "compoundBatchId", "status", "requestedAt");

CREATE INDEX "print_job_compound_unit_status_idx"
    ON "print_job"("organizationId", "compoundBatchUnitId", "status", "requestedAt");

COMMENT ON COLUMN "print_job"."targetKind" IS
  'Which aggregate this job labels. Discriminates the polymorphic target columns; print_job_exactly_one_target pins each value to the columns it may populate. ORDER_LINE is the patient vial label; COMPOUND_BATCH and COMPOUND_UNIT are in-house compounded stock labels, which have no order because the batch predates any patient order.';
