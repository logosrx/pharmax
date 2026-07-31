// Compliance notification port.
//
// At the end of a quarterly access-review run, the system needs to
// nudge each organization's `OrgAdmin` to walk the report and sign
// off. The exact transport (email via Resend, Slack via a webhook,
// PagerDuty for SEV-tier anomalies) is environment-specific and
// orthogonal to the access-review logic.
//
// This port defines the contract. The production implementation is
// `NotificationChannelComplianceNotifier` (sibling module), which
// delivers via the worker's Resend-backed notification channel and
// the COMPLIANCE_NOTICE_V1 template; main.ts wires it when
// COMPLIANCE_NOTIFY_RECIPIENT_EMAIL + the Resend channel are both
// configured. The logger-only stub below remains the fallback so
// the job is safe to run in dev/unconfigured environments —
// auditors can still read the structured log line to verify the
// notification was issued at the right time.
//
// PHI invariant: the notification body MUST NOT contain PHI. It is
// allowed to contain operator emails (which are PII-not-PHI per
// the data-classification policy), aggregate counts, and a link
// to the evidence artifact in the audit-archive bucket.

import type { logger as loggerNs } from "@pharmax/platform-core";

type Logger = loggerNs.Logger;

export interface ComplianceNotice {
  /** Stable, machine-readable kind. e.g. "access-review.ready". */
  readonly kind: string;
  /** The org this notice concerns. */
  readonly organizationId: string;
  /** Human-readable subject (UTF-8, ≤ 120 chars). */
  readonly subject: string;
  /**
   * Human-readable body. Plain text or markdown depending on the
   * transport; transports MUST NOT alter it.
   */
  readonly body: string;
  /**
   * Optional evidence-artifact URI the notice links to. The
   * transport renders this as a clickable link if it can.
   */
  readonly evidenceUri?: string;
  /**
   * Optional severity hint. Defaults to "info". "warning" and
   * "critical" let downstream transports route differently
   * (e.g. PagerDuty on critical).
   */
  readonly severity?: "info" | "warning" | "critical";
}

export interface ComplianceNotifyResult {
  /** Free-form transport id for the audit trail. */
  readonly transportId: string;
}

export interface ComplianceNotifier {
  notify(notice: ComplianceNotice): Promise<ComplianceNotifyResult>;
}

/**
 * Fallback stub: emits a structured log line. Production wires
 * `NotificationChannelComplianceNotifier` instead (see main.ts);
 * this stub remains the default so the access-review job never
 * silently fails when the email transport is unconfigured.
 */
export class LoggingComplianceNotifier implements ComplianceNotifier {
  constructor(private readonly logger: Logger) {}

  async notify(notice: ComplianceNotice): Promise<ComplianceNotifyResult> {
    this.logger.info("compliance.notify", {
      kind: notice.kind,
      organizationId: notice.organizationId,
      subject: notice.subject,
      severity: notice.severity ?? "info",
      evidenceUri: notice.evidenceUri ?? null,
    });
    return { transportId: `log:${notice.kind}:${notice.organizationId}:${Date.now().toString()}` };
  }
}

/** Test notifier: keeps every notice in memory. */
export class RecordingComplianceNotifier implements ComplianceNotifier {
  readonly notices: ComplianceNotice[] = [];

  async notify(notice: ComplianceNotice): Promise<ComplianceNotifyResult> {
    this.notices.push(notice);
    return { transportId: `recording:${notice.kind}:${String(this.notices.length)}` };
  }
}
