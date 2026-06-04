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

export {
  shipmentExceptionBreakdownReport,
  type ShipmentExceptionBreakdownParams,
  type ShipmentExceptionBreakdownRow,
} from "./reports/shipment-exception-breakdown.js";

export {
  lotExpiryWarningsReport,
  type LotExpiryWarningsParams,
  type LotExpiryWarningRow,
} from "./reports/lot-expiry-warnings.js";

export {
  billingSummaryByClinicReport,
  type BillingSummaryByClinicParams,
  type BillingSummaryByClinicRow,
} from "./reports/billing-summary-by-clinic.js";

export {
  userProductivityByStageReport,
  type UserProductivityByStageParams,
  type UserProductivityByStageRow,
} from "./reports/user-productivity-by-stage.js";

export {
  verificationRejectionRateReport,
  type VerificationRejectionRateParams,
  type VerificationRejectionRateRow,
} from "./reports/verification-rejection-rate.js";

export { REPORT_REGISTRY, type ReportDefinitionAny } from "./report-registry.js";

export {
  RunReport,
  REPORT_NOT_FOUND,
  REPORT_PARAMETERS_INVALID,
  type RunReportInput,
  type RunReportOutput,
} from "./commands/run-report.js";

export {
  CreateReportSchedule,
  CRON_EXPRESSION_INVALID,
  SCHEDULE_TEMPLATE_INVALID,
  SCHEDULE_NAME_TAKEN,
  type CreateReportScheduleInput,
  type CreateReportScheduleOutput,
} from "./commands/create-report-schedule.js";

export {
  UpdateReportSchedule,
  REPORT_SCHEDULE_NOT_FOUND,
  type UpdateReportScheduleInput,
  type UpdateReportScheduleOutput,
} from "./commands/update-report-schedule.js";

export {
  DisableReportSchedule,
  type DisableReportScheduleInput,
  type DisableReportScheduleOutput,
} from "./commands/disable-report-schedule.js";

export {
  RELATIVE_DATE_PLACEHOLDERS,
  RELATIVE_DATE_PLACEHOLDER_SET,
  isRelativeDatePlaceholder,
  resolveRelativeDate,
  resolveTemplate,
  type RelativeDatePlaceholder,
} from "./schedule/resolve-template.js";

export {
  validateCron,
  computeNextRun,
  type CronValidationResult,
  type CronValidationOk,
  type CronValidationFail,
} from "./schedule/cron.js";

export {
  dateRangeFields,
  resolveDateFieldDefault,
  type ReportParameterField,
  type ReportDateField,
  type ReportEnumField,
  type ReportEnumOption,
  type ReportMultiEnumField,
  type ReportTextField,
  type ReportNumberField,
  type ReportDateFieldDefault,
} from "./parameter-fields.js";

export {
  parseReportParameters,
  paramSourceFromFormData,
  paramSourceFromRecord,
  type ParamSource,
  type ParseReportParametersResult,
} from "./parse-report-parameters.js";

export {
  REPORT_RUN_ARCHIVE_NOT_FOUND,
  REPORT_RUN_ARCHIVE_INTEGRITY_VIOLATION,
  REPORT_RUN_ARCHIVE_TRANSPORT_ERROR,
  REPORT_RUN_ARCHIVE_ORG_MISMATCH,
  type ReportRunArchivePort,
  type ReportRunArchivePutInput,
  type ReportRunArchivePutResult,
  type ReportRunArchiveGetInput,
  type ReportRunArchiveGetResult,
} from "./archive/report-run-archive.js";

export {
  InMemoryReportRunArchive,
  type InMemoryReportRunArchiveOptions,
} from "./archive/in-memory-report-run-archive.js";

export {
  configureReportRunArchive,
  getReportRunArchive,
  resetReportRunArchiveConfigurationForTests,
  REPORTING_ARCHIVE_ALREADY_CONFIGURED,
  type ReportRunArchiveConfiguration,
} from "./archive/configure.js";

export {
  configureReportReadScope,
  getReportReadScope,
  resetReportReadScopeConfigurationForTests,
  REPORTING_READ_SCOPE_ALREADY_CONFIGURED,
  type ReportReadScope,
} from "./replica/configure.js";

export {
  S3ReportRunArchive,
  type S3ReportRunArchiveSurface,
  type S3ReportRunArchiveOptions,
} from "./archive/s3-report-run-archive.js";
