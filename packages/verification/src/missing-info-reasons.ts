// Frozen reason-code registry for MarkTypingMissingInfo.
//
// The typist hits a missing-info wall when something blocks the
// transcription: an unclear prescription, an unreachable
// prescriber, a missing field, etc. Each reason is OPERATIONAL
// VOCABULARY (PHI-free) — the closed enum keeps the action
// queryable across rework reports without joining a free-text
// note column. The enum stays small and surgical; reasons here
// drive both ops dashboards ("how often does prescriber-callback
// block typing this month?") and the actionable hint shown on
// the typist's queue card after the order pauses.
//
// Why these eight values:
//   - PRESCRIBER_CALLBACK_REQUIRED: the most common pause —
//     prescription has an ambiguity (dose, route, formulation,
//     etc.) that the prescriber must clarify.
//   - PATIENT_CONTACT_REQUIRED: the typist needs to verify
//     identity, address, allergies, or DOB with the patient.
//   - INSURANCE_VERIFICATION_REQUIRED: e-script accepted but
//     coverage / PA / formulary block the fill until pharmacy
//     billing resolves the insurance situation.
//   - PRESCRIPTION_ILLEGIBLE: paper Rx where handwriting can't
//     be parsed; needs a re-scan or a prescriber callback.
//   - MISSING_QUANTITY / MISSING_DAYS_SUPPLY / MISSING_REFILLS:
//     mandatory transcription fields not present on the
//     incoming script. Distinct codes for distinct reports.
//   - OTHER: catch-all. Operators are encouraged to file a
//     ticket if OTHER becomes the dominant code for an ops
//     window — that signals the enum needs a new entry.
//
// The enum is exhaustive at the Zod boundary; the DB has no
// matching CHECK today (the workflow engine treats this as a
// transition without storing structured state — only the
// `audit_log` row carries the reason). A future
// `typing_missing_info` table will add a CHECK that mirrors this
// enum for hard belt + suspenders.

export const MISSING_INFO_REASONS = [
  "PRESCRIBER_CALLBACK_REQUIRED",
  "PATIENT_CONTACT_REQUIRED",
  "INSURANCE_VERIFICATION_REQUIRED",
  "PRESCRIPTION_ILLEGIBLE",
  "MISSING_QUANTITY",
  "MISSING_DAYS_SUPPLY",
  "MISSING_REFILLS",
  "OTHER",
] as const;

export type MissingInfoReason = (typeof MISSING_INFO_REASONS)[number];

export const MISSING_INFO_REASONS_SET: ReadonlySet<MissingInfoReason> = new Set(
  MISSING_INFO_REASONS
);

export function isMissingInfoReason(value: string): value is MissingInfoReason {
  return MISSING_INFO_REASONS_SET.has(value as MissingInfoReason);
}
