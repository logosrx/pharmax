// Deterministic finding → concrete fix proposals.
//
// A finding says "this is wrong"; a fix proposal says "and here is the
// value that makes it right". Only findings with exactly ONE correct
// answer produce a proposal — a transposed date has many plausible
// corrections and gets none (the finding still surfaces; the human
// investigates). This asymmetry is the point: the deterministic layer
// never guesses, so a technician can treat its proposals as
// arithmetic, not advice.
//
// Pure function; PHI-free by construction (fields, numbers, coded
// values, and regulation citations only).

import type {
  GuardrailFacts,
  ProductFacts,
  TypingDraft,
  TypingFinding,
} from "../evaluate-typing-draft.js";
import type { TypingSuggestionField } from "./fields.js";

export interface DeterministicFixProposal {
  readonly findingCode: TypingFinding["code"];
  readonly field: TypingSuggestionField;
  /** Draft value being replaced (null = field currently empty). */
  readonly currentValue: unknown;
  /** null = clear the field. */
  readonly suggestedValue: unknown;
  /** PHI-free explanation shown to the technician. */
  readonly rationale: string;
}

export interface DeterministicFixesInput {
  readonly draft: TypingDraft;
  readonly product: ProductFacts;
  readonly guardrail: GuardrailFacts | null;
  readonly findings: ReadonlyArray<TypingFinding>;
}

export function deterministicFixesForFindings(
  input: DeterministicFixesInput
): ReadonlyArray<DeterministicFixProposal> {
  const { draft, product, guardrail, findings } = input;
  const proposals: DeterministicFixProposal[] = [];

  for (const finding of findings) {
    switch (finding.code) {
      case "TA_REFILLS_REMAINING_EXCEEDS_AUTHORIZED":
        proposals.push({
          findingCode: finding.code,
          field: "refillsRemaining",
          currentValue: draft.refillsRemaining,
          suggestedValue: draft.refillsAuthorized,
          rationale:
            "Refills remaining cannot exceed refills authorized; align it to the authorized count.",
        });
        break;

      case "TA_CII_WITH_REFILLS":
        proposals.push({
          findingCode: finding.code,
          field: "refillsAuthorized",
          currentValue: draft.refillsAuthorized,
          suggestedValue: 0,
          rationale: "Schedule II prescriptions cannot authorize refills (21 CFR 1306.12).",
        });
        if (draft.refillsRemaining > 0) {
          proposals.push({
            findingCode: finding.code,
            field: "refillsRemaining",
            currentValue: draft.refillsRemaining,
            suggestedValue: 0,
            rationale: "Schedule II prescriptions cannot carry refills (21 CFR 1306.12).",
          });
        }
        break;

      case "TA_CIII_TO_CV_REFILLS_OVER_FIVE":
        proposals.push({
          findingCode: finding.code,
          field: "refillsAuthorized",
          currentValue: draft.refillsAuthorized,
          suggestedValue: 5,
          rationale:
            "Schedule III–V prescriptions may be refilled at most 5 times (21 CFR 1306.22).",
        });
        break;

      case "TA_SCHEDULE_MISMATCH_WITH_CATALOG":
        proposals.push({
          findingCode: finding.code,
          field: "controlledSubstanceSchedule",
          currentValue: draft.controlledSubstanceSchedule,
          suggestedValue: product.controlledSubstanceSchedule,
          rationale:
            "The typed schedule does not match the catalog product's DEA schedule; the catalog is the source of truth.",
        });
        break;

      case "TA_EARLIEST_FILL_ON_NON_CII":
        proposals.push({
          findingCode: finding.code,
          field: "earliestFillDate",
          currentValue: draft.earliestFillDate,
          suggestedValue: null,
          rationale:
            "An earliest-fill date is a Schedule II multiple-prescription instruction (21 CFR 1306.12); clear it on this schedule unless the prescriber wrote it explicitly.",
        });
        break;

      case "TA_QUANTITY_EXCEEDS_GUARDRAIL":
        if (guardrail?.maxQuantityPerFill != null) {
          proposals.push({
            findingCode: finding.code,
            field: "quantityAuthorized",
            currentValue: draft.quantityAuthorized,
            suggestedValue: guardrail.maxQuantityPerFill,
            rationale:
              "Quantity exceeds this pharmacy's per-fill ceiling for the product; cap it at the ceiling or verify the source document.",
          });
        }
        break;

      case "TA_DAYS_SUPPLY_EXCEEDS_GUARDRAIL":
        if (guardrail?.maxDaysSupplyPerFill != null) {
          proposals.push({
            findingCode: finding.code,
            field: "daysSupply",
            currentValue: draft.daysSupply,
            suggestedValue: guardrail.maxDaysSupplyPerFill,
            rationale:
              "Days supply exceeds this pharmacy's ceiling for the product; cap it at the ceiling or verify the source document.",
          });
        }
        break;

      case "TA_REFILLS_EXCEED_GUARDRAIL":
        if (guardrail?.maxRefillsAuthorized != null) {
          proposals.push({
            findingCode: finding.code,
            field: "refillsAuthorized",
            currentValue: draft.refillsAuthorized,
            suggestedValue: guardrail.maxRefillsAuthorized,
            rationale:
              "Refills authorized exceeds this pharmacy's ceiling for the product; cap it at the ceiling or verify the source document.",
          });
        }
        break;

      // Findings with no single correct answer: surface, don't guess.
      case "TA_EXPIRES_BEFORE_WRITTEN":
      case "TA_EXPIRED_AT_TYPING":
      case "TA_WRITTEN_IN_FUTURE":
      case "TA_DAW_OUT_OF_RANGE":
      case "TA_EARLIEST_FILL_BEFORE_WRITTEN":
        break;

      default: {
        // Exhaustiveness: a new finding code must be classified here
        // (fixable or explicitly not) before it compiles.
        const _exhaustive: never = finding.code;
        void _exhaustive;
      }
    }
  }

  // One proposal per field: if two findings both want to move the same
  // field (e.g. CII-with-refills AND a refill guardrail breach), keep
  // the FIRST — finding order already runs strictest-first, and two
  // competing proposals for one field would force the technician to
  // adjudicate between two "certain" answers, which contradicts what
  // deterministic proposals claim to be.
  const seen = new Set<TypingSuggestionField>();
  return proposals.filter((p) => {
    if (seen.has(p.field)) return false;
    seen.add(p.field);
    return true;
  });
}
