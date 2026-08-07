// CRITERION_MAPPING — propose additional control ⇄ criterion links.
//
// The question this answers is the one that is genuinely hard to
// answer by hand: our controls are filed under the SOC 2 criterion
// each was written for, but most of them also satisfy HIPAA Security
// Rule requirements, and nobody has walked all 69 against 45 CFR
// 164.308-312. A model is good at that pattern-match and bad at being
// trusted with it, which is precisely the shape that a
// propose-then-accept workflow fits.
//
// Two guards specific to this kind:
//
//   The model may only choose from a supplied list of criterion codes.
//   Left open, it invents plausible-looking citations —
//   "164.308(a)(9)(ii)" — that do not exist. A citation to a
//   non-existent regulation in an audit file is worse than no citation.
//
//   Every proposal must carry a rationale naming what about the
//   control satisfies the criterion. Reviewing 40 bare code pairs is a
//   rubber-stamp exercise; reviewing 40 one-sentence arguments is
//   actual review.

import { z } from "zod";

import type { BuiltPrompt, DraftKindDefinition } from "../types.js";
import { canonicalizeInputs, finalizePrompt, SYSTEM_PREAMBLE } from "./shared.js";

export const CRITERION_MAPPING_PROMPT_VERSION = 1;

export interface CriterionMappingInput {
  readonly controlCode: string;
  readonly title: string;
  readonly description: string;
  readonly implementationRefs: readonly string[];
  /** Codes already linked; the model is told not to repeat them. */
  readonly existingCriterionCodes: readonly string[];
  /** The ONLY codes the model may propose. */
  readonly candidateCriteria: readonly {
    readonly code: string;
    readonly framework: string;
    readonly title: string;
  }[];
}

export const criterionMappingOutputSchema = z.object({
  proposals: z
    .array(
      z.object({
        criterionCode: z.string().min(1).max(64),
        /** Forces an argument, not just an assertion. */
        rationale: z.string().min(40).max(500),
        confidence: z.enum(["high", "medium", "low"]),
      })
    )
    // Capped: an unbounded list encourages the model to map a control
    // to every criterion it can rationalize, which buries the two or
    // three real matches in noise a reviewer then has to sort.
    .max(12),
  informationGaps: z.array(z.string().max(300)).max(6),
});

export type CriterionMappingOutput = z.infer<typeof criterionMappingOutputSchema>;

function build(input: CriterionMappingInput): BuiltPrompt {
  const { canonical } = canonicalizeInputs(input);

  const candidates = input.candidateCriteria
    .map((c) => `  ${c.code} (${c.framework}) — ${c.title}`)
    .join("\n");

  const user = [
    "Propose which additional framework criteria this control helps satisfy.",
    "",
    `Control code: ${input.controlCode}`,
    `Title: ${input.title}`,
    `Description: ${input.description}`,
    `Implementation references: ${
      input.implementationRefs.length > 0 ? input.implementationRefs.join(", ") : "(none recorded)"
    }`,
    "",
    `Already mapped (do NOT repeat these): ${
      input.existingCriterionCodes.length > 0 ? input.existingCriterionCodes.join(", ") : "(none)"
    }`,
    "",
    "Choose ONLY from this list of criterion codes. Do not cite any code that does",
    "not appear here, even if you believe it exists:",
    candidates,
    "",
    "For each proposal give a one-sentence rationale naming the specific thing",
    "about this control that satisfies that criterion. Propose nothing if none",
    "genuinely apply — an empty list is a valid and useful answer.",
    "",
    'Respond as JSON: {"proposals": [{"criterionCode": string, "rationale": string,',
    '"confidence": "high" | "medium" | "low"}], "informationGaps": string[]}',
  ].join("\n");

  return finalizePrompt({
    request: {
      system: SYSTEM_PREAMBLE,
      user,
      maxOutputTokens: 2000,
      temperature: 0,
    },
    promptVersion: CRITERION_MAPPING_PROMPT_VERSION,
    inputSummary:
      `control ${input.controlCode} against ${input.candidateCriteria.length} candidate ` +
      `criteria (${input.existingCriterionCodes.length} already mapped)`,
    inputCanonical: canonical,
    context: "CRITERION_MAPPING",
  });
}

export const criterionMappingKind: DraftKindDefinition<
  CriterionMappingInput,
  CriterionMappingOutput
> = {
  kind: "CRITERION_MAPPING",
  promptVersion: CRITERION_MAPPING_PROMPT_VERSION,
  maxOutputTokens: 2000,
  build,
  outputSchema: criterionMappingOutputSchema,
};
