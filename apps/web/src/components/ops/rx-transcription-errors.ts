// Operator-facing wording for every way `CreatePrescription` can
// refuse a transcription.
//
// The command's own messages are written for the caller of an API —
// accurate, terse, and phrased as a statement of fact ("Prescriber is
// inactive and cannot write new prescriptions."). A technician holding
// a paper script needs the next move instead: which field is wrong,
// what to put there, and — where a federal rule is the reason — that
// the rule exists, so the console reads as a system with a spine
// rather than an arbitrary one.
//
// The citations are the operator's mental model, not legal advice.
// They are named only where 21 CFR part 1306 is the actual reason the
// command refused; inventing one elsewhere would teach the wrong
// model.
//
// Deliberately dependency-free: the codes are mirrored as string
// literals rather than imported from `@pharmax/orders`, the same way
// `ui/workflow.ts` mirrors the order-status vocabulary, so this module
// stays safe to import from a Client Component. `rx-transcription-
// errors.test.ts` pins the mirror against the command's exported
// constants, so a rename there fails the suite here.

/**
 * The codes a transcription can come back with. `RX_BI_REQUIRED_NULL`
 * is deliberately absent: it is a crypto-misconfiguration fault with
 * no operator remedy, and the generic fallback ("report this") is the
 * honest thing to say about it.
 */
export const CREATE_PRESCRIPTION_ERROR_CODES = [
  "RX_CLINIC_NOT_FOUND",
  "RX_PATIENT_NOT_FOUND",
  "RX_PATIENT_CLINIC_MISMATCH",
  "RX_PATIENT_NOT_ACTIVE",
  "RX_PROVIDER_NOT_FOUND",
  "RX_PROVIDER_INACTIVE",
  "RX_PROVIDER_DEA_REQUIRED",
  "RX_NDC_INVALID",
  "RX_SCHEDULE_REQUIRED_FOR_UNKNOWN_NDC",
  "RX_SCHEDULE_CATALOG_MISMATCH",
  "RX_CONTROLLED_AUTHORIZATION_INVALID",
  "RX_DATE_WRITTEN_IN_FUTURE",
  "RX_EXPIRES_NOT_AFTER_WRITTEN",
  "RX_EXPIRY_EXCEEDS_FEDERAL_HORIZON",
  "RX_EARLIEST_FILL_BEFORE_WRITTEN",
  "RX_NUMBER_COLLISION",
] as const;

export type CreatePrescriptionErrorCode = (typeof CREATE_PRESCRIPTION_ERROR_CODES)[number];

export interface OperatorErrorMessage {
  /** Banner heading — what is wrong, in the operator's vocabulary. */
  readonly title: string;
  /** What to do about it. */
  readonly guidance: string;
  /** Named only where a federal rule is the reason for the refusal. */
  readonly citation?: string;
}

