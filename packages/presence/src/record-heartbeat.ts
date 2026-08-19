// Heartbeat ingest — "this operator is still at the console".
//
// WHY THIS IS NOT A COMMAND
// -------------------------
// `.cursor/rules/01-workflow-safety.mdc` requires command_log +
// order_event + audit_log + event_outbox on every critical
// transition, and forbids mutating workflow state outside a handler.
// That rule is about WORKFLOW STATE. A heartbeat mutates none: it
// locks no order row, resolves no workflow policy, has no reason
// code, cannot be rejected, and no safety gate anywhere reads it.
//
// Routing it through the bus would not merely be wasteful, it would
// be actively hazardous. `audit_log` is a per-tenant hash chain
// serialized behind an advisory lock (see the audit_chain migration).
// One heartbeat per operator per minute would put every tenant's
// audit chain — the tamper-evidence structure protecting PHI access
// records — behind a continuous stream of presence traffic. The
// highest-frequency, lowest-value signal in the platform would
// become the bottleneck for its most important one.
//
// So: direct write, through the TENANCY-ENFORCED client, with the
// actor taken from the frame.

import { prisma, type PrismaClient } from "@pharmax/database";
import { requireCurrentContext } from "@pharmax/tenancy";

import { PRESENCE_SLOT_MS } from "./constants.js";
import { presenceSlotStart } from "./slot.js";

/** Minimal client surface, so tests can pass a fake. */
export type PresenceSlotClient = Pick<PrismaClient, "operatorPresenceSlot">;

export interface RecordHeartbeatOptions {
  readonly client?: PresenceSlotClient;
  readonly now?: Date;
  readonly slotMs?: number;
}

export interface RecordHeartbeatResult {
  readonly slotStartedAt: Date;
  /** True when this beat opened the slot rather than folding into it. */
  readonly createdSlot: boolean;
}

/**
 * Record one heartbeat for the operator in the active tenancy frame.
 *
 * NOTE THE SIGNATURE: there is no `userId` and no `organizationId`
 * parameter, and that is a security property rather than an
 * ergonomic one. This is the highest-call-rate write in the platform
 * and it is reachable from an authenticated-but-otherwise-unprivileged
 * endpoint. If it accepted an actor, a caller could forge presence —
 * and therefore productivity and idle-time — for any user whose id
 * they could guess. Taking both ids from the frame means the worst a
 * caller can do is assert something about themselves.
 *
 * Idempotent by construction: the upsert targets the
 * `(organizationId, userId, slotStartedAt)` unique key, so beating
 * ten times a second rewrites one row instead of inserting rows.
 */
export async function recordHeartbeat(
  options: RecordHeartbeatOptions = {}
): Promise<RecordHeartbeatResult> {
  const ctx = requireCurrentContext();
  const client = options.client ?? prisma;
  const now = options.now ?? new Date();
  const slotMs = options.slotMs ?? PRESENCE_SLOT_MS;
  const slotStartedAt = presenceSlotStart(now, slotMs);

  // `upsert` rather than read-then-write: two tabs beating
  // concurrently must converge on one row, and a read-modify-write
  // would race into a unique-constraint failure on the second.
  const before = await client.operatorPresenceSlot.upsert({
    where: {
      organizationId_userId_slotStartedAt: {
        organizationId: ctx.organizationId,
        userId: ctx.actor.userId,
        slotStartedAt,
      },
    },
    create: {
      organizationId: ctx.organizationId,
      userId: ctx.actor.userId,
      workstationId: ctx.workstationId ?? null,
      slotStartedAt,
      firstHeartbeatAt: now,
      lastHeartbeatAt: now,
      heartbeatCount: 1,
    },
    update: {
      lastHeartbeatAt: now,
      heartbeatCount: { increment: 1 },
      // Last workstation wins. An operator moving between benches
      // mid-slot is attributed to where they ended up; presence
      // itself is a property of the person, not the bench.
      workstationId: ctx.workstationId ?? null,
    },
    select: { heartbeatCount: true, slotStartedAt: true },
  });

  return Object.freeze({
    slotStartedAt: before.slotStartedAt,
    createdSlot: before.heartbeatCount === 1,
  });
}
