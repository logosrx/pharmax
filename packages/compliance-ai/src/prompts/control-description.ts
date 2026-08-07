// CONTROL_DESCRIPTION — propose fuller prose for a control whose
// description is currently just its one-line title.
//
// This is the lowest-risk kind and the reason the layer earns its
// keep: the seeder imports 69 controls whose `description` equals
// their `title`, because docs/soc2/controls-inventory.md has one
// prose column. Writing 69 paragraphs by hand is the kind of task
// that stays undone for a year. Drafting them and having the control
// owner accept or edit each one is exactly the division of labour
// this layer is for.
//
// Note what is NOT sent: the control's status. A model told a control
// is "Implemented" will write prose asserting it operates, which is
// the confabulation risk restated. The reviewer knows the status; the
// drafter describes what the control IS, not whether it is working.

import { z } from "zod";

import type { BuiltPrompt, DraftKindDefinition } from "../types.js";
import { canonicalizeInputs, finalizePrompt, SYSTEM_PREAMBLE } from "./shared.js";

export const CONTROL_DESCRIPTION_PROMPT_VERSION = 1;

export interface ControlDescriptionInput {
  readonly controlCode: string;
  readonly title: string;
  readonly ownerRole: string;
  readonly criterionCodes: readonly string[];
  readonly implementationRefs: readonly string[];
  readonly notes: string | null;
}

export const controlDescriptionOutputSchema = z.object({
  /**
   * Bounded on both ends. The floor rejects a one-line restatement of
   * the title, which is what the field already contains; the ceiling
   * keeps a control description from becoming an essay nobody reads
   * during the review it exists to support.
   */
  description: z.string().min(120).max(1200),
  /**
   * What the model would have needed to do better. The field exists
   * so "the inputs were thin" is recorded rather than papered over
   * with confident prose — it is the honest-uncertainty escape hatch
   * the system preamble promises.
   */
  informationGaps: z.array(z.string().max(300)).max(6),
  confidence: z.enum(["high", "medium", "low"]),
});

export type ControlDescriptionOutput = z.infer<typeof controlDescriptionOutputSchema>;

function build(input: ControlDescriptionInput): BuiltPrompt {
  const { canonical } = canonicalizeInputs(input);

  const user = [
    "Draft a fuller description for one compliance control.",
    "",
    `Control code: ${input.controlCode}`,
    `Title: ${input.title}`,
    `Accountable role: ${input.ownerRole}`,
    `Framework criteria it is filed under: ${
      input.criterionCodes.length > 0 ? input.criterionCodes.join(", ") : "(none recorded)"
    }`,
    `Implementation references: ${
      input.implementationRefs.length > 0 ? input.implementationRefs.join(", ") : "(none recorded)"
    }`,
    `Notes from the control inventory: ${input.notes ?? "(none)"}`,
    "",
    "Write 2-4 sentences describing what this control IS and how it operates,",
    "based strictly on the above. Do not state whether it is currently working,",
    "whether it is tested, or what evidence exists, unless the inputs say so.",
    "",
    'Respond as JSON: {"description": string, "informationGaps": string[], ',
    '"confidence": "high" | "medium" | "low"}',
  ].join("\n");

  return finalizePrompt({
    request: {
      system: SYSTEM_PREAMBLE,
      user,
      maxOutputTokens: 900,
      temperature: 0,
    },
    promptVersion: CONTROL_DESCRIPTION_PROMPT_VERSION,
    inputSummary:
      `control ${input.controlCode}: title, owner role, ` +
      `${input.criterionCodes.length} criterion code(s), ` +
      `${input.implementationRefs.length} implementation ref(s), inventory notes`,
    inputCanonical: canonical,
    context: "CONTROL_DESCRIPTION",
  });
}

export const controlDescriptionKind: DraftKindDefinition<
  ControlDescriptionInput,
  ControlDescriptionOutput
> = {
  kind: "CONTROL_DESCRIPTION",
  promptVersion: CONTROL_DESCRIPTION_PROMPT_VERSION,
  maxOutputTokens: 900,
  build,
  outputSchema: controlDescriptionOutputSchema,
};
