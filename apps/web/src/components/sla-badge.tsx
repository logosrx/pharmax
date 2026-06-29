// SlaBadge — operator queue SLA indicator.
//
// Renders the canonical SLA status (`@pharmax/sla::classifySlaStatus`)
// through the shared <Badge> so SLA reads identically to every other
// status pill in the console:
//   NONE / ON_TRACK → nothing (no badge clutter on healthy orders)
//   WARNING         → amber "Due in Xm"
//   BREACHED        → red "Breached Xm ago"
//
// Classification lives in ONE place (`@pharmax/sla`); this is purely
// presentational. `slaTone` maps a status to a Badge/Card tone so a
// queue row can paint its accent rail to match.

import { classifySlaStatus, msUntilSlaDeadline, type SlaStatus } from "@pharmax/sla";

import { Badge, type Tone } from "./ui/badge.js";

function formatDuration(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < 60_000) return `${Math.floor(abs / 1000)}s`;
  if (abs < 3_600_000) return `${Math.floor(abs / 60_000)}m`;
  if (abs < 86_400_000) return `${Math.floor(abs / 3_600_000)}h`;
  return `${Math.floor(abs / 86_400_000)}d`;
}

/** Classify a deadline against `now`. */
export function slaStatusFor(slaDeadlineAt: Date | null, now: Date): SlaStatus {
  return classifySlaStatus({ slaDeadlineAt, now });
}

/** Map an SLA status to a design-system tone (for Card accents). */
export function slaTone(status: SlaStatus): Tone | undefined {
  switch (status) {
    case "BREACHED":
      return "danger";
    case "WARNING":
      return "warning";
    default:
      return undefined;
  }
}

/** Legacy border-accent helper — retained for callers not yet on the
 *  Card `accent` prop. */
export function slaRowBorderClass(status: SlaStatus): string {
  switch (status) {
    case "BREACHED":
      return "border-red-500/40";
    case "WARNING":
      return "border-amber-500/40";
    default:
      return "border-line";
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
      <Badge tone="danger" icon="alert">
        Breached {formatDuration(ms)} ago
      </Badge>
    );
  }
  return (
    <Badge tone="warning" icon="clock">
      Due in {formatDuration(ms)}
    </Badge>
  );
}
