-- Patient allergy capture.
--
-- Pharmax has had a clinical screening engine at PV1 since
-- 20260807000000, and one of the four axes it screens is allergy. Until
-- this migration there was nowhere to put an allergy, so that axis was
-- declared NOT_SUPPORTED_BY_PLATFORM and reported an informational gap
-- on every order. These two tables are what that declaration was
-- waiting for.
--
-- Modelled on HL7 FHIR R4 `AllergyIntolerance`
-- (https://hl7.org/fhir/R4/allergyintolerance.html), a permitted public
-- source recorded in docs/governance/public-sources-reference.md §4.
--
-- ---------------------------------------------------------------------
-- WHY TWO TABLES
-- ---------------------------------------------------------------------
--
-- Because an empty allergy list means two opposite things and a
-- pharmacist will read the safer one into the more dangerous one.
--
--   "We asked; there is nothing."       → screen the axis, report clear.
--   "Nobody has asked."                 → the screen did not happen.
--
-- One table of allergies cannot express the first: the absence of rows
-- IS the ambiguity. So the patient-level negative assertion gets its own
-- record, with an asserter and a time, and the screening layer treats
-- the two states differently — see
-- `packages/verification/src/screening/allergy-input.ts`.
--
-- FHIR expresses "no known allergies" as an `AllergyIntolerance` whose
-- `code` is a "no known allergy" concept. We deliberately do not: a row
-- in the allergy table that is not an allergy is a row every future
-- query has to remember to exclude, and the one that forgets screens a
-- patient against an allergen called "none".
--
-- ---------------------------------------------------------------------
-- WHY patient_allergy IS UPDATABLE AND UNDELETABLE
-- ---------------------------------------------------------------------
--
-- Clinical data is corrected, not deleted. An allergy entered in error
-- must stop driving the screen while staying in the record — that is
-- what `verificationStatus = ENTERED_IN_ERROR` is for, and it is an
-- UPDATE. So unlike `order_screening_finding`, this table grants UPDATE.
--
-- It does NOT grant DELETE, and there is deliberately no RLS policy
-- FOR DELETE. Two independent layers therefore have to be re-opened
-- before a row can be destroyed, which is the point: "retract" and
-- "erase" are different operations and only one of them is available.
-- (Crypto-shred remains the right-to-be-forgotten path; it nulls the
-- envelope columns rather than removing the clinical row.)
--
-- `patient_allergy_history_assertion` is append-only in the stronger
-- sense — SELECT + INSERT only. A superseded assertion is precisely the
-- record that answers "who said this patient had no allergies, and
-- when?", so it is never overwritten; the current assertion is the most
-- recent row.
--
-- ---------------------------------------------------------------------
-- PHI
-- ---------------------------------------------------------------------
--
-- Every row in both tables is PHI by association with its patient, and
-- tenant RLS plus the RBAC gate plus the audit trail are the controls
-- that make it safe — not encryption. What encryption decides here is a
-- narrower question: which columns a human reads versus which columns
-- the platform compares.
--
--   Coded values are PLAINTEXT under RLS. The screening engine compares
--   them inside the PV1 command transaction on every screen, and a
--   column that must be decrypted row-by-row to be compared cannot be
--   indexed or filtered — which would push the comparison into
--   application memory, where a bug drops rows silently. The precedent
--   is `prescription.drugNdc`.
--
--   Narrative is an ENCRYPTED envelope, AAD-bound the same way
--   `prescription.sigEnc` is: `substanceLabelEnc` (what the patient
--   said) and `reactionNoteEnc`. Free text about a reaction reliably
--   carries more than the minimum necessary and is never compared, so
--   encryption costs nothing operationally.

-- ---------------------------------------------------------------------
-- 1. Vocabulary.
--
--    Real Postgres enums rather than the TEXT columns
--    `order_screening_finding` uses, and the difference is which
--    direction the vocabulary is expected to move. A screening finding
--    CODE is designed to grow — adding a check should not need a
--    migration. An `AllergyIntolerance` field is a closed FHIR value
--    set: adding a member is a clinical modelling decision that should
--    be reviewed, and a typo'd category would silently drop a record
--    out of screening.
-- ---------------------------------------------------------------------

CREATE TYPE "AllergyCategory" AS ENUM (
    'MEDICATION',
    'BIOLOGIC',
    'FOOD',
    'ENVIRONMENT'
);

CREATE TYPE "AllergyIntoleranceType" AS ENUM (
    'ALLERGY',
    'INTOLERANCE'
);

CREATE TYPE "AllergyCriticality" AS ENUM (
    'HIGH',
    'LOW',
    'UNABLE_TO_ASSESS'
);

CREATE TYPE "AllergyClinicalStatus" AS ENUM (
    'ACTIVE',
    'INACTIVE',
    'RESOLVED'
);

CREATE TYPE "AllergyVerificationStatus" AS ENUM (
    'CONFIRMED',
    'UNCONFIRMED',
    'REFUTED',
    'ENTERED_IN_ERROR'
);

CREATE TYPE "AllergyReactionSeverity" AS ENUM (
    'MILD',
    'MODERATE',
    'SEVERE'
);

CREATE TYPE "AllergyReactionManifestation" AS ENUM (
    'ANAPHYLAXIS',
    'ANGIOEDEMA',
    'BRONCHOSPASM',
    'HYPOTENSION',
    'URTICARIA',
    'RASH',
    'PRURITUS',
    'SEVERE_CUTANEOUS_REACTION',
    'NAUSEA_OR_VOMITING',
    'DIARRHEA',
    'ABDOMINAL_PAIN',
    'HEADACHE',
    'DIZZINESS',
    'HEPATOTOXICITY',
    'NEPHROTOXICITY',
    'CYTOPENIA',
    'OTHER'
);

CREATE TYPE "AllergySubstanceCodeSystem" AS ENUM (
    'RXNORM',
    'NDC',
    'SNOMED_CT',
    'PHARMAX_ALLERGEN_CLASS',
    'UNCODED'
);

CREATE TYPE "AllergyHistoryAssertionStatus" AS ENUM (
    'NO_KNOWN_ALLERGIES',
    'UNABLE_TO_ASSESS'
);

-- ---------------------------------------------------------------------
-- 2. patient_allergy
-- ---------------------------------------------------------------------

CREATE TABLE "patient_allergy" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    -- Copied from the patient at capture time so a clinic-scoped read
    -- does not have to join through `patient` to be safe. Never
    -- updated: it records where the history was taken.
    "clinicId" UUID NOT NULL,
    "patientId" UUID NOT NULL,

    "substanceCode" TEXT,
    "substanceCodeSystem" "AllergySubstanceCodeSystem" NOT NULL,
    "substanceLabelEnc" JSONB,

    "category" "AllergyCategory" NOT NULL,
    "type" "AllergyIntoleranceType" NOT NULL,
    "criticality" "AllergyCriticality" NOT NULL,
    "clinicalStatus" "AllergyClinicalStatus" NOT NULL DEFAULT 'ACTIVE',
    "verificationStatus" "AllergyVerificationStatus" NOT NULL DEFAULT 'UNCONFIRMED',

    "reactionManifestations" "AllergyReactionManifestation"[],
    "reactionSeverity" "AllergyReactionSeverity",
    "reactionNoteEnc" JSONB,

    "onsetDate" DATE,

    "recordedByUserId" UUID NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL,

    "statusChangedByUserId" UUID,
    "statusChangedAt" TIMESTAMP(3),
    "statusChangeReason" TEXT,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "patient_allergy_pkey" PRIMARY KEY ("id")
);

