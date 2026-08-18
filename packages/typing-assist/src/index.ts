// @pharmax/typing-assist — deterministic typing validation (phase 1)
// plus the suggestion engine (phase 2).
//
// The invariant the whole plan hangs on — "a model may propose; only
// a human may accept" — is structural here: the deterministic
// validators and prompt builders are pure functions; the model stage
// runs in the worker behind a port and can only INSERT proposal rows;
// the single write path from a proposal to a prescription is
// AcceptTypingSuggestion, a human-dispatched, order-locked, audited
// command that re-verifies every safety property against live rows.

export {
  evaluateTypingDraft,
  TYPING_FINDING_CODES,
  type ControlledSchedule,
  type EvaluateTypingDraftInput,
  type GuardrailFacts,
  type PolicyFacts,
  type ProductFacts,
  type TypingDraft,
  type TypingDraftEvaluation,
  type TypingFinding,
  type TypingFindingCode,
  type TypingFindingSeverity,
} from "./evaluate-typing-draft.js";

export {
  AI_ASSIST_POLICY_CONFLICT,
  SetAiAssistPolicy,
  type SetAiAssistPolicyInput,
  type SetAiAssistPolicyOutput,
} from "./commands/set-ai-assist-policy.js";

// --- Phase 2: suggestion engine ---

export {
  TYPING_SUGGESTION_FIELDS,
  TYPING_SUGGESTION_FIELD_SPECS,
  isTypingSuggestionField,
  parseSuggestionValue,
  type TypingSuggestionField,
} from "./suggestions/fields.js";

export {
  deterministicFixesForFindings,
  type DeterministicFixProposal,
  type DeterministicFixesInput,
} from "./suggestions/deterministic-fixes.js";

export {
  type TypingModelPort,
  type TypingModelRequest,
  type TypingModelResponse,
} from "./model/port.js";

export {
  TYPING_SUGGESTION_MAX_OUTPUT_TOKENS,
  TYPING_SUGGESTION_PROMPT_VERSION,
  buildTypingSuggestionPrompt,
  type BuiltTypingPrompt,
  type TypingSuggestionPromptInput,
} from "./model/prompt.js";

export {
  extractJsonObject,
  filterModelSuggestions,
  parseModelSuggestions,
  type AcceptedModelSuggestion,
  type DroppedModelSuggestion,
  type FilterModelSuggestionsInput,
  type FilterModelSuggestionsResult,
  type RawModelSuggestion,
} from "./model/output.js";

export {
  MODEL_FAILURE_CODES,
  runTypingSuggestionModelStage,
  type ModelFailureCode,
  type RunModelStageInput,
  type RunModelStageResult,
} from "./model/run-model-stage.js";

export {
  MODEL_SKIP_REASONS,
  RequestTypingSuggestions,
  TYPING_SUGGESTIONS_ORDER_NOT_IN_TYPING,
  TYPING_SUGGESTIONS_PRESCRIPTION_NOT_ON_ORDER,
  type ModelSkipReason,
  type RequestTypingSuggestionsInput,
  type RequestTypingSuggestionsOutput,
} from "./commands/request-typing-suggestions.js";

export {
  AcceptTypingSuggestion,
  TYPING_SUGGESTION_GUARDRAIL_BREACH,
  TYPING_SUGGESTION_NOT_FOUND,
  TYPING_SUGGESTION_NOT_PROPOSED,
  TYPING_SUGGESTION_ORDER_NOT_IN_TYPING,
  TYPING_SUGGESTION_STALE,
  TYPING_SUGGESTION_VALUE_INVALID,
  type AcceptTypingSuggestionInput,
  type AcceptTypingSuggestionOutput,
} from "./commands/accept-typing-suggestion.js";

export {
  DismissTypingSuggestion,
  TYPING_SUGGESTION_DISMISS_REASONS,
  type DismissTypingSuggestionInput,
  type DismissTypingSuggestionOutput,
  type TypingSuggestionDismissReason,
} from "./commands/dismiss-typing-suggestion.js";
