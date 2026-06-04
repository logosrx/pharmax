// SlaBadge — operator queue SLA indicator.
//
// Renders the canonical SLA status (`@pharmax/sla::classifySlaStatus`)
// as a colored badge:
//   NONE / ON_TRACK → nothing (no badge clutter on healthy orders)
//   WARNING         → amber "SLA due in Xm" (approaching the deadline)
//   BREACHED        → red "SLA breached Xm ago"
//
// One component so every queue page (typing, PV1, fill, final,
// shipping, emergency) shows SLA the SAME way, classified in ONE
// place. `slaRowBorderClass` gives the matching row-border accent.
//
// Server component, no client JS. `now` is passed in (the page's
// single render timestamp) so all rows classify against the same
// instant.

import { classifySlaStatus, msUntilSlaDeadline, type SlaStatus } from "@pharmax/sla";

function formatDuration(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < 60_000) return `${Math.floor(abs / 1000)}s`;
  if (abs < 3_600_000) return `${Math.floor(abs / 60_000)}m`;
  if (abs < 86_400_000) return `${Math.floor(abs / 3_600_000)}h`;
  return `${Math.floor(abs / 86_400_000)}d`;
}

/** Classify a deadline against `now` — re-exported convenience so
 *  pages don't import `@pharmax/sla` directly for the common case. */
export function slaStatusFor(slaDeadlineAt: Date | null, now: Date): SlaStatus {
  return classifySlaStatus({ slaDeadlineAt, now });
}

/** Row-border accent class matching the SLA status (or empty for
 *  healthy / no-SLA rows). */
export function slaRowBorderClass(status: SlaStatus): string {
  switch (status) {
    case "BREACHED":
      return "border-red-800";
    case "WARNING":
      return "border-amber-800";
    case "ON_TRACK":
    case "NONE":
    default:
      return "border-neutral-800";
  }
}

export function SlaBadge({
  slaDeadlineAt,
  now,
}: {
  readonly slaDeadlineAt: Date | null;
  readonly now: Date;
}) {
  const status = classifySlaStatus({ slaDeadlineAt, now });
  if (status === "NONE" || status === "ON_TRACK") return null;

  const ms = msUntilSlaDeadline({ slaDeadlineAt, now }) ?? 0;
  if (status === "BREACHED") {
    return (
      <span className="inline-flex items-center rounded-md border border-red-700 bg-red-950 px-2 py-0.5 text-xs font-medium text-red-200">
        SLA breached {formatDuration(ms)} ago
      </span>
    );
  }
  // WARNING
  return (
    <span className="inline-flex items-center rounded-md border border-amber-700 bg-amber-950 px-2 py-0.5 text-xs font-medium text-amber-200">
      SLA due in {formatDuration(ms)}
    </span>
  );
}
