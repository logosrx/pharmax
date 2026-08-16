// @pharmax/typing-assist — deterministic typing validation + the
// org-level AI-assist policy (typing-assist phase 1).
//
// This package is the safety substrate the (later-phase) model
// pipeline will be bounded by. Nothing here calls a model: the
// validators are pure functions over injected facts, and the one
// command writes tenant configuration. The invariant the whole plan
// hangs on — "a model may propose; only a human may accept" — starts
// here by making the deterministic layer independent of any model at
// all.

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
