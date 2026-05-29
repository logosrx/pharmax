// Per-domain barrel for reporting.* event definitions.
//
// Reporting events anchor the operator-driven (and, soon, scheduled)
// report-runner pipeline owned by `@pharmax/reporting`. Every entry
// here MUST be `phiSafe: true` — today's report aggregates are scalar
// counters (status counts, SLA breach counts). If a future report
// surfaces a PHI-bearing aggregate, that's a per-event review +
// schema redesign moment, not a flag flip.

export { ReportingRunCompletedV1 } from "./run-completed-v1.js";
export { ReportScheduleCreatedV1 } from "./schedule-created-v1.js";
export { ReportScheduleDisabledV1 } from "./schedule-disabled-v1.js";
export { ReportScheduleUpdatedV1 } from "./schedule-updated-v1.js";
