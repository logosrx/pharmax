-- Controlled-substance schedule awareness (ADR-0037 commitment 1).
--
-- Adds the DEA schedule vocabulary (21 CFR part 1308) and the two
-- columns the Part 1306 dispensing rules in
-- `@pharmax/controlled-substances` evaluate against:
--
--   * `product.controlledSubstanceSchedule` — the catalog's schedule
--     for an NDC. Source of truth.
--   * `prescription.controlledSubstanceSchedule` — a point-in-time
--     SNAPSHOT copied at prescription creation. Denormalized on
--     purpose: rescheduling a substance must not retroactively change
--     the rules that governed an already-written prescription.
--   * `prescription.earliestFillDate` — the prescriber's "do not fill
--     before" instruction on a multiple-prescription Schedule II
--     sequence (21 CFR 1306.12(b)(1)(ii)). 21 CFR 1306.14(e) makes it
--     a hard bar on the pharmacy.
--
-- Schedule I is intentionally not in the enum: Schedule I substances
-- cannot be prescribed (21 CFR 1308.11), so no dispensable record can
-- legitimately carry that value.
--
-- Backfill posture: both columns default to NON_CONTROLLED. Pharmax
-- has never recorded a schedule, so every existing row is unclassified
-- rather than known-non-controlled. NON_CONTROLLED is the safe default
-- ONLY because no controlled-substance workflow is enabled yet (ADR-0037
-- gates that on third-party certification). Classifying the existing
-- catalog is an operational task that must complete before any CS
-- dispensing is turned on.
--
-- No RLS change needed: `product` and `prescription` already carry
-- ENABLE + FORCE row level security; new columns inherit the table's
-- existing policies.

CREATE TYPE "ControlledSubstanceSchedule" AS ENUM (
    'NON_CONTROLLED',
    'CII',
    'CIII',
    'CIV',
    'CV'
);

ALTER TABLE "product"
    ADD COLUMN "controlledSubstanceSchedule" "ControlledSubstanceSchedule" NOT NULL DEFAULT 'NON_CONTROLLED';

ALTER TABLE "prescription"
    ADD COLUMN "controlledSubstanceSchedule" "ControlledSubstanceSchedule" NOT NULL DEFAULT 'NON_CONTROLLED',
    ADD COLUMN "earliestFillDate" DATE;

-- Controlled-substance recordkeeping / reporting access path
-- (21 CFR 1304): "every CS prescription in this org, by schedule,
-- over a date range".
-- Name matches Prisma's 63-char-truncated identifier for this index so
-- migration replay reconciles to schema.prisma (see check:drift).
CREATE INDEX "prescription_organizationId_controlledSubstanceSchedule_ori_idx"
    ON "prescription" ("organizationId", "controlledSubstanceSchedule", "originalDateWritten");
