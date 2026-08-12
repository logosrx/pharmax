-- Narrow the UPDATE grant on patient_allergy from table-wide to the
-- status-amendment columns only.
--
-- WHY. The only legitimate updater of this table is
-- AmendPatientAllergyStatus, and the only thing it may change is the
-- record's status plus the stamp that explains the change. Every other
-- column is CONTENT — what the allergy is — and content is corrected by
-- retiring the record and recording a new one, never edited in place.
--
-- Until now that rule was command discipline: the table-wide UPDATE
-- grant meant a future recode-in-place command could quietly rewrite
-- substanceCode or category on a live record. That matters beyond
-- hygiene, because patient-scoped screening acknowledgements pin a hash
-- of the patient's allergy-record neighbourhood (recordStateToken). A
-- recode-in-place that flipped a record's screenability without moving
-- that hash would leave a stale acknowledgement standing over findings
-- the pharmacist never saw. With this grant, that command cannot be
-- written without a migration that re-opens the columns — a diff a
-- reviewer sees.
--
-- updatedAt is included because Prisma's @updatedAt touches it on every
-- update; it carries no clinical meaning.

REVOKE UPDATE ON TABLE "patient_allergy" FROM pharmax_app, pharmax_system;

GRANT UPDATE (
    "clinicalStatus",
    "verificationStatus",
    "statusChangedByUserId",
    "statusChangedAt",
    "statusChangeReason",
    "updatedAt"
) ON TABLE "patient_allergy" TO pharmax_app, pharmax_system;
