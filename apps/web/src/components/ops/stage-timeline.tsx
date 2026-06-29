// StageTimeline — the order's position in the workflow, as a stepper.
//
// Reads the current status' stage (via `statusMeta`) and renders the
// canonical stage sequence (Intake → … → Shipped) with completed,
// current, and upcoming states. Exception statuses (rejected, on hold,
// cancelled) render an explicit callout instead of a misleading
// "current step", since they sit off the happy path.

import { Icon } from "../ui/icon.js";
import { Badge } from "../ui/badge.js";
import { cx } from "../ui/cx.js";
import { STAGE_LABEL, STAGE_ORDER, statusMeta } from "../ui/workflow.js";

export function StageTimeline({ status }: { readonly status: string }) {
  const meta = statusMeta(status);
  const currentIndex = STAGE_ORDER.indexOf(meta.stage);
  const isException = meta.exception === true || currentIndex === -1;

  return (
    <div className="space-y-3">
      <ol className="flex items-center gap-1 overflow-x-auto pb-1">
        {STAGE_ORDER.map((stage, i) => {
          const done = !isException && i < currentIndex;
          const current = !isException && i === currentIndex;
          const last = i === STAGE_ORDER.length - 1;
          return (
            <li key={stage} className="flex min-w-0 flex-1 items-center">
              <div className="flex min-w-0 flex-col items-center gap-1.5">
                <span
                  className={cx(
                    "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition-colors",
                    done && "border-emerald-500/40 bg-emerald-500/15 text-emerald-300",
                    current && "border-brand bg-brand/15 text-brand shadow-glow",
                    !done && !current && "border-line bg-surface-2 text-subtle"
                  )}
                >
                  {done ? <Icon name="check" size={14} /> : i + 1}
                </span>
                <span
                  className={cx(
                    "truncate text-[11px] font-medium",
                    current ? "text-fg" : done ? "text-muted" : "text-subtle"
                  )}
                >
                  {STAGE_LABEL[stage]}
                </span>
              </div>
              {!last ? (
                <span className={cx("mx-1 h-px flex-1", done ? "bg-emerald-500/40" : "bg-line")} />
              ) : null}
            </li>
          );
        })}
      </ol>
      {isException ? (
        <div className="flex items-center gap-2">
          <Badge tone={meta.tone} icon="alert">
            {meta.label}
          </Badge>
          <span className="text-xs text-muted">
            This order is off the standard path and needs operator action.
          </span>
        </div>
      ) : null}
    </div>
  );
}
