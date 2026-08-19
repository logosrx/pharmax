// Idle time by user — how much of the time an operator was AT the
// console they were not doing anything, over a date range.
//
// Serves the product requirement (rules: "idle time", "active work
// time", and the idle started / idle ended entries in the
// application-activity vocabulary).
//
// Why this report needed a new data source
// ----------------------------------------
// `user-productivity-by-stage` measures active work time from
// `order_stage_interval`, and `wait-time-by-stage` measures how long
// ORDERS sit. Neither can see the operator between those intervals:
// a tech who verified four orders in an eight-hour shift looks
// identical to one who verified four in forty minutes and then did
// nothing, because both produced the same intervals. The missing
// input is presence — evidence the operator was logged in and at the
// console during the stretches where no work landed. That is what
// `operator_presence_slot` records, and it is why this report could
// not be written before it existed.
//
// Idle is DERIVED, not reported
// -----------------------------
// Nothing in the client says "I went idle". Idle is computed
// server-side as stretches of presence with no application activity
// for longer than a threshold — see `deriveIdleTime` in
// @pharmax/presence for the full argument, of which the short form
// is: for a browser to KNOW the operator is idle it must watch the
// mouse and keyboard, and the same rule file that asks for idle
// tracking forbids tracking keystrokes.
//
// What counts as activity
// -----------------------
// Both halves of the record, deliberately:
//
//   - `operator_activity_event` — order opened, queue claimed, scan,
//     sign-out. The discrete signals with no other home.
//   - `command_log.startedAt` — every workflow command the operator
//     dispatched. A tech spends most of a shift inside commands, and
//     scoring that as idle would invert the report's meaning.
//
// ABSENCE IS NOT IDLE
// -------------------
// A gap with no heartbeats at all breaks the presence span rather
// than counting as idle. An operator who closes the laptop at 17:00
// is absent, not idle, and lumping the two together would make every
// overnight look like a sixteen-hour idle window and swamp the real
// signal. This is the distinction that makes the number usable for
// staffing rather than for discipline.
//
// PHI invariant: reads `userId`, timestamps, and `kind` only. No
// patient columns, no order payloads. The rows name operators, which
// is staff data, not PHI.

import {
  DEFAULT_IDLE_THRESHOLD_MS,
  PRESENCE_SLOT_MS,
  deriveIdleTime,
  type PresenceSlotInput,
} from "@pharmax/presence";
import { z } from "zod";

import { dateRangeFields } from "../parameter-fields.js";
import type { DateRangeParams, ReportDefinition, ReportResult } from "../types.js";

export interface IdleTimeByUserRow {
  readonly userId: string;
  readonly userDisplayName: string;
  /** Total time the operator was present at the console. */
  readonly presentSeconds: number;
  readonly idleSeconds: number;
  readonly activeSeconds: number;
  /** Share of present time spent idle, in basis points. */
  readonly idleRateBps: number;
  /** Number of distinct idle stretches over the threshold. */
  readonly idleWindowCount: number;
  /** Longest single idle stretch. */
  readonly longestIdleSeconds: number;
  /** Distinct continuous presence stretches (roughly, sittings). */
  readonly presenceSpanCount: number;
}

const paramsSchema = z
  .object({
    from: z.date(),
    to: z.date(),
    /**
     * Minutes of no application activity, while present, before the
     * stretch counts as idle. Exposed because the right answer is
     * operational rather than technical — a compounding bench and a
     * data-entry desk have different natural rhythms.
     */
    idleThresholdMinutes: z.number().int().min(1).max(120).default(5),
  })
  .strict()
  .refine((v) => v.from <= v.to, {
    message: "from must be <= to",
    path: ["from"],
  });

export type IdleTimeByUserParams = z.infer<typeof paramsSchema>;

function rateBps(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 10_000);
}

function toSeconds(ms: number): number {
  return Math.round(ms / 1000);
}