-- A coded system with no code, or a code with no system to read it in,
-- is a row the screen would skip in silence. The screening layer only
-- treats a record as screenable input when it carries a code in a
-- machine-comparable system, so this constraint is what stops an
-- unscreenable record from LOOKING screenable.
ALTER TABLE "patient_allergy"
    ADD CONSTRAINT "patient_allergy_substance_code_matches_system"
    CHECK (
        ("substanceCodeSystem" = 'UNCODED' AND "substanceCode" IS NULL)
        OR ("substanceCodeSystem" <> 'UNCODED' AND "substanceCode" IS NOT NULL)
    );

-- An UNCODED record is the only description of the allergen there is,
-- so it must actually describe something. Without this, "the patient
-- has an allergy but we do not know to what and did not write down what
-- they said" is storable, and it is worse than no record: it occupies
-- the space where a pharmacist would look for the answer.
ALTER TABLE "patient_allergy"
    ADD CONSTRAINT "patient_allergy_uncoded_requires_label"
    CHECK ("substanceCodeSystem" <> 'UNCODED' OR "substanceLabelEnc" IS NOT NULL);

-- Every status change carries a reason code, and the stamp is the user
-- plus the time. Enforced together because a status change with two of
-- the three is a change nobody can explain later.
ALTER TABLE "patient_allergy"
    ADD CONSTRAINT "patient_allergy_status_change_fully_stamped"
    CHECK (
        (
            "statusChangedByUserId" IS NULL
            AND "statusChangedAt" IS NULL
            AND "statusChangeReason" IS NULL
        )
        OR (
            "statusChangedByUserId" IS NOT NULL
            AND "statusChangedAt" IS NOT NULL
            AND "statusChangeReason" IS NOT NULL
        )
    );

CREATE INDEX "patient_allergy_organizationId_patientId_clinicalStatus_idx"
    ON "patient_allergy"("organizationId", "patientId", "clinicalStatus");
CREATE INDEX "patient_allergy_organizationId_clinicId_idx"
    ON "patient_allergy"("organizationId", "clinicId");
CREATE INDEX "patient_allergy_organizationId_substanceCode_idx"
    ON "patient_allergy"("organizationId", "substanceCode");