const MESSAGES: Readonly<Record<CreatePrescriptionErrorCode, OperatorErrorMessage>> = Object.freeze(
  {
    RX_CLINIC_NOT_FOUND: {
      title: "That practice isn't in your organization",
      guidance:
        "The practice on this prescription no longer resolves. Pick the patient again from search — the practice is taken from the patient's own record, so re-selecting them repairs it.",
    },
    RX_PATIENT_NOT_FOUND: {
      title: "That patient no longer exists",
      guidance:
        "The patient was removed or merged while this form was open. Search for them again and transcribe against the record that comes back.",
    },
    RX_PATIENT_CLINIC_MISMATCH: {
      title: "The patient belongs to a different practice",
      guidance:
        "Filed this way the prescription would be invisible to the practice that owns the patient, and visible to one that shouldn't see them. Re-open the patient from search so the practice comes from their record.",
    },
    RX_PATIENT_NOT_ACTIVE: {
      title: "The patient's record isn't active",
      guidance:
        "An inactive, deceased, or merged patient can't receive a new prescription. If they were merged, transcribe against the surviving record; otherwise have the roster corrected before continuing.",
    },
    RX_PROVIDER_NOT_FOUND: {
      title: "That prescriber isn't in the directory",
      guidance:
        "Choose a prescriber from the list. If the one who signed the script isn't there, they need registering in Providers before their prescriptions can be transcribed.",
    },
    RX_PROVIDER_INACTIVE: {
      title: "That prescriber is deactivated",
      guidance:
        "A deactivated prescriber can't write new prescriptions. Confirm who actually signed the script — if it really is them, an admin has to reactivate them first.",
    },
    RX_PROVIDER_DEA_REQUIRED: {
      title: "The prescriber has no DEA registration on file",
      guidance:
        "A controlled substance may only be prescribed by a practitioner registered with the DEA, and this prescriber's registration number is missing from the directory. Read the DEA number off the script and have it added in Providers before transcribing.",
      citation: "21 CFR 1306.03",
    },
    RX_NDC_INVALID: {
      title: "That NDC isn't a valid National Drug Code",
      guidance:
        "Re-read the code from the manufacturer's package: an NDC is 10 or 11 digits. Hyphens are fine — anything shorter, longer, or non-numeric is not.",
    },
    RX_SCHEDULE_REQUIRED_FOR_UNKNOWN_NDC: {
      title: "This NDC isn't in the catalog — state its DEA schedule",
      guidance:
        "Pharmax will not assume an uncatalogued drug is non-controlled, because that assumption would switch off every controlled-substance check for the life of the prescription. Select the schedule printed on the manufacturer's labeling, or have the product added to the catalog first.",
    },
    RX_SCHEDULE_CATALOG_MISMATCH: {
      title: "The schedule disagrees with the product catalog",
      guidance:
        "The catalog already records a DEA schedule for this NDC and it isn't the one selected. Pick the drug from the catalog list to take its schedule. If you believe the catalog is wrong, get the product corrected — a prescription is not the place to override it.",
    },
    RX_CONTROLLED_AUTHORIZATION_INVALID: {
      title: "Those refills aren't lawful for this schedule",
      guidance:
        "A Schedule II prescription may authorize no refills at all; Schedule III and IV may authorize at most five. Reduce the refill count to what the schedule allows — anything beyond it needs a new prescription from the prescriber, not a bigger number here.",
      citation: "21 CFR 1306.12(a), 1306.22(a)",
    },
    RX_DATE_WRITTEN_IN_FUTURE: {
      title: "The date written is in the future",
      guidance:
        "Check the date the prescriber signed the script. A future date is either a transcription slip or an attempt to stretch the fillable window, and neither should reach a pharmacist.",
    },
    RX_EXPIRES_NOT_AFTER_WRITTEN: {
      title: "The expiry isn't after the date written",
      guidance:
        "An expiry on or before the date written leaves nothing fillable. Correct it, or clear the field to take the default — six months for a controlled substance, one year otherwise.",
    },
    RX_EXPIRY_EXCEEDS_FEDERAL_HORIZON: {
      title: "That expiry is past the six-month federal horizon",
      guidance:
        "A Schedule III or IV prescription may not be filled or refilled more than six months after it was written, so an expiry beyond that would present it as fillable when it is not. Shorten the date, or clear the field to take the six-month default.",
      citation: "21 CFR 1306.22(a)",
    },
    RX_EARLIEST_FILL_BEFORE_WRITTEN: {
      title: "The do-not-fill-before date precedes the date written",
      guidance:
        "A prescriber can stage a fill for later, never for earlier. Correct the date, or clear the field if the script doesn't stage the fill at all.",
    },
    RX_NUMBER_COLLISION: {
      title: "The allocated Rx number was already taken",
      guidance:
        "Nothing was saved. Submit again — the next attempt allocates a fresh number. If it happens twice, the practice's Rx counter has drifted behind its series and an admin needs to look at it.",
    },
  }
);

const COMMAND_INPUT_INVALID: OperatorErrorMessage = Object.freeze({
  title: "Some entries didn't pass validation",
  guidance:
    "A field is missing or in the wrong shape — most often a quantity, a day count, or a date that isn't YYYY-MM-DD. Re-check the highlighted sections and submit again.",
});

const UNKNOWN: OperatorErrorMessage = Object.freeze({
  title: "The prescription wasn't saved",
  guidance:
    "Nothing was written, so it is safe to try again. If it fails a second time, report the code below to your administrator rather than re-typing it.",
});

export interface DescribedTranscriptionError extends OperatorErrorMessage {
  /** The typed code, kept visible so an escalation can name it. */
  readonly code: string;
}

/**
 * Turn the `?error=` payload an ops dispatch redirect carries — the
 * `"<CODE>: <message>"` shape `dispatchOpsCommand` builds — into
 * something an operator can act on.
 *
 * Unrecognized codes keep the generic wording; the code itself is
 * returned so the banner can still show what to escalate. The
 * command's own message is intentionally NOT appended: it is written
 * for an API caller, and two overlapping explanations read worse than
 * one good one.
 */
export function describeCreatePrescriptionError(raw: string): DescribedTranscriptionError {
  const separator = raw.indexOf(":");
  const code = (separator === -1 ? raw : raw.slice(0, separator)).trim();

  if ((CREATE_PRESCRIPTION_ERROR_CODES as ReadonlyArray<string>).includes(code)) {
    return { code, ...MESSAGES[code as CreatePrescriptionErrorCode] };
  }
  if (code === "COMMAND_INPUT_INVALID") {
    return { code, ...COMMAND_INPUT_INVALID };
  }
  return { code: code.length === 0 ? "UNKNOWN" : code, ...UNKNOWN };
}
