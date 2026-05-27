export {
  type ReportDefinition,
  type ReportResult,
  type ReportRunContext,
  type DateRangeParams,
} from "./types.js";

export { toCsv } from "./csv.js";

export {
  orderVolumeByStageReport,
  type OrderVolumeByStageParams,
  type OrderVolumeByStageRow,
} from "./reports/order-volume-by-stage.js";

export {
  slaBreachReport,
  type SlaBreachReportParams,
  type SlaBreachRow,
  DEFAULT_STAGE_SLA_THRESHOLDS_MS,
} from "./reports/sla-breach-report.js";

/**
 * Convenience registry mapping `ReportDefinition.id` → definition.
 * Callers (future scheduled-run worker, admin UI listing) can
 * iterate this to discover available reports.
 */
import { orderVolumeByStageReport } from "./reports/order-volume-by-stage.js";
import { slaBreachReport } from "./reports/sla-breach-report.js";

export const REPORT_REGISTRY = Object.freeze({
  [orderVolumeByStageReport.id]: orderVolumeByStageReport,
  [slaBreachReport.id]: slaBreachReport,
});