ALTER TABLE "patient_allergy" ADD CONSTRAINT "patient_allergy_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "patient_allergy" ADD CONSTRAINT "patient_allergy_clinicId_fkey"
    FOREIGN KEY ("clinicId") REFERENCES "clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "patient_allergy" ADD CONSTRAINT "patient_allergy_patientId_fkey"
    FOREIGN KEY ("patientId") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "patient_allergy" ADD CONSTRAINT "patient_allergy_recordedByUserId_fkey"
    FOREIGN KEY ("recordedByUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "patient_allergy" ADD CONSTRAINT "patient_allergy_statusChangedByUserId_fkey"
    FOREIGN KEY ("statusChangedByUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------
-- 3. patient_allergy_history_assertion
-- ---------------------------------------------------------------------

CREATE TABLE "patient_allergy_history_assertion" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "clinicId" UUID NOT NULL,
    "patientId" UUID NOT NULL,

    "status" "AllergyHistoryAssertionStatus" NOT NULL,

    "assertedByUserId" UUID NOT NULL,
    "assertedAt" TIMESTAMP(3) NOT NULL,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_allergy_history_assertion_pkey" PRIMARY KEY ("id")
);

-- "Latest assertion for this patient" is the only read shape, and the
-- DESC ordering means the planner reads one row rather than sorting the
-- patient's whole assertion history.
CREATE INDEX "patient_allergy_history_assertion_organizationId_patientId__idx"
    ON "patient_allergy_history_assertion"("organizationId", "patientId", "assertedAt" DESC);
CREATE INDEX "patient_allergy_history_assertion_organizationId_clinicId_idx"
    ON "patient_allergy_history_assertion"("organizationId", "clinicId");

ALTER TABLE "patient_allergy_history_assertion" ADD CONSTRAINT "patient_allergy_history_assertion_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "patient_allergy_history_assertion" ADD CONSTRAINT "patient_allergy_history_assertion_clinicId_fkey"
    FOREIGN KEY ("clinicId") REFERENCES "clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "patient_allergy_history_assertion" ADD CONSTRAINT "patient_allergy_history_assertion_patientId_fkey"
    FOREIGN KEY ("patientId") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "patient_allergy_history_assertion" ADD CONSTRAINT "patient_allergy_history_assertion_assertedByUserId_fkey"
    FOREIGN KEY ("assertedByUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------
-- 4. Grants.
--
--    patient_allergy: SELECT, INSERT, UPDATE — and DELETE explicitly
--    revoked. Retraction is a status change, not a removal.
--
--    patient_allergy_history_assertion: SELECT, INSERT only.
-- ---------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON TABLE "patient_allergy" TO pharmax_app, pharmax_system;
REVOKE DELETE ON TABLE "patient_allergy" FROM pharmax_app, pharmax_system;

GRANT SELECT, INSERT ON TABLE "patient_allergy_history_assertion" TO pharmax_app, pharmax_system;
REVOKE UPDATE, DELETE ON TABLE "patient_allergy_history_assertion" FROM pharmax_app, pharmax_system;

-- ---------------------------------------------------------------------
-- 5. Row-level security: enabled AND forced on both tables.
--
--    Policies are split per command rather than a single FOR ALL, so
--    the DML a table does not permit has no policy to permit it. A
--    future grant that re-opened DELETE on `patient_allergy` would
--    still be denied here.
-- ---------------------------------------------------------------------

ALTER TABLE "patient_allergy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patient_allergy" FORCE  ROW LEVEL SECURITY;

ALTER TABLE "patient_allergy_history_assertion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patient_allergy_history_assertion" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_select ON "patient_allergy"
  FOR SELECT
  USING (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  );

CREATE POLICY tenant_isolation_insert ON "patient_allergy"
  FOR INSERT
  WITH CHECK (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  );

-- USING and WITH CHECK both, so a cross-tenant row cannot be targeted
-- AND an update cannot move a row into another tenant.
CREATE POLICY tenant_isolation_update ON "patient_allergy"
  FOR UPDATE
  USING (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  )
  WITH CHECK (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  );

CREATE POLICY tenant_isolation_select ON "patient_allergy_history_assertion"
  FOR SELECT
  USING (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  );

CREATE POLICY tenant_isolation_insert ON "patient_allergy_history_assertion"
  FOR INSERT
  WITH CHECK (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  );

-- ---------------------------------------------------------------------
-- 6. Table comments.
-- ---------------------------------------------------------------------

COMMENT ON TABLE "patient_allergy" IS
  'One recorded allergy or intolerance, modelled on HL7 FHIR R4 AllergyIntolerance. Coded values (substance code + code system, category, type, criticality, clinical/verification status, reaction manifestations and severity) are plaintext under tenant RLS because the PV1 screening engine compares them in-transaction; narrative (substanceLabelEnc, reactionNoteEnc) is an AAD-bound encrypted envelope. Retraction is verificationStatus = ENTERED_IN_ERROR or REFUTED with a reason code — DELETE is revoked at the grant layer and has no RLS policy, so clinical data is corrected rather than erased.';

COMMENT ON TABLE "patient_allergy_history_assertion" IS
  'A patient-level assertion about the allergy HISTORY rather than about a substance: NO_KNOWN_ALLERGIES (asked, nothing found — this is what lets the allergy screening axis report clear) or UNABLE_TO_ASSESS (asked, no answer obtainable — deliberately does NOT satisfy the axis). Exists because an empty allergy list is otherwise ambiguous between "screened and clear" and "never screened". Append-only: the current assertion is the most recent row, and a superseded one is the record of who said what, when.';
