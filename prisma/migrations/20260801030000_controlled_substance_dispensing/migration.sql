-- Controlled-substance dispensing ledger (ADR-0037 commitment 1;
-- 21 CFR 1304 recordkeeping).
--
-- One row per order line that actually dispensed a controlled
-- substance, written by `CompleteFill` inside the fill-completion
-- transaction. This is the fact base the 21 CFR part 1306 evaluators
-- in `@pharmax/controlled-substances` read: without it, "has this
-- prescription been refilled?" and "how much of this fill has already
-- been supplied?" are unanswerable, so refill caps and partial-fill
-- windows cannot be enforced at all.
--
-- `fillNumber` is the FILL ordinal, NOT a count of rows: 1 = original
-- fill, 2 = first refill. Several rows may share a `fillNumber` when
-- one fill is completed across multiple partial dispensings. That
-- distinction is exactly what § 1306.12(a) turns on — a Schedule II
-- prescription may not be REFILLED, but § 1306.13 permits supplying
-- the remainder of one that was partially filled.
--
-- The unique on `orderLineId` is the structural guard against
-- double-counting: if an order is reworked and `CompleteFill` runs
-- again on the same line, the drug was still dispensed only once, and
-- a second row would fabricate a refill that never happened.
--
-- Append-only: never updated, never deleted. A dispensing that
-- happened cannot un-happen, and DEA recordkeeping requires the record
-- be retained (two years federally, longer in many states).
--
-- No PHI: ids, quantities, dates, and the schedule only. Patient
-- identity is reachable by join under RLS, never stored in the row.

CREATE TYPE "ControlledSubstancePartialFillBasis" AS ENUM (
    'PHARMACIST_SUPPLY_SHORTFALL',
    'PATIENT_OR_PRESCRIBER_REQUEST',
    'LTCF_OR_TERMINALLY_ILL',
    'SCHEDULE_III_TO_V'
);

CREATE TABLE "controlled_substance_dispensing" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "clinicId" UUID NOT NULL,

    "prescriptionId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "orderLineId" UUID NOT NULL,

    "schedule" "ControlledSubstanceSchedule" NOT NULL,
    "fillNumber" INTEGER NOT NULL,
    "quantityDispensed" DECIMAL(18,4) NOT NULL,
    "partialFillBasis" "ControlledSubstancePartialFillBasis",

    "dispensedAt" TIMESTAMP(3) NOT NULL,
    "dispensedByUserId" UUID NOT NULL,
    "commandLogId" UUID NOT NULL,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "controlled_substance_dispensing_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "controlled_substance_dispensing"
    ADD CONSTRAINT "controlled_substance_dispensing_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "controlled_substance_dispensing"
    ADD CONSTRAINT "controlled_substance_dispensing_clinicId_fkey"
    FOREIGN KEY ("clinicId") REFERENCES "clinic"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "controlled_substance_dispensing"
    ADD CONSTRAINT "controlled_substance_dispensing_prescriptionId_fkey"
    FOREIGN KEY ("prescriptionId") REFERENCES "prescription"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "controlled_substance_dispensing"
    ADD CONSTRAINT "controlled_substance_dispensing_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "order"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "controlled_substance_dispensing"
    ADD CONSTRAINT "controlled_substance_dispensing_orderLineId_fkey"
    FOREIGN KEY ("orderLineId") REFERENCES "order_line"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "controlled_substance_dispensing"
    ADD CONSTRAINT "controlled_substance_dispensing_dispensedByUserId_fkey"
    FOREIGN KEY ("dispensedByUserId") REFERENCES "user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "controlled_substance_dispensing"
    ADD CONSTRAINT "controlled_substance_dispensing_commandLogId_fkey"
    FOREIGN KEY ("commandLogId") REFERENCES "command_log"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- One dispensing per order line. See the header note: a re-run of
-- CompleteFill after rework must not fabricate a second dispensing.
CREATE UNIQUE INDEX "controlled_substance_dispensing_orderLineId_key"
    ON "controlled_substance_dispensing"("orderLineId");

-- The evaluator's read path: "this prescription's fill history, in
-- fill order".
CREATE INDEX "controlled_substance_dispensing_organizationId_prescription_idx"
    ON "controlled_substance_dispensing"("organizationId", "prescriptionId", "fillNumber");

-- 21 CFR 1304 reporting: "controlled substances dispensed by this org,
-- by schedule, over a period".
CREATE INDEX "controlled_substance_dispensing_organizationId_schedule_dis_idx"
    ON "controlled_substance_dispensing"("organizationId", "schedule", "dispensedAt");

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "controlled_substance_dispensing"
    TO pharmax_app, pharmax_system;

ALTER TABLE "controlled_substance_dispensing" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "controlled_substance_dispensing" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "controlled_substance_dispensing"
    USING (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    )
    WITH CHECK (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    );

COMMENT ON TABLE "controlled_substance_dispensing" IS
  'Controlled-substance dispensing ledger (ADR-0037 commitment 1; 21 CFR 1304). One row per order line that dispensed a controlled substance, written by CompleteFill. fillNumber is the fill ordinal (1 = original fill), so partial-fill continuations share a fillNumber and do not read as refills. Append-only; unique on orderLineId so rework cannot fabricate a refill. No PHI.';
