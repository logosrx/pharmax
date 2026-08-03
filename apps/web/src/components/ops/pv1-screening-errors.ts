// Operator-facing wording for every way the PV1 clinical-screening
// gate can refuse.
//
// The command's own messages are written for the caller of an API:
// accurate, and phrased as a statement of what the rule is. A
// pharmacist mid-review needs the next move instead — and critically,
// needs the two gate refusals to read as DIFFERENT situations. A hard
// stop has no way through it and the honest instruction is "reject and
// call the prescriber". A missing acknowledgement is a decision they
// can make right now, finding by finding, on the order page. Rendering
// both as one red box with a raw error string in it is how a safety
// control becomes something operators route around.
//
// Returns `null` for anything that is not a screening refusal, so a
// caller falls back to the generic flash banner rather than dressing
// an unrelated failure in screening language.
//
// The codes are IMPORTED, not mirrored: every consumer of this module
// is a Server Component, so there is no bundle reason to copy them,
// and a rename in `@pharmax/verification` should fail the build here
// rather than silently stop matching.

import {
  PV1_SCREENING_ACKNOWLEDGEMENT_REQUIRED,
  PV1_SCREENING_FINDING_NOT_ACKNOWLEDGEABLE,
  PV1_SCREENING_FINDING_UNKNOWN,
  PV1_SCREENING_HARD_STOP,
  PV1_SCREENING_NOT_PERFORMED,
  PV1_SCREENING_STAGE_INVALID,
} from "@pharmax/verification";

export interface Pv1ScreeningErrorMessage {
  /** The typed code, kept visible so an escalation can name it. */
  readonly code: string;
  /** Banner heading — what happened, in the pharmacist's vocabulary. */
  readonly title: string;
  /** What to do about it. */
  readonly guidance: string;
  readonly tone: "danger" | "warning";
  /**
   * Whether the panel is where this gets resolved. False for a hard
   * stop — there is nothing to acknowledge — so a caller must not
   * offer "go and acknowledge them" as the way out.
   */
  readonly resolvableByAcknowledgement: boolean;
}

const MESSAGES: Readonly<Record<string, Omit<Pv1ScreeningErrorMessage, "code">>> = Object.freeze({
  [PV1_SCREENING_HARD_STOP]: {
    title: "This prescription cannot pass PV1 as written",
    guidance:
      "Clinical screening returned a finding with no override path, so there is nothing to acknowledge and no way to sign it. Reject the order with the matching reason and contact the prescriber. The finding, its grading and its source are on the order's clinical screening panel.",
    tone: "danger",
    resolvableByAcknowledgement: false,
  },
  [PV1_SCREENING_ACKNOWLEDGEMENT_REQUIRED]: {
    title: "Approval refused — findings are waiting on your judgement",
    guidance:
      "One or more screening findings need an acknowledgement from you specifically. A colleague's acknowledgement of the same finding does not satisfy your approval. Open the order, read each outstanding finding on the clinical screening panel, acknowledge them there, then approve.",
    tone: "warning",
    resolvableByAcknowledgement: true,
  },
  [PV1_SCREENING_FINDING_UNKNOWN]: {
    title: "That finding is no longer on this order's latest screen",
    guidance:
      "Nothing was recorded. The usual cause is honest: the order was screened again — the patient's profile moved, or the prescription was edited — and the panel you were reading is stale. Reload the order and work from the findings it shows now.",
    tone: "warning",
    resolvableByAcknowledgement: true,
  },
  [PV1_SCREENING_FINDING_NOT_ACKNOWLEDGEABLE]: {
    title: "That finding cannot be acknowledged",
    guidance:
      "Either it has no override path, or it is informational and nothing is being asked of you. Neither is settled by an acknowledgement. Reload the order to see its current disposition.",
    tone: "warning",
    resolvableByAcknowledgement: false,
  },
  [PV1_SCREENING_STAGE_INVALID]: {
    title: "This order is not in PV1 review",
    guidance:
      "A judgement only counts while the review is open, so acknowledgements are refused once the order has moved on. Someone else may have approved, rejected, or put it on hold while you were reading. Reload the order.",
    tone: "warning",
    resolvableByAcknowledgement: false,
  },
  [PV1_SCREENING_NOT_PERFORMED]: {
    title: "No screen could be run for this order",
    guidance:
      "The order carries no prescription lines, so there was nothing to screen — and an unscreened order is not approvable. This is a data fault rather than a clinical one: reject it back to typing so the lines can be entered.",
    tone: "danger",
    resolvableByAcknowledgement: false,
  },
});

/**
 * Turn the `?error=` payload an ops dispatch redirect carries — the
 * `"<CODE>: <message>"` shape `dispatchOpsCommand` builds — into
 * screening-specific wording, or `null` if it is not a screening
 * refusal.
 *
 * The command's own message is deliberately NOT appended: it says the
 * same thing less usefully, and two overlapping explanations read
 * worse than one good one.
 */
export function describePv1ScreeningError(raw: string | null): Pv1ScreeningErrorMessage | null {
  if (raw === null) return null;
  const separator = raw.indexOf(":");
  const code = (separator === -1 ? raw : raw.slice(0, separator)).trim();
  const message = MESSAGES[code];
  return message === undefined ? null : { code, ...message };
}
