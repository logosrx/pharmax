// Report registry helper.
//
// Extracted from `index.ts` so command handlers can import the
// registry + the generic `ReportDefinitionAny` shape without
// pulling in the full barrel (which would create a circular
// import: `index.ts` re-exports `RunReport`, and `RunReport`
// would need `REPORT_REGISTRY`).
//
// Pattern: each report module exports a typed `ReportDefinition<TSchema, TRow>`;
// the registry erases the generic TRow to a non-PHI baseline
// (`Record<string, unknown>`) so a single map can hold them all.
// The dynamic Zod re-parse inside `RunReport.handle` re-narrows
// to the actual schema for type-safe consumption inside the
// report's own `run` function.

import type { ZodTypeAny } from "zod";

import { billingSummaryByClinicReport } from "./reports/billing-summary-by-clinic.js";
import { lotExpiryWarningsReport } from "./reports/lot-expiry-warnings.js";
import { orderVolumeByStageReport } from "./reports/order-volume-by-stage.js";
import { shipmentExceptionBreakdownReport } from "./reports/shipment-exception-breakdown.js";
import { slaBreachReport } from "./reports/sla-breach-report.js";
import { userProductivityByStageReport } from "./reports/user-productivity-by-stage.js";
import { verificationRejectionRateReport } from "./reports/verification-rejection-rate.js";
import type { ReportDefinition } from "./types.js";

/**
 * Type-erased report definition shape that the registry stores.
 * Real definitions are generic over their Zod schema + row type;
 * the registry stores them as `Record<string, unknown>`-shaped
 * rows so callers can iterate without per-report type plumbing.
 */
export type ReportDefinitionAny = ReportDefinition<ZodTypeAny, Record<string, unknown>>;

/**
 * id → definition map. Add new reports here; the bus command
 * `RunReport` resolves by id from this registry. Test parity
 * pins the keys so a missing import surfaces at vitest time.
 */
export const REPORT_REGISTRY: Readonly<Record<string, ReportDefinitionAny>> = Object.freeze({
  [orderVolumeByStageReport.id]: orderVolumeByStageReport as unknown as ReportDefinitionAny,
  [slaBreachReport.id]: slaBreachReport as unknown as ReportDefinitionAny,
  [shipmentExceptionBreakdownReport.id]:
    shipmentExceptionBreakdownReport as unknown as ReportDefinitionAny,
  [lotExpiryWarningsReport.id]: lotExpiryWarningsReport as unknown as ReportDefinitionAny,
  [billingSummaryByClinicReport.id]: billingSummaryByClinicReport as unknown as ReportDefinitionAny,
  [userProductivityByStageReport.id]:
    userProductivityByStageReport as unknown as ReportDefinitionAny,
  [verificationRejectionRateReport.id]:
    verificationRejectionRateReport as unknown as ReportDefinitionAny,
});
