-- Structured sig (dose capture) on `prescription`.
--
-- Pharmax has screened four clinical axes at PV1 since 20260807000000,
-- and DOSE_RANGE was the last one still declared
-- NOT_SUPPORTED_BY_PLATFORM: `sigEnc` is encrypted free text, and a
-- dose comparison needs an amount, a unit and a frequency as separate
-- values. These four columns are what that declaration was waiting
-- for — the forcing function in
-- `packages/verification/src/screening/axis-capability.test.ts` named
-- them (`doseAmount`, `doseUnit`, `dosesPerDay`) before they existed.
--
-- The free-text sig REMAINS the authoritative label instruction. These
-- columns are the machine-comparable summary, captured at
-- transcription, and all optional: a prescription without them is
-- legal and merely unscreenable on the dose axis. NULL
-- `sigStructureKind` means "not structured at all", which is distinct
-- from every structured kind — including the kinds (PRN, TAPER) whose
-- value columns may themselves be NULL.
--
-- Vocabulary is modelled on HL7 FHIR R4 `Dosage` (a permitted public
-- source, docs/governance/public-sources-reference.md): `asNeeded` →
-- PRN, `doseRange` → RANGE, multi-`sequence` → TAPER. What each value
-- column means per kind is documented on the enum in `schema.prisma`.
--
-- PHI: coded, comparable values in plaintext under the tenant RLS the
-- `prescription` table already has — the treatment `drugNdc` and the
-- patient-allergy substance codes established. The narrative stays in
-- `sigEnc`. No new table, so no new RLS policy.

-- CreateEnum
CREATE TYPE "SigStructureKind" AS ENUM ('FIXED', 'PRN', 'RANGE', 'TAPER');

-- CreateEnum
CREATE TYPE "DoseUnit" AS ENUM ('MG', 'MCG', 'G', 'MEQ', 'ML', 'UNIT', 'TABLET', 'CAPSULE', 'DROP', 'PUFF', 'SPRAY', 'PATCH', 'APPLICATION');

-- AlterTable
ALTER TABLE "prescription"
  ADD COLUMN "sigStructureKind" "SigStructureKind",
  ADD COLUMN "doseAmount" DECIMAL(12,4),
  ADD COLUMN "doseUnit" "DoseUnit",
  ADD COLUMN "dosesPerDay" DECIMAL(8,4);

-- The shape rules `CreatePrescription` validates, restated where no
-- code path can skip them. One constraint per rule so a violation
-- names what it violated:
--
--   1. No structure kind → no values. A dose amount with no kind has
--      no defined reading and must be unrepresentable.
--   2. FIXED and RANGE promise a computable daily figure, so all
--      three values are required.
--   3. PRN and TAPER may be bare (the honest "structured, but no
--      single comparable number"), but what IS supplied must cohere:
--      an amount and a unit travel together, and a frequency without
--      an amount computes nothing and is not storable.
-- A CASE rather than OR-ed branches, deliberately: with OR,
-- `"sigStructureKind" IN ('FIXED','RANGE')` evaluates to NULL for a
-- NULL kind, the whole predicate goes NULL, and a CHECK that is NULL
-- PASSES — which would admit exactly the row this constraint exists
-- to refuse (dose values with no kind to give them a reading). CASE
-- arms are entered on IS NULL / IN tests whose outcomes are decided,
-- so the expression is always TRUE or FALSE, never NULL.
ALTER TABLE "prescription"
  ADD CONSTRAINT "prescription_structured_sig_shape"
    CHECK (
      CASE
        WHEN "sigStructureKind" IS NULL THEN
          "doseAmount" IS NULL AND "doseUnit" IS NULL AND "dosesPerDay" IS NULL
        WHEN "sigStructureKind" IN ('FIXED', 'RANGE') THEN
          "doseAmount" IS NOT NULL AND "doseUnit" IS NOT NULL AND "dosesPerDay" IS NOT NULL
        ELSE
          (("doseAmount" IS NULL) = ("doseUnit" IS NULL))
          AND ("dosesPerDay" IS NULL OR "doseAmount" IS NOT NULL)
      END
    );

-- A zero or negative dose is a transcription error in every kind's
-- reading, and a zero frequency is not a schedule (PRN's "no stated
-- ceiling" is NULL, never 0 — the engine treats 0 as "skip the daily
-- arithmetic", and storing it would encode engine behaviour as data).
ALTER TABLE "prescription"
  ADD CONSTRAINT "prescription_dose_amount_positive"
    CHECK ("doseAmount" IS NULL OR "doseAmount" > 0);

ALTER TABLE "prescription"
  ADD CONSTRAINT "prescription_doses_per_day_positive"
    CHECK ("dosesPerDay" IS NULL OR "dosesPerDay" > 0);
