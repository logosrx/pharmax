// Public surface of @pharmax/sla.
//
// The SLA domain has two halves:
//   1. The stage-interval recorder — opens/closes
//      `OrderStageInterval` rows as the workflow advances (the
//      raw timing ledger every SLA metric is derived from).
//   2. The deadline + breach-status layer — computes the
//      order-level `slaDeadlineAt` at intake and classifies an
//      order ON_TRACK / WARNING / BREACHED. Pure + dependency-
//      light; shared by the order command layer, the worker
//      breach-evaluator tick, the reporting breach report, and
//      the operator queue-badge UI.

export {
  applyCommandStageIntervalTransition,
  closeOpenStageInterval,
  COMMAND_STAGE_INTERVAL_CLOSE_ONLY,
  COMMAND_STAGE_INTERVAL_TRANSITION,
  isActiveIntervalKind,
  KNOWN_NON_SLA_COMMANDS,
  openInitialWaitBeforeTyping,
  openStageInterval,
  OrderStageIntervalKind,
  SLA_INTERVAL_ALREADY_OPEN,
  SLA_INTERVAL_COMMAND_UNMAPPED,
  SLA_INTERVAL_KIND_MISMATCH,
  SLA_INTERVAL_NEGATIVE_DURATION,
  SLA_INTERVAL_NONE_OPEN,
  SLA_INTERVAL_RACE_LOST,
  transitionStageIntervals,
  type CloseOpenStageIntervalInput,
  type OpenStageIntervalInput,
  type TransitionStageIntervalsInput,
} from "./interval-recorder.js";

export {
  intervalKindForOrderState,
  STAGE_INTERVAL_KIND_FOR_EXCEPTION_STATE,
  STAGE_INTERVAL_KIND_FOR_PRIMARY_STATE,
} from "./stage-interval-state-map.js";

export {
  DEFAULT_STAGE_SLA_THRESHOLDS_MS,
  DEFAULT_END_TO_END_SLA_BUDGET_MS,
  PRIORITY_SLA_MULTIPLIER,
  DEFAULT_SLA_WARNING_WINDOW_MS,
} from "./thresholds.js";

export { computeOrderSlaDeadline, type ComputeOrderSlaDeadlineInput } from "./deadline.js";

export {
  classifySlaStatus,
  msUntilSlaDeadline,
  type SlaStatus,
  type ClassifySlaStatusInput,
} from "./status.js";
