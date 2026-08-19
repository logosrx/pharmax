// Idle-time derivation.
//
// WHY IDLE IS DERIVED RATHER THAN REPORTED BY THE CLIENT
// ------------------------------------------------------
// The rule vocabulary lists `idle started` / `idle ended` as events,
// and the obvious reading is that the browser emits them. Three
// reasons this implementation derives them instead:
//
//   1. PRIVACY. For a client to know the operator went idle it has
//      to watch something — mouse movement, keypresses, focus. The
//      same rule file forbids tracking keystrokes and personal
//      device activity, and "application-level activity only" is the
//      standard it sets. Deriving idle from gaps between WORK events
//      needs no input-device listener at all, so the capability
//      never exists to be misused or subpoenaed.
//
//   2. ROBUSTNESS. An explicitly-reported idle interval is only ever
//      closed by a client that survives to close it. A browser that
//      crashes, sleeps, or loses its network mid-idle leaves an open
//      interval that no server-side timeout can honestly resolve —
//      was the operator idle for four minutes or four hours? Derived
//      idle has no open state to leak: presence simply stops when
//      the heartbeats stop.
//
//   3. TRUST. Idle time feeds productivity reporting, so the client
//      reporting it has an interest in the answer. Gaps between
//      server-recorded work events are not something the client
//      writes directly.
//
// The cost is resolution: derived idle is accurate to the heartbeat
// and slot cadence, not to the second. For a report answering "how
// much of the shift was idle", that is the right trade.

/** One presence slot, as read from `operator_presence_slot`. */
export interface PresenceSlotInput {
  readonly slotStartedAt: Date;
  readonly firstHeartbeatAt: Date;
  readonly lastHeartbeatAt: Date;
}

/** A stretch of continuous presence, stitched from adjacent slots. */
export interface PresenceSpan {
  readonly startedAt: Date;
  readonly endedAt: Date;
}

export interface IdleWindow {
  readonly startedAt: Date;
  readonly endedAt: Date;
  readonly durationMs: number;
}

export interface DeriveIdleTimeResult {
  readonly presentMs: number;
  readonly idleMs: number;
  /** `presentMs - idleMs`; never negative. */
  readonly activeMs: number;
  readonly idleWindows: ReadonlyArray<IdleWindow>;
  readonly presenceSpans: ReadonlyArray<PresenceSpan>;
}

/**
 * Stitch slots into continuous presence spans.
 *
 * Two slots continue the same span when they are ADJACENT on the
 * grid (`next.slotStartedAt - current.slotStartedAt === slotMs`). A
 * missing slot means no heartbeat arrived for a whole slot width,
 * which is the operator being gone — closing the tab, locking the
 * screen, going home — not being idle at the console. Counting that
 * absence as idle would make "went home at 5pm" indistinguishable
 * from "sat doing nothing", and would inflate every overnight gap
 * into idle time.
 */
export function buildPresenceSpans(
  slots: ReadonlyArray<PresenceSlotInput>,
  slotMs: number
): ReadonlyArray<PresenceSpan> {
  if (slots.length === 0) return [];

  const sorted = [...slots].sort((a, b) => a.slotStartedAt.getTime() - b.slotStartedAt.getTime());
  const spans: PresenceSpan[] = [];

  let spanStart = sorted[0]!.firstHeartbeatAt;
  let spanEnd = sorted[0]!.lastHeartbeatAt;
  let previousSlotStart = sorted[0]!.slotStartedAt.getTime();

  for (let i = 1; i < sorted.length; i++) {
    const slot = sorted[i]!;
    const slotStart = slot.slotStartedAt.getTime();
    if (slotStart - previousSlotStart === slotMs) {
      spanEnd = slot.lastHeartbeatAt;
    } else {
      spans.push(Object.freeze({ startedAt: spanStart, endedAt: spanEnd }));
      spanStart = slot.firstHeartbeatAt;
      spanEnd = slot.lastHeartbeatAt;
    }
    previousSlotStart = slotStart;
  }
  spans.push(Object.freeze({ startedAt: spanStart, endedAt: spanEnd }));

  return Object.freeze(spans);
}

/**
 * Derive idle time from presence spans and the instants at which the
 * operator did something.
 *
 * `activityAt` should carry every server-recorded work signal for the
 * operator in the window — `operator_activity_event.occurredAt` plus
 * `command_log.startedAt`, since a command IS work and is already
 * recorded. Omitting commands would score a tech who spent twenty
 * minutes filling orders as idle for all twenty.
 *
 * An idle window is a stretch inside a presence span with no activity
 * for longer than `idleThresholdMs`. The stretch before the first
 * activity of a span, and the stretch after the last, both count —
 * signing in and reading a dashboard for half an hour is idle.
 */
export function deriveIdleTime(input: {
  readonly slots: ReadonlyArray<PresenceSlotInput>;
  readonly activityAt: ReadonlyArray<Date>;
  readonly idleThresholdMs: number;
  readonly slotMs: number;
}): DeriveIdleTimeResult {
  const spans = buildPresenceSpans(input.slots, input.slotMs);
  const activity = [...input.activityAt].sort((a, b) => a.getTime() - b.getTime());

  const idleWindows: IdleWindow[] = [];
  let presentMs = 0;

  for (const span of spans) {
    const spanStart = span.startedAt.getTime();
    const spanEnd = span.endedAt.getTime();
    presentMs += Math.max(0, spanEnd - spanStart);

    // Marks bounding the gaps we measure: the span's own edges, plus
    // every activity instant inside it.
    const marks: number[] = [spanStart];
    for (const at of activity) {
      const t = at.getTime();
      if (t > spanStart && t < spanEnd) marks.push(t);
    }
    marks.push(spanEnd);

    for (let i = 1; i < marks.length; i++) {
      const gapStart = marks[i - 1]!;
      const gapEnd = marks[i]!;
      const durationMs = gapEnd - gapStart;
      if (durationMs > input.idleThresholdMs) {
        idleWindows.push(
          Object.freeze({
            startedAt: new Date(gapStart),
            endedAt: new Date(gapEnd),
            durationMs,
          })
        );
      }
    }
  }

  const idleMs = idleWindows.reduce((sum, w) => sum + w.durationMs, 0);

  return Object.freeze({
    presentMs,
    idleMs,
    activeMs: Math.max(0, presentMs - idleMs),
    idleWindows: Object.freeze(idleWindows),
    presenceSpans: spans,
  });
}
