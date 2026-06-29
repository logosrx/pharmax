// QueueRow — the canonical order row for every workflow queue.
//
// One presentational shell (order link + priority/status badges + SLA
// + age + assignee + optional exception note) with an actions slot.
// Each queue page supplies only its stage-specific actions as
// children; the row chrome, SLA accent rail, and "claimed by" line
// are identical everywhere, so the queues read the same to operators.

import Link from "next/link";
import type { ReactNode } from "react";

import { Card } from "../ui/card.js";
import { Badge } from "../ui/badge.js";
import { Icon } from "../ui/icon.js";
import { priorityMeta, statusMeta } from "../ui/workflow.js";
import { SlaBadge, slaStatusFor, slaTone } from "../sla-badge.js";

export function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

export function QueueRow({
  orderId,
  externalOrderNumber,
  priority,
  status,
  slaDeadlineAt,
  receivedAt,
  now,
  assigneeUserId,
  note,
  headerExtra,
  children,
}: {
  readonly orderId: string;
  readonly externalOrderNumber: string | null;
  readonly priority: string;
  readonly status: string;
  readonly slaDeadlineAt: Date | null;
  readonly receivedAt: Date;
  readonly now: Date;
  /** Shown as "Claimed by …" when another operator owns the row. */
  readonly assigneeUserId?: string | null;
  readonly note?: ReactNode;
  readonly headerExtra?: ReactNode;
  readonly children?: ReactNode;
}) {
  const pm = priorityMeta(priority);
  const sm = statusMeta(status);
  const accent = slaTone(slaStatusFor(slaDeadlineAt, now));
  const age = formatAge(now.getTime() - receivedAt.getTime());

  return (
    <Card accent={accent}>
      <div className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <Link
                href={`/ops/orders/${orderId}`}
                className="font-mono text-sm font-medium text-fg transition-colors hover:text-brand"
              >
                {externalOrderNumber ?? orderId}
              </Link>
              <Badge tone={pm.tone}>{pm.label}</Badge>
              <Badge tone={sm.tone}>{sm.label}</Badge>
              <SlaBadge slaDeadlineAt={slaDeadlineAt} now={now} />
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle">
              <span className="inline-flex items-center gap-1">
                <Icon name="clock" size={12} />
                aged {age}
              </span>
              {assigneeUserId ? (
                <span>
                  claimed by <code className="text-muted">{assigneeUserId}</code>
                </span>
              ) : null}
            </div>
            {note ? <div className="text-xs text-amber-300/90">{note}</div> : null}
          </div>
          {headerExtra ? <div className="flex items-center gap-2">{headerExtra}</div> : null}
        </div>
        {children ? (
          <div className="flex flex-wrap items-end gap-2 border-t border-line pt-3">{children}</div>
        ) : null}
      </div>
    </Card>
  );
}
