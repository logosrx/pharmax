-- Rx number allocation.
--
-- A prescription number is not cosmetic. It is printed on the vial
-- label, quoted by the patient on the phone, reported to the state
-- PDMP, and read back by a DEA inspector who expects the series to be
-- dense and monotonic. It therefore cannot be a random id, cannot be
-- typed by a technician, and cannot be derived from `MAX(rx_number) +
-- 1` (two concurrent transcriptions would read the same maximum and
-- collide on the unique constraint, or worse, both succeed under a
-- weaker isolation level).
--
-- This table is the allocator: one counter row per (organization,
-- clinic), incremented inside the transcribing transaction. The
-- increment takes a row lock, so concurrent transcriptions for the
-- same clinic serialize on that lock and each receives a distinct,
-- consecutive number. Transcriptions for DIFFERENT clinics touch
-- different rows and do not contend.
--
-- Why (organization, clinic) and not (organization, pharmacy site):
-- `prescription` carries no siteId — the dispensing site is a property
-- of the ORDER, not of the prescription — and the existing uniqueness
-- guarantee is `prescription(organizationId, clinicId, rxNumber)`. The
-- allocator's granularity is deliberately identical to that
-- constraint's, because any other choice would either over-serialize
-- (coarser) or permit duplicates (finer). If Rx numbers are later
-- re-scoped to the pharmacy site — the more common retail model — the
-- constraint and this table must move together, in one migration.
--
-- A rolled-back transaction consumes its number. That is intentional:
-- the alternative (returning numbers to a free list) makes the series
-- non-monotonic, which is worse for the audit story than a gap. Gaps
-- are explainable; reused numbers are not.

CREATE TABLE "rx_number_sequence" (
    "organizationId" UUID NOT NULL,
    "clinicId" UUID NOT NULL,

    -- Last value HANDED OUT, not the next one to hand out. Starts at
    -- 0, so the first allocation returns 1 and the column always
    -- answers "how many prescriptions has this clinic ever been
    -- allocated" without an off-by-one.
    "lastValue" INTEGER NOT NULL DEFAULT 0,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rx_number_sequence_pkey" PRIMARY KEY ("organizationId", "clinicId")
);

ALTER TABLE "rx_number_sequence"
    ADD CONSTRAINT "rx_number_sequence_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "rx_number_sequence"
    ADD CONSTRAINT "rx_number_sequence_clinicId_fkey"
    FOREIGN KEY ("clinicId") REFERENCES "clinic"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- The counter must never run backwards, including via a buggy future
-- migration or a hand-edit in psql. A CHECK cannot express "never
-- decreases", but it can express "never negative", which catches the
-- overflow-wraparound and the accidental `SET lastValue = -1` reset.
ALTER TABLE "rx_number_sequence"
    ADD CONSTRAINT "rx_number_sequence_lastValue_nonneg"
    CHECK ("lastValue" >= 0);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "rx_number_sequence"
    TO pharmax_app, pharmax_system;

ALTER TABLE "rx_number_sequence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rx_number_sequence" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "rx_number_sequence"
    USING (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    )
    WITH CHECK (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    );

COMMENT ON TABLE "rx_number_sequence" IS
  'Per-(organization, clinic) prescription-number allocator. Incremented inside the CreatePrescription transaction; the row lock serializes concurrent transcriptions for one clinic so the Rx series stays dense and monotonic. Granularity deliberately mirrors the prescription(organizationId, clinicId, rxNumber) unique constraint. Rolled-back transactions consume their number — gaps are acceptable, reuse is not.';
