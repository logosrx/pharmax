// Error codes for the PV1 clinical-screening gate.
//
// ERROR CLASS IS THE HTTP CONTRACT. The v1 partner API derives its
// status code from the thrown error's class, so picking the class is
// picking the status a partner integration sees. Every refusal here is
// `InvariantViolationError` → 422, except the one that is genuinely a
// state race, which is `ConflictError` → 409:
//
//   - 422 says "your request was well-formed and the system
//     understood it; a business rule refused it." A hard stop, a
//     missing acknowledgement and a stale fingerprint are all that.
//     They are also all ACTIONABLE by the caller — retrying unchanged
//     will fail identically, which is exactly what 422 promises and
//     409 does not.
//   - 400 would be wrong: nothing about the request is malformed.
//   - 403 would be wrong: the pharmacist is authorized. The system is
//     refusing the ACT, not the actor.
//   - 409 is reserved here for "the order moved under you", which is
//     retryable after a refetch (`@pharmax/platform-core`'s
//     `ConflictError` header makes that distinction explicitly:
//     ConflictError volume is a concurrency signal,
//     InvariantViolationError volume is a UX/training signal).
//
// SEPARATE CODES FOR SEPARATE REFUSALS. The two gate failures are
// deliberately distinct codes rather than one "screening blocked",
// because the console has to say two different things and offer two
// different next actions. A hard stop has NO override path — the
// pharmacist's move is to call the prescriber, and the UI must not
// render a dismiss affordance. A missing acknowledgement is a
// decision the pharmacist can make right now, in the console,
// finding by finding. Collapsing them into one code would force the
// UI to guess from a message string.

/**
 * At least one finding's disposition is `HARD_STOP`.
 *
 * There is no override. Per `dispositionFor`, this requires maximum
 * severity AND certainty together — a confirmed high-criticality
 * immune-mediated allergy to the exact ingredient, or an interaction
 * the licensed knowledge source itself grades CONTRAINDICATED and
 * DEFINITE. The engine is built so nothing it infers on its own can
 * reach this tier.
 *
 * Class: `InvariantViolationError` (422).
 */
export const PV1_SCREENING_HARD_STOP = "PV1_SCREENING_HARD_STOP";

/**
 * One or more findings requiring acknowledgement have not been
 * acknowledged BY THE PHARMACIST WHO IS APPROVING.
 *
 * A colleague's acknowledgement, or one this pharmacist gave on a
 * different order, does not satisfy this. The metadata carries the
 * outstanding fingerprints so the console can highlight exactly which
 * findings still need a decision.
 *
 * Class: `InvariantViolationError` (422).
 */
export const PV1_SCREENING_ACKNOWLEDGEMENT_REQUIRED = "PV1_SCREENING_ACKNOWLEDGEMENT_REQUIRED";

/**
 * The order carried no prescription lines to screen.
 *
 * Raised rather than returning "no findings", because zero findings
 * from a screen that never ran is indistinguishable from a clean bill
 * of health.
 *
 * Class: `InvariantViolationError` (422).
 */
export const PV1_SCREENING_NOT_PERFORMED = "PV1_SCREENING_NOT_PERFORMED";

/**
 * The patient's active-medication profile exceeds the screening cap.
 *
 * Refused rather than truncated: screening against an arbitrary
 * subset of a profile produces a confident, incomplete answer.
 *
 * Class: `InvariantViolationError` (422).
 */
export const PV1_SCREENING_PROFILE_TOO_LARGE = "PV1_SCREENING_PROFILE_TOO_LARGE";

/**
 * The fingerprint being acknowledged does not match any finding
 * persisted for this order.
 *
 * The usual cause is honest: a re-screen produced different findings
 * (the profile moved, or the prescription was edited) and the
 * console is holding a stale list. It is also the guard that stops a
 * client pre-acknowledging fingerprints it has computed but never
 * been shown.
 *
 * Class: `InvariantViolationError` (422).
 */
export const PV1_SCREENING_FINDING_UNKNOWN = "PV1_SCREENING_FINDING_UNKNOWN";

/**
 * The finding exists but its disposition is not
 * `REQUIRES_ACKNOWLEDGEMENT`.
 *
 * Acknowledging a HARD_STOP must fail loudly: an unoverridable
 * finding that could be acknowledged would not be unoverridable, just
 * slower. Acknowledging an INFORMATIONAL finding is meaningless and
 * would put a judgement on record that nothing asked for.
 *
 * Class: `InvariantViolationError` (422).
 */
export const PV1_SCREENING_FINDING_NOT_ACKNOWLEDGEABLE =
  "PV1_SCREENING_FINDING_NOT_ACKNOWLEDGEABLE";

/**
 * The order is not in `PV1_IN_PROGRESS`, so there is no review in
 * which to record a judgement.
 *
 * Class: `ConflictError` (409) — the order's state is the problem,
 * and the caller's move is to refetch, not to change the request.
 * Same class the PV1 state-transition failures already use.
 */
export const PV1_SCREENING_STAGE_INVALID = "PV1_SCREENING_STAGE_INVALID";
