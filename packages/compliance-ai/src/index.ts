// @pharmax/compliance-ai — advisory drafting for the compliance
// control plane.
//
// A model may propose; only a human may accept. Nothing exported here
// can write to the database: the provider boundary
// (`ComplianceModelPort`) returns text, and turning text into a record
// requires a human-dispatched command.
//
// Deliberately NOT exported: nothing. Every module here is pure —
// prompt builders, output schemas, and the PHI tripwire — which is why
// this package has no runtime configuration and no side effects on
// import.

export type {
  BuiltPrompt,
  ComplianceAiDraftKind,
  ComplianceAiDraftStatus,
  ComplianceModelPort,
  DraftKindDefinition,
  ModelRequest,
  ModelResponse,
} from "./types.js";

export {
  assertNoPhi,
  COMPLIANCE_AI_PHI_TRIPWIRE,
  scanForPhi,
  type TripwireHit,
} from "./guards/phi-tripwire.js";

export {
  canonicalizeInputs,
  extractJsonObject,
  finalizePrompt,
  SYSTEM_PREAMBLE,
} from "./prompts/shared.js";

export {
  CONTROL_DESCRIPTION_PROMPT_VERSION,
  controlDescriptionKind,
  controlDescriptionOutputSchema,
  type ControlDescriptionInput,
  type ControlDescriptionOutput,
} from "./prompts/control-description.js";

export {
  CRITERION_MAPPING_PROMPT_VERSION,
  criterionMappingKind,
  criterionMappingOutputSchema,
  type CriterionMappingInput,
  type CriterionMappingOutput,
} from "./prompts/criterion-mapping.js";
