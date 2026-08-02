// @pharmax/controlled-substances — DEA schedule semantics and the
// 21 CFR part 1306 dispensing rules (ADR-0037 commitment 1).
//
// Pure and dependency-light by design: no clock, no I/O, no database
// access. Consumers pass facts in and get a total evaluation back.
//
// NOTE: this package is deliberately NOT the EPCS module. It carries
// no signing, no identity proofing, and no logical access control, and
// therefore sits OUTSIDE the third-party-audited boundary that
// § 1311.300 imposes on `@pharmax/epcs`. Keep it that way — folding CS
// dispensing rules and EPCS signing into one package would drag this
// code into the re-audit cycle on every change.

export {
  CONTROLLED_SCHEDULES,
  federalRefillCap,
  hasScheduleThreeToFivePartialFillRegime,
  hasSixMonthRefillHorizon,
  isControlled,
  requiresPrescriberDeaRegistration,
} from "./schedule.js";

export {
  addUtcCalendarMonths,
  addUtcDays,
  DISPENSING_VIOLATION_CODES,
  evaluateDispensing,
  PARTIAL_FILL_BASES,
  startOfUtcDay,
  validateControlledPrescriptionAuthorization,
} from "./dispensing-rules.js";

export type {
  AuthorizationInput,
  ControlledPrescriptionSnapshot,
  DispensingEvaluation,
  DispensingRequest,
  DispensingViolation,
  DispensingViolationCode,
  PartialFillBasis,
} from "./dispensing-rules.js";
