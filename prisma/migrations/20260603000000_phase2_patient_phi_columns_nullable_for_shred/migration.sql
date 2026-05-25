-- =====================================================================
-- PHASE 2: PATIENT PHI COLUMNS — NULLABILITY RELAXATION FOR CRYPTO-SHRED
--
-- Drops NOT NULL from the seven Patient identity columns that were
-- born NOT NULL in the original 20260523190000_phase2_patient_rx_order
-- migration. This is a STRUCTURAL prerequisite for the
-- `CryptoShredPatient` command: that command's whole job is to render
-- a row's PHI permanently unreadable by NULL-ing every envelope-
-- encrypted column AND every blind-index column. Without this
-- relaxation, the shred path cannot persist.
--
-- Why these seven and not the optional Enc/Bi columns? The optional
-- columns (middleNameEnc, phoneEnc, …, mrnBi) were already nullable —
-- they tracked whether the OPTIONAL input was provided. The seven
-- relaxed here are the IDENTITY columns whose original NOT NULL
-- constraint reflected the intake invariant ("you must give us a
-- first name, last name, and DOB to register a patient"), not a
-- storage invariant. RegisterPatient still REQUIRES these inputs
-- (the Zod schema is unchanged); this migration only removes the DB
-- floor so the shred path can later set them to NULL.
--
-- Affected columns:
--   patient.firstNameEnc    JSONB    DROP NOT NULL
--   patient.lastNameEnc     JSONB    DROP NOT NULL
--   patient.dateOfBirthEnc  JSONB    DROP NOT NULL
--   patient.firstNameBi     TEXT     DROP NOT NULL
--   patient.lastNameBi      TEXT     DROP NOT NULL
--   patient.dobBi           TEXT     DROP NOT NULL
--   patient.dobYearMonthBi  TEXT     DROP NOT NULL
--
-- Existing rows are unaffected — they already hold non-NULL values
-- and this DDL is a pure constraint relaxation. The indexes on
-- (organizationId, *Bi) continue to exist; nulls are simply allowed
-- and Postgres btree indexes index NULL values normally for our
-- single-column-after-orgId shape, so the index remains usable for
-- the existing equality lookups against non-shredded rows.
--
-- No new RLS work needed: the `tenant_isolation` policy on `patient`
-- from `20260522060000_rls_baseline` already protects this table and
-- is unaffected by column-level DDL.
-- =====================================================================

ALTER TABLE "patient"
  ALTER COLUMN "firstNameEnc"   DROP NOT NULL,
  ALTER COLUMN "lastNameEnc"    DROP NOT NULL,
  ALTER COLUMN "dateOfBirthEnc" DROP NOT NULL,
  ALTER COLUMN "firstNameBi"    DROP NOT NULL,
  ALTER COLUMN "lastNameBi"     DROP NOT NULL,
  ALTER COLUMN "dobBi"          DROP NOT NULL,
  ALTER COLUMN "dobYearMonthBi" DROP NOT NULL;
