// Frozen rejection-reason registries for the verification stages.
//
// Why this lives in `@pharmax/verification` and not in the Prisma
// schema as an enum:
//
//   The `verification_record.rejectionReasonCode` column is
//   intentionally a `TEXT` field (see the migration comment at
//   `20260525000000_phase2_verification_record/migration.sql`,
//   block 2). The schema architect chose a string + handler-frozen
//   list over a Postgres enum because:
//
//     - Reason vocabularies grow over time as pharmacies learn what
//       their PV1/Final pharmacists actually reject for. Adding a
//       new code to a Postgres enum requires a migration that
//       rewrites every dependent table on some Postgres versions; a
//       handler-frozen list is a code change.
//     - Different pharmacies (in the future, per-tenant policy
//       slices) may want different vocabularies. A handler-frozen
//       list can branch on `policy.id`; a Postgres enum is global.
//     - Reporting still works — the column is indexed
//       `(organizationId, stage, decision, occurredAt)`, and reason
//       distribution rolls up by string equality just as well as by
//       enum equality.
//
// Why TWO registries (PV1 vs. Final) instead of one unified list:
//
//   PV1 rejection reasons describe TYPING errors (typist input
//   doesn't match the source script). Final rejection reasons
//   describe FILL errors (the wrong drug/strength is in the vial,
//   the label is wrong, the lot is wrong). Different operator
//   audiences, different remediation flows. A unified list would
//   either be over-broad ("PRESCRIBER_VERIFICATION_NEEDED" makes
//   no sense at Final) or generic enough to be useless for reports
//   ("DATA_ENTRY_ERROR" — at which stage?). Split lists let the
//   reporting view group rejections by stage AND reason cleanly.
//
// PHI invariant: every code here is OPERATIONAL VOCABULARY, not
// patient or prescription data. Storing the code in
// `verification_record.rejectionReasonCode` is PHI-safe. The
// optional free-text note that may follow in a later slice would
// be PHI-adjacent (it could mention the patient by indirect
// reference); that lands as a separate ENCRYPTED column when it
// ships, NOT as additions to this list.

/**
 * Frozen list of valid PV1 rejection-reason codes.
 *
 * `as const` + readonly tuple = compile-time exhaustiveness on the
 * type AND a runtime list the handler can `.includes()`-check.
 *
 * Listed in approximate frequency-of-use order (most common first)
 * to make the eventual UI dropdown easier to scan. Order is NOT
 * semantically significant — change it freely for UX reasons.
 */
export const PV1_REJECTION_REASONS = [
  // Typist transcribed the strength or quantity wrong.
  "DOSE_INCORRECT",
  // The "sig" (directions for use) is ambiguous, illegible, or missing.
  "SIG_AMBIGUOUS",
  // Required clinical info (DOB, weight, indication, allergies, etc.)
  // is missing or invalid on the typed prescription.
  "MISSING_INFO",
  // Typo or transcription error in the typed record (drug name,
  // patient, prescriber, etc.) — typist needs to re-enter.
  "DATA_ENTRY_ERROR",
  // Clinically significant drug-drug or drug-disease interaction
  // requires resolution before fill.
  "DRUG_INTERACTION",
  // Patient allergy on file conflicts with the prescribed drug.
  "ALLERGY_CONFLICT",
  // Duplicate active therapy (same drug or same class) already on
  // the patient's profile.
  "DUPLICATE_THERAPY",
  // Need to call the prescriber to clarify the script — handoff to
  // a pharmacist intervention queue.
  "PRESCRIBER_VERIFICATION_NEEDED",
  // Insurance requires prior authorization before this drug can be
  // dispensed; order parked until PA returns.
  "INSURANCE_PRIOR_AUTH_REQUIRED",
  // Drug is not in formulary, not in inventory, or backordered —
  // typist needs to swap to an equivalent or contact prescriber for
  // a substitution.
  "DRUG_UNAVAILABLE",
  // Escape hatch. Required to be paired with a free-text note in a
  // future slice (the note will land in an encrypted column on
  // `verification_record` because it may carry PHI-adjacent detail).
  "OTHER",
] as const;

export type PV1RejectionReason = (typeof PV1_REJECTION_REASONS)[number];

/**
 * O(1) membership check. The `Set` is built once at module load and
 * reused across every RejectPV1 invocation — the registry never
 * changes at runtime.
 */
export const PV1_REJECTION_REASONS_SET: ReadonlySet<PV1RejectionReason> = new Set(
  PV1_REJECTION_REASONS
);

