// Shared guards for the custom-bucket admin commands.
//
// Lives OUTSIDE `src/commands/` on purpose: `scripts/check-command-files.ts`
// requires every file directly under a package's `commands/` directory to
// export a `Command` / `SystemCommand` / `defineCommand(...)`, and this
// module exports neither.
//
// ---------------------------------------------------------------------
// Why buckets need guards at all
// ---------------------------------------------------------------------
//
// A `bucket` row looks like inert configuration — a code, a label, a sort
// order. It is not. Two subsystems dereference bucket rows by VALUE rather
// than by id, which makes certain edits equivalent to editing routing code:
//
//   1. The workflow engine resolves the next-stage bucket BY CODE on every
//      transition. `@pharmax/workflow`'s `BUCKET_CODE_FOR_STATUS` maps
//      RECEIVED -> "INBOX", TYPING_IN_PROGRESS -> "TYPING", and so on, and
//      ~20 command handlers then run
//      `tx.bucket.findFirst({ where: { organizationId, siteId, code } })`.
//      Repoint a code and orders stop arriving in the queue their stage
//      expects; the handler throws `<STAGE>_BUCKET_NOT_CONFIGURED` and
//      intake halts for the whole org.
//
//   2. The emergency SLA report resolves buckets BY KIND. `@pharmax/reporting`'s
//      `emergency-bucket-counts` report selects
//      `bucket.findMany({ where: { organizationId, kind: EMERGENCY } })`
//      org-wide. Setting `kind: EMERGENCY` on an arbitrary bucket silently
//      injects it into the emergency report; clearing it off the seeded
//      EMERGENCY bucket silently zeroes that report.
//
// Neither subsystem cares about `name` or `sortOrder`. That asymmetry is
// exactly the line these guards draw.

import { BucketKind } from "@pharmax/database";
import { BUCKET_CODE_FOR_EXCEPTION_STATE, BUCKET_CODE_FOR_STATUS } from "@pharmax/workflow";

import { DEFAULT_BUCKET_CODES } from "../commands/provision-default-buckets.js";

/**
 * Bucket codes the platform itself resolves by value, and which an
 * org admin therefore may not claim for a custom bucket.
 *
 * DERIVED, not hand-listed. The set is the union of:
 *
 *   - every code in the workflow status -> bucket map (primary states),
 *   - every code in the exception-state -> bucket map,
 *   - every code in the canonical provisioning set.
 *
 * Deriving it means a future `BUCKET_CODE_FOR_STATUS` entry that
 * introduces a new code becomes reserved automatically, on the same
 * commit that adds it. A hand-maintained copy would drift silently, and
 * the failure mode of that drift is an admin creating `MISSING_INFO`
 * as a custom bucket right before the workflow starts routing into it.
 */
export const RESERVED_BUCKET_CODES: ReadonlySet<string> = new Set<string>([
  ...Object.values(BUCKET_CODE_FOR_STATUS),
  ...Object.values(BUCKET_CODE_FOR_EXCEPTION_STATE).filter(
    (code): code is string => code !== undefined
  ),
  ...DEFAULT_BUCKET_CODES,
]);

/**
 * Bucket kinds an admin may not assign to a custom bucket.
 *
 *   - `EMERGENCY` is read by the emergency-bucket-counts report as the
 *     sole selector (see the header note). Letting an admin mint a
 *     second EMERGENCY-kind bucket corrupts an SLA report that ops
 *     reads as ground truth during a breach.
 *
 *   - `WORKFLOW` asserts "the engine routes orders here on a stage
 *     transition", which is only ever true for the reserved codes. A
 *     WORKFLOW-kind bucket with a custom code is a queue that claims to
 *     be part of the pipeline and never receives an order — an operator
 *     trap, not a data-integrity bug, but a trap worth closing.
 *
 * Custom buckets get `HOLD`, `EXCEPTION`, or `CUSTOM`, which no code
 * path selects on.
 */
export const RESERVED_BUCKET_KINDS: ReadonlySet<BucketKind> = new Set<BucketKind>([
  BucketKind.WORKFLOW,
  BucketKind.EMERGENCY,
]);

/** Kinds an admin may assign to a custom bucket, in display order. */
export const ASSIGNABLE_BUCKET_KINDS: ReadonlyArray<BucketKind> = Object.freeze([
  BucketKind.CUSTOM,
  BucketKind.HOLD,
  BucketKind.EXCEPTION,
]);

/**
 * The ONLY attributes `UpdateBucket` will change on a bucket carrying
 * `isSystem: true`.
 *
 * `name` and `sortOrder` are display-plane: they change what an
 * operator reads and the left-to-right order of the queue rail. No
 * lookup anywhere in the platform selects on either, so an admin
 * relabelling "PV1" to "Pharmacist Check" or floating EMERGENCY to the
 * top of the rail cannot misroute an order.
 *
 * `code` and `kind` are control-plane and stay immutable — see the
 * header note for the two subsystems that dereference them.
 */
export const SYSTEM_BUCKET_MUTABLE_FIELDS: ReadonlyArray<"name" | "sortOrder"> = Object.freeze([
  "name",
  "sortOrder",
]);

/** True when `code` is claimed by the workflow engine or the canonical set. */
export function isReservedBucketCode(code: string): boolean {
  return RESERVED_BUCKET_CODES.has(code);
}

/** True when `kind` is selected on by a platform subsystem. */
export function isReservedBucketKind(kind: BucketKind): boolean {
  return RESERVED_BUCKET_KINDS.has(kind);
}

/**
 * Shape of the `code` column for custom buckets: SCREAMING_SNAKE, 2-64
 * chars, letter-initial. Matches the seeded codes (`INBOX`, `PV1`) so
 * the whole column reads uniformly and so a code is safe to embed in a
 * URL, a saved-view filter, or a scanner macro without escaping.
 */
export const BUCKET_CODE_REGEX = /^[A-Z][A-Z0-9_]{1,63}$/;