export const idleTimeByUserReport: ReportDefinition<typeof paramsSchema, IdleTimeByUserRow> = {
  id: "idle-time-by-user",
  version: 1,
  title: "Idle time by user",
  description:
    "Per-operator present, idle, and active time over a date range. Idle is derived server-side from stretches of console presence with no application activity — never from keyboard or mouse monitoring — and time with no heartbeat at all counts as absent rather than idle.",
  parametersSchema: paramsSchema,
  parameterFields: [
    ...dateRangeFields(),
    {
      kind: "number",
      key: "idleThresholdMinutes",
      label: "Idle threshold (minutes)",
      required: false,
      help: "Minutes without application activity, while still present, before a stretch counts as idle.",
      min: 1,
      max: 120,
      defaultValue: 5,
    },
  ],

  async run(ctx, params): Promise<ReportResult<IdleTimeByUserRow>> {
    const window: DateRangeParams = { from: params.from, to: params.to };
    const idleThresholdMs =
      params.idleThresholdMinutes > 0
        ? params.idleThresholdMinutes * 60_000
        : DEFAULT_IDLE_THRESHOLD_MS;

    // Presence is the spine: an operator with no slots in the window
    // has no presence to be idle within, so the query set is driven
    // by these rows.
    const slots = await ctx.client.operatorPresenceSlot.findMany({
      where: {
        organizationId: ctx.organizationId,
        slotStartedAt: { gte: window.from, lte: window.to },
      },
      select: {
        userId: true,
        slotStartedAt: true,
        firstHeartbeatAt: true,
        lastHeartbeatAt: true,
        user: { select: { displayName: true } },
      },
    });

    if (slots.length === 0) {
      return Object.freeze({
        rows: [],
        aggregates: Object.freeze({
          totalPresentSeconds: 0,
          totalIdleSeconds: 0,
          totalActiveSeconds: 0,
          overallIdleRateBps: 0,
          operatorCount: 0,
        }),
        window,
        generatedAt: ctx.asOf ?? new Date(),
      });
    }

    const userIds = [...new Set(slots.map((s) => s.userId))];

    // Both halves of the activity record. `command_log` matters as
    // much as the activity table: a tech spends most of a shift
    // inside commands, and omitting them would score that as idle.
    const [activityEvents, commands] = await Promise.all([
      ctx.client.operatorActivityEvent.findMany({
        where: {
          organizationId: ctx.organizationId,
          userId: { in: userIds },
          occurredAt: { gte: window.from, lte: window.to },
        },
        select: { userId: true, occurredAt: true },
      }),
      ctx.client.commandLog.findMany({
        where: {
          organizationId: ctx.organizationId,
          actorUserId: { in: userIds },
          startedAt: { gte: window.from, lte: window.to },
        },
        select: { actorUserId: true, startedAt: true },
      }),
    ]);

    const slotsByUser = new Map<string, PresenceSlotInput[]>();
    const displayNameByUser = new Map<string, string>();
    for (const slot of slots) {
      displayNameByUser.set(slot.userId, slot.user.displayName);
      const bucket = slotsByUser.get(slot.userId);
      const entry: PresenceSlotInput = {
        slotStartedAt: slot.slotStartedAt,
        firstHeartbeatAt: slot.firstHeartbeatAt,
        lastHeartbeatAt: slot.lastHeartbeatAt,
      };
      if (bucket === undefined) slotsByUser.set(slot.userId, [entry]);
      else bucket.push(entry);
    }

    const activityByUser = new Map<string, Date[]>();
    const pushActivity = (userId: string, at: Date): void => {
      const bucket = activityByUser.get(userId);
      if (bucket === undefined) activityByUser.set(userId, [at]);
      else bucket.push(at);
    };
    for (const event of activityEvents) pushActivity(event.userId, event.occurredAt);
    for (const command of commands) {
      if (command.actorUserId === null) continue;
      pushActivity(command.actorUserId, command.startedAt);
    }

    const rows: IdleTimeByUserRow[] = [...slotsByUser.entries()]
      .map(([userId, userSlots]) => {
        const derived = deriveIdleTime({
          slots: userSlots,
          activityAt: activityByUser.get(userId) ?? [],
          idleThresholdMs,
          slotMs: PRESENCE_SLOT_MS,
        });
        const longestIdleMs = derived.idleWindows.reduce(
          (max, w) => (w.durationMs > max ? w.durationMs : max),
          0
        );

        return Object.freeze({
          userId,
          userDisplayName: displayNameByUser.get(userId) ?? userId,
          presentSeconds: toSeconds(derived.presentMs),
          idleSeconds: toSeconds(derived.idleMs),
          activeSeconds: toSeconds(derived.activeMs),
          idleRateBps: rateBps(derived.idleMs, derived.presentMs),
          idleWindowCount: derived.idleWindows.length,
          longestIdleSeconds: toSeconds(longestIdleMs),
          presenceSpanCount: derived.presenceSpans.length,
        });
      })
      // Most idle first: the report exists to surface where capacity
      // is sitting unused, so that belongs at the top.
      .sort((a, b) => b.idleSeconds - a.idleSeconds || a.userId.localeCompare(b.userId));

    const totalPresentSeconds = rows.reduce((n, r) => n + r.presentSeconds, 0);
    const totalIdleSeconds = rows.reduce((n, r) => n + r.idleSeconds, 0);

    return Object.freeze({
      rows,
      aggregates: Object.freeze({
        totalPresentSeconds,
        totalIdleSeconds,
        totalActiveSeconds: rows.reduce((n, r) => n + r.activeSeconds, 0),
        overallIdleRateBps: rateBps(totalIdleSeconds, totalPresentSeconds),
        operatorCount: rows.length,
      }),
      window,
      generatedAt: ctx.asOf ?? new Date(),
    });
  },
};