/**
 * Type guard. Use at the validation boundary — the Zod schema in
 * `reject-pv1.ts` uses this list, so a successful Zod parse
 * already guarantees the code is in the set. This guard exists for
 * defense-in-depth (e.g., a future code path that loads a reason
 * code from a DB row and wants to narrow the type).
 */
export function isPV1RejectionReason(value: string): value is PV1RejectionReason {
  return PV1_REJECTION_REASONS_SET.has(value as PV1RejectionReason);
}

/**
 * Frozen list of valid Final-verification rejection-reason codes.
 *
 * Final rejection is the second pharmacist refusing to release a
 * FILLED vial. By this point the typing has already passed PV1 —
 * what's failing here is the PHYSICAL fill: the wrong NDC is in
 * the vial, the strength is wrong, the label is wrong, the lot is
 * expired/held, the vial is damaged, etc. Different operator
 * audience (fill tech, not typist) and different remediation
 * (re-pull, re-label, re-assign lot — not re-type), so this is a
 * separate vocabulary from `PV1_REJECTION_REASONS`. Splitting also
 * keeps the reporting stage-aware: "rejections-by-reason at
 * Final" rolls up FILL-error vocabulary; "rejections-by-reason
 * at PV1" rolls up typing-error vocabulary.
 *
 * Several codes here pin specific workflow-safety rules that the
 * platform commits to (see `.cursor/rules/01-workflow-safety.mdc`)
 * so an operator can call out the precise compliance category in
 * the reason metadata — `EXPIRED_LOT_ASSIGNED` and
 * `HELD_LOT_ASSIGNED` are the "No expired lot assignment" and
 * "No held lot assignment" rules respectively, and
 * `LABEL_DAMAGED` covers "No silent printer failures" reaching
 * the vial.
 *
 * Listed in approximate frequency-of-use order (most common
 * first) to make the eventual UI dropdown easier to scan. Order
 * is NOT semantically significant — change it freely for UX
 * reasons.
 */
export const FINAL_REJECTION_REASONS = [
  // Wrong NDC pulled from inventory — the drug in the vial is not
  // the drug on the prescription.
  "WRONG_DRUG_PULLED",
  // Right drug, wrong strength (e.g. 5mg pulled when 10mg was
  // prescribed).
  "WRONG_STRENGTH",
  // Count or days-supply doesn't match prescription (e.g. 30
  // tablets when 90 were ordered).
  "WRONG_QUANTITY",
  // Vial label has wrong patient, wrong sig, wrong prescriber, or
  // wrong drug info. Label re-print required.
  "LABEL_INCORRECT",
  // Print quality issue — smeared, faded, partially printed,
  // barcode unreadable. Triggers the "No silent printer failures"
  // workflow-safety rule's audit trail; re-print required.
  "LABEL_DAMAGED",
  // Lot assigned to the fill is past its expiration date. Pins
  // the "No expired lot assignment" workflow-safety rule. The
  // upstream `AssignLot` command should reject expired lots at
  // input, but this code exists for the case where a lot expired
  // between assignment and final review.
  "EXPIRED_LOT_ASSIGNED",
  // Lot assigned to the fill is in HELD status (recall, quality
  // hold, inventory quarantine). Pins the "No held lot
  // assignment" workflow-safety rule.
  "HELD_LOT_ASSIGNED",
  // Required auxiliary warning label (e.g. "TAKE WITH FOOD",
  // "MAY CAUSE DROWSINESS", "REFRIGERATE") is missing from the
  // vial.
  "MISSING_AUXILIARY_LABEL",
  // Vial is cracked, leaking, contaminated, or otherwise
  // physically compromised. Discard + refill.
  "VIAL_INTEGRITY",
  // The filled vial is matched to the wrong patient profile (e.g.
  // two patients with similar names; tech grabbed the wrong
  // basket). Rare but a critical safety event.
  "WRONG_PATIENT_ASSIGNED",
  // Escape hatch. Required to be paired with a free-text note in
  // a future slice (the note will land in an encrypted column on
  // `verification_record` because it may carry PHI-adjacent
  // detail).
  "OTHER",
] as const;

export type FinalRejectionReason = (typeof FINAL_REJECTION_REASONS)[number];

/**
 * O(1) membership check, mirroring `PV1_REJECTION_REASONS_SET`.
 */
export const FINAL_REJECTION_REASONS_SET: ReadonlySet<FinalRejectionReason> = new Set(
  FINAL_REJECTION_REASONS
);

/**
 * Type guard. Same defense-in-depth role as `isPV1RejectionReason`.
 */
export function isFinalRejectionReason(value: string): value is FinalRejectionReason {
  return FINAL_REJECTION_REASONS_SET.has(value as FinalRejectionReason);
}
