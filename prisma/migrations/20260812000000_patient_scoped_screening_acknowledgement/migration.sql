-- Patient-scoped screening acknowledgements: one judgement per
-- pharmacist per PATIENT for a patient-record gap, instead of one per
-- order.
--
-- The problem this solves: `SCR_ALLERGY_INPUT_UNAVAILABLE` ("nobody
-- has taken this patient's allergy history") is a fact about the
-- STATE OF THE PATIENT'S RECORD, not about any one fill. It is
-- byte-identical on every order the patient has, so keying its
-- acknowledgement by order — as `order_screening_acknowledgement`
-- does, correctly, for clinical findings — charges a pharmacist
-- twelve identical acknowledgements of one unchanged fact across
-- twelve monthly refills. That is the alert-fatigue machine the
-- screening tiers were built to dismantle, rebuilt one key too wide.
--
-- WHAT MAY NEVER LIVE HERE. A clinical finding (interaction, allergy
-- match, dose violation) is an input to a dispensing decision; every
-- fill is a NEW dispensing decision, and DUR overrides are per-fill
-- events. The CHECK constraints below are the database's own refusal
-- to hold a patient-scoped acknowledgement of a clinical finding —
-- the gate and the command enforce the same rule in TypeScript, but
-- this is the layer a handler bug cannot reach around. The code list
-- is deliberately a closed CHECK rather than open TEXT: widening the
-- patient scope to a new gap code is a schema change somebody has to
-- review, not a string a caller can send.
--
-- RE-ARMING. `recordStateToken` hashes the patient's allergy-record
-- neighbourhood at acknowledgement time; the PV1 gate honors a row
-- only while the current state still hashes to the same value. The
-- source tables (`patient_allergy`,
-- `patient_allergy_history_assertion`) are append-only / no-DELETE by
-- grant and RLS, so the token is monotonic in practice: record-then-
-- retract leaves both edits visible to the hash forever, and a
-- years-old acknowledgement can never silently suppress a gap that
-- re-arose after data was entered-in-error. A re-armed gap takes a
-- FRESH row with the new token — hence the token in the unique key —
-- and this table needs no UPDATE grant to stay honest.
--
-- PHI. Codes, ids, and a SHA-256 over record ids + coded statuses.
-- No patient identifier beyond the FK, no drug name, no narrative.

-- ---------------------------------------------------------------------
-- 1. patient_screening_acknowledgement
-- ---------------------------------------------------------------------

CREATE TABLE "patient_screening_acknowledgement" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "patientId" UUID NOT NULL,

    -- Provenance: the order under review when the judgement was
    -- recorded. NOT part of the matching key — the gate matches on
    -- the patient.
    "orderId" UUID NOT NULL,

    -- The PER_SUBJECT screening axis whose record-state gap this
    -- settles.
    "axis" TEXT NOT NULL,

    "fingerprint" TEXT NOT NULL,
    -- Copied from the persisted finding, never taken from the caller.
    "findingCode" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "certainty" TEXT NOT NULL,

    "recordStateToken" TEXT NOT NULL,

    "pharmacistUserId" UUID NOT NULL,

    "workflowPolicyId" UUID NOT NULL,
    "workflowPolicyVersion" INTEGER NOT NULL,

    "commandLogId" UUID NOT NULL,
    "acknowledgedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_screening_acknowledgement_pkey" PRIMARY KEY ("id")
);

-- The structural boundary of the feature. Only the gap codes minted
-- for PER_SUBJECT axes (`NOT_RECORDED_FOR_SUBJECT`) may be
-- patient-scoped. A clinical finding's code cannot be inserted here
-- under any handler, which is what makes "the gate cannot consume a
-- patient-scoped acknowledgement for a clinical finding" a property
-- of the database rather than of the query that reads it. Adding a
-- new patient-level axis extends BOTH lists in one reviewed
-- migration.
ALTER TABLE "patient_screening_acknowledgement"
    ADD CONSTRAINT "patient_screening_acknowledgement_code_patient_record_gap"
    CHECK ("findingCode" IN ('SCR_ALLERGY_INPUT_UNAVAILABLE'));

ALTER TABLE "patient_screening_acknowledgement"
    ADD CONSTRAINT "patient_screening_acknowledgement_axis_per_subject"
    CHECK ("axis" IN ('DRUG_ALLERGY'));

CREATE UNIQUE INDEX "patient_screening_acknowledgement_org_patient_pharm_fp_tok_key"
    ON "patient_screening_acknowledgement"("organizationId", "patientId", "pharmacistUserId", "fingerprint", "recordStateToken");

CREATE INDEX "patient_screening_acknowledgement_org_patient_pharmacist_idx"
    ON "patient_screening_acknowledgement"("organizationId", "patientId", "pharmacistUserId");
CREATE INDEX "patient_screening_acknowledgement_org_pharmacist_at_idx"
    ON "patient_screening_acknowledgement"("organizationId", "pharmacistUserId", "acknowledgedAt");

ALTER TABLE "patient_screening_acknowledgement" ADD CONSTRAINT "patient_screening_acknowledgement_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "patient_screening_acknowledgement" ADD CONSTRAINT "patient_screening_acknowledgement_patientId_fkey"
    FOREIGN KEY ("patientId") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "patient_screening_acknowledgement" ADD CONSTRAINT "patient_screening_acknowledgement_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "patient_screening_acknowledgement" ADD CONSTRAINT "patient_screening_acknowledgement_pharmacistUserId_fkey"
    FOREIGN KEY ("pharmacistUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "patient_screening_acknowledgement" ADD CONSTRAINT "patient_screening_acknowledgement_workflowPolicyId_fkey"
    FOREIGN KEY ("workflowPolicyId") REFERENCES "workflow_policy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "patient_screening_acknowledgement" ADD CONSTRAINT "patient_screening_acknowledgement_commandLogId_fkey"
    FOREIGN KEY ("commandLogId") REFERENCES "command_log"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------
-- 2. Grants — append-only, same posture as the order-scoped table.
--    Staleness is a comparison against `recordStateToken`, never an
--    UPDATE, so nothing legitimate ever needs to touch a row again.
-- ---------------------------------------------------------------------

GRANT SELECT, INSERT ON TABLE "patient_screening_acknowledgement" TO pharmax_app, pharmax_system;
REVOKE UPDATE, DELETE ON TABLE "patient_screening_acknowledgement" FROM pharmax_app, pharmax_system;

-- ---------------------------------------------------------------------
-- 3. Row-level security: enabled AND forced, split per-command
--    policies — identical posture to order_screening_acknowledgement.
-- ---------------------------------------------------------------------

ALTER TABLE "patient_screening_acknowledgement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patient_screening_acknowledgement" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_select ON "patient_screening_acknowledgement"
  FOR SELECT
  USING (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  );

CREATE POLICY tenant_isolation_insert ON "patient_screening_acknowledgement"
  FOR INSERT
  WITH CHECK (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  );

-- ---------------------------------------------------------------------
-- 4. Table comment.
-- ---------------------------------------------------------------------

COMMENT ON TABLE "patient_screening_acknowledgement" IS
  'A pharmacist''s recorded judgement on one PATIENT-RECORD screening gap, keyed by (organization, patient, pharmacist, fingerprint, recordStateToken). Honored by the PV1 gate only while the patient''s allergy-record state still hashes to recordStateToken, so a gap that re-arises after data was entered-in-error prompts afresh. CHECK constraints confine the table to the gap codes minted for PER_SUBJECT axes — a clinical finding can never be patient-scoped. Append-only by grant, RLS and explicit REVOKE.';
