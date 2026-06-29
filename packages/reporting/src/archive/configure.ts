// Boot-time singleton for the ReportRunArchivePort.
//
// Mirrors the configure pattern used elsewhere (crypto, billing,
// notifications): one wiring call at process start, every
// downstream consumer resolves via `getReportRunArchive()` rather
// than threading the adapter through a constructor chain.
//
// Optional by design — when NOT configured, `getReportRunArchive()`
// returns `null` and `RunReport` falls through to its existing
// "produce CSV, return it, don't persist" behavior. Dev
// environments without S3 still work; the operator console's
// download page renders a "this run wasn't archived" empty state.

import { errors, runtime } from "@pharmax/platform-core";

import type { ReportRunArchivePort } from "./report-run-archive.js";

export const REPORTING_ARCHIVE_ALREADY_CONFIGURED = "REPORTING_ARCHIVE_ALREADY_CONFIGURED" as const;

export interface ReportRunArchiveConfiguration {
  readonly archive: ReportRunArchivePort;
}

// globalThis-backed so boot (Next instrumentation bundle) and use
// (route bundles) share ONE configuration despite webpack giving each
// bundle its own copy of this module. See platform-core
// runtime/global-singleton.ts for the full rationale.
const box = runtime.globalSingletonBox<ReportRunArchivePort>("pharmax:reporting:archive");

/**
 * Wire the archive port. Idempotent re-call with the same instance
 * is a no-op; re-call with a DIFFERENT instance throws — only the
 * test harness has a legitimate reason to swap mid-process and
 * uses `resetReportRunArchiveConfigurationForTests` for that.
 */
export function configureReportRunArchive(config: ReportRunArchiveConfiguration): void {
  if (box.value !== null && box.value !== config.archive) {
    throw new errors.InvariantViolationError({
      code: REPORTING_ARCHIVE_ALREADY_CONFIGURED,
      message:
        "configureReportRunArchive was called with a different adapter instance; only the test harness may swap.",
    });
  }
  box.value = config.archive;
}

/**
 * Resolve the configured archive. Returns `null` when none is
 * wired — the caller decides whether that's a hard error or a
 * graceful skip. `RunReport`'s persistCsv path treats it as a
 * skip + log; the download route treats it as a hard "not
 * available" page.
 */
export function getReportRunArchive(): ReportRunArchivePort | null {
  return box.value;
}

/** Drop the wired adapter. Test-harness only. */
export function resetReportRunArchiveConfigurationForTests(): void {
  box.value = null;
}
