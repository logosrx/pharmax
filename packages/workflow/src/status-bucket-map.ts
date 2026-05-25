// Status → bucket-code map.
//
// Every primary workflow state has a canonical bucket where the
// order should live while in that state. This is the data that
// `CreateOrder`, `StartTyping`, `ApprovePV1`, etc. use to resolve
// `current_bucket_id` on a transition.
//
// The convention is "the bucket whose queue should show this order
// for the next-stage actor":
//
//   - `RECEIVED` lands in `INBOX` (waiting for a typer to claim).
//   - `TYPING_IN_PROGRESS` stays in `TYPING` (typer is working it).
//   - `TYPED_READY_FOR_PV1` lands in `PV1` (waiting for a pharmacist
//     to start PV1) — the order's CURRENT actor is "nobody yet" and
//     the NEXT actor is the PV1 pharmacist; the order belongs in the
//     pharmacist's queue, not the typer's.
//   - The same pattern repeats for FILL, FINAL, and SHIPPING.
//
// Bucket codes here MUST match the system bucket codes that
// `CreateOrganization` seeds per-site (today the demo seed in
// `prisma/seed.ts` is the source of truth; once `CreateOrganization`
// is extended to seed per-site buckets, that command takes over).
// A mismatch is a runtime "no intake bucket configured" failure —
// loud, but a failure all the same.
//
// Exception states are governed by `BUCKET_CODE_FOR_EXCEPTION_STATE`
// (below) — a separate `Partial<Record<OrderExceptionState, string>>`
// table. Two tables instead of one broadened
// `Record<OrderState, string>` because:
//
//   - Primary states have a CANONICAL bucket (workflow demands the
//     order live in the next-stage actor's queue); the
//     `Record<OrderPrimaryState, string>` total-record type forces
//     exhaustiveness — adding a new primary state without a bucket
//     is a compile-time failure.
//   - Exception states have a REWORK-OR-NOTHING bucket (PV1_REJECTED
//     bounces back to TYPING; CANCELLED leaves all queues; ON_HOLD
//     has its own bucket). The `Partial<...>` type captures that
//     some exception states intentionally have no bucket (CANCELLED
//     is terminal; the queue UI filters by status).
//
// Mixing the two would lose both signals — exhaustiveness on the
// primary side and "no bucket is a valid answer" on the exception
// side.
//
// Remaining exception states not yet mapped:
//
//   - TYPING_PENDING_MISSING_INFO → typically `MISSING_INFO` or
//     remains in `TYPING` depending on the org's queue UX preference;
//     pinned when `MarkTypingMissingInfo` lands.
//   - ON_HOLD → a dedicated hold bucket; pinned when `PlaceHold` lands.
//   - CANCELLED is terminal; the order leaves all active queues, so
//     no bucket mapping is needed (the queue UI filters by status).
//
// This file is pure data. No I/O, no Prisma. Safe to import from any
// package, including pure-engine code.

import type { OrderExceptionState, OrderPrimaryState } from "./states.js";

/**
 * Canonical bucket code for each primary workflow state.
 *
 * `Record<OrderPrimaryState, string>` makes this exhaustive —
 * adding a new primary state without a bucket mapping is a
 * compile-time failure.
 */
export const BUCKET_CODE_FOR_STATUS: Record<OrderPrimaryState, string> = {
  RECEIVED: "INBOX",
  TYPING_IN_PROGRESS: "TYPING",
  TYPED_READY_FOR_PV1: "PV1",
  PV1_IN_PROGRESS: "PV1",
  PV1_APPROVED_READY_FOR_FILL: "FILL",
  FILL_IN_PROGRESS: "FILL",
  FILL_COMPLETED_READY_FOR_FINAL: "FINAL",
  FINAL_VERIFICATION_IN_PROGRESS: "FINAL",
  FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP: "SHIPPING",
  READY_TO_SHIP: "SHIPPING",
  SHIPPED: "SHIPPING",
};

/**
 * Bucket code for exception states that have a defined rework queue.
 *
 * `Partial<Record<OrderExceptionState, string>>` because not every
 * exception state has a bucket — CANCELLED is terminal (no queue),
 * and some states (TYPING_PENDING_MISSING_INFO, ON_HOLD) are pinned
 * by their own commands when those land.
 *
 * Rationale per state currently mapped:
 *
 *   - PV1_REJECTED → "TYPING" — the rejected order bounces back to
 *     the typing queue so the typist (or another typist) can address
 *     the PV1 pharmacist's rejection reason and re-submit. Some orgs
 *     may prefer a dedicated "REJECTED" or "REWORK" bucket; that
 *     would be a per-org admin feature (extra bucket seeded for the
 *     site, and this map overridden / extended in a future per-tenant
 *     policy slice). Defaulting to the existing TYPING bucket avoids
 *     a schema migration today and matches how most pharmacies
 *     actually triage rejections (the typist sees the order back in
 *     their queue with a red banner showing `currentStatus =
 *     PV1_REJECTED` and the rejection reason).
 *
 *   - FINAL_VERIFICATION_REJECTED → "FILL" — the rejected order
 *     bounces back to the fill queue. By the time it reaches
 *     final-verification rejection, typing and PV1 have BOTH
 *     already passed; what failed is the physical fill
 *     (wrong drug pulled, wrong strength, label damaged, expired
 *     lot assigned, etc. — see `FINAL_REJECTION_REASONS`). Routing
 *     back to typing would be a step too far back; the prescription
 *     itself is correct. Routing back to PV1 would also be wrong —
 *     the pharmacist who PV1-approved already vouched for the
 *     transcription. The work to redo is the fill itself, so the
 *     order lands in the FILL bucket as unassigned (any tech can
 *     pick it up via the standard fill-start flow once that ships).
 *     Same per-org override potential as PV1_REJECTED (a dedicated
 *     `FILL_REWORK` bucket could be seeded), but defaulting to the
 *     existing FILL bucket avoids a schema migration today.
 */
export const BUCKET_CODE_FOR_EXCEPTION_STATE: Partial<Record<OrderExceptionState, string>> = {
  PV1_REJECTED: "TYPING",
  FINAL_VERIFICATION_REJECTED: "FILL",
};

/**
 * Lookup helper. Returns the bucket code for any state that has a
 * mapping (primary or exception), or `null` if no mapping exists.
 *
 * Callers should treat `null` as "use the bucket the order already
 * lives in" rather than overwriting `current_bucket_id` (the
 * CANCELLED / terminal-state default).
 */
export function bucketCodeForStatus(state: string): string | null {
  if (Object.prototype.hasOwnProperty.call(BUCKET_CODE_FOR_STATUS, state)) {
    return BUCKET_CODE_FOR_STATUS[state as OrderPrimaryState];
  }
  if (Object.prototype.hasOwnProperty.call(BUCKET_CODE_FOR_EXCEPTION_STATE, state)) {
    return BUCKET_CODE_FOR_EXCEPTION_STATE[state as OrderExceptionState] ?? null;
  }
  return null;
}
