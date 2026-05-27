// defineCommand — declarative factory for tenant workflow commands.
//
// Why this exists:
//
//   The 20-step contract from `.cursor/rules/01-workflow-safety.mdc`
//   is already implemented by `executeCommand`. That orchestrator
//   handles steps 1–8 (validate, RBAC, idempotency, command_log,
//   tx open) and 17–20 (audit, outbox, idempotency-write, post-tx
//   command_log update). What it does NOT do is the inside-the-tx
//   choreography that a tenant workflow command must perform:
//
//     9.  Lock target row (SELECT … FOR UPDATE).
//     10. Resolve workflow policy + version.
//     11. Validate current state.
//     12. Validate prerequisites (SoD, etc.).
//     13. Write structured domain record.
//     14. Update order status + queue + version (CAS).
//     16. Write order_event row (sequence-numbered).
//
//   Every order-targeted command in `@pharmax/orders`,
//   `@pharmax/verification`, `@pharmax/fill`, etc. has to perform
//   the same skeleton. Three options:
//
//     A. Copy-paste the skeleton into every handler. Each new
//        handler is one missed `findFirst` away from a sequence-
//        number collision or a forgotten policy version stamp.
//     B. Provide a base class. Inheritance fights TypeScript's
//        structural typing for the result types and hides where
//        each step actually runs.
//     C. Declarative factory: the command describes WHAT it does
//        (lock this row, load this policy, emit this event), and
//        the factory synthesizes a `Command<TInput, TOutput>`
//        whose `handle` walks the steps in the canonical order.
//
//   This is option C. The output of `defineCommand(...)` is a
//   regular `Command<TInput, TOutput>` — `executeCommand` doesn't
//   care that the handle function was synthesized vs. handwritten.
//   That keeps the existing 20-step contract and its 29 contract
//   tests untouched.
//
// What the factory automates:
//
//   - **Row lock** — `SELECT … FOR UPDATE` on the target aggregate
//     before any other write inside the tx. Locks are scoped to
//     `(id, organizationId)` so tenancy + lock fail together if a
//     cross-org caller somehow got past the RLS GUC.
//   - **Workflow policy load** — fetches the `workflow_policy` row
//     by `(organizationId, code, version)`, asserts `status =
//     ACTIVE`, and exposes the row id + version to the handler so
//     it can stamp them onto the domain record. For "load from
//     target" mode, reads the policy id + version off the locked
//     order row instead.
//   - **SoD check** — delegates to `requireNoSoDViolationForOrder`
//     using the caller-supplied event-type translator.
//   - **Domain exec** — the caller writes the actual rows.
//   - **Version CAS** — if `bumpVersion` is returned, the factory
//     issues a `update where: { id, version: from }` and throws
//     `ConflictError(ORDER_VERSION_MISMATCH)` if the CAS misses.
//   - **order_event writeback** — every emit on a target order is
//     written as both an `event_outbox` row (via the bus) AND an
//     `order_event` row (here, with a monotonic sequence number).
//   - **Saga compensation** — handlers may register `step({do,
//     undo})` calls; on a throw, registered undos fire in LIFO
//     order BEFORE the tx is allowed to roll back. Pure DB
//     mutations don't need compensations (rollback is enough);
//     this exists for steps that escape the tx (label print,
//     external HTTP) which will land in later phases.
//
// What the factory does NOT do:
//
//   - It does not write `audit_log` (that's `executeCommand` →
//     `writeAuditLogInTx` via the audit chain writer).
//   - It does not write `command_log` (same).
//   - It does not enforce that the handler called `step()` for
//     each escape-the-tx side effect. Phase-2 commands are all
//     pure DB; the saga registry is wired up here so Phase-4
//     commands (print, ship) can extend without changing the
//     factory shape.
//
// PHI invariant: the factory itself never reads decrypted PHI.
// Lock SQL selects non-PHI columns only. Policy rows are config.
// The handler's audit metadata + outbox payload is the caller's
// responsibility (the bus runs `redactPayload` on the request/
// response on the way out).

import type { Prisma } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import type { PermissionCode } from "@pharmax/rbac";
import {
  CREATE_READABLE_STATUSES,
  IN_FLIGHT_READABLE_STATUSES,
  type WorkflowPolicyStatusValue,
} from "@pharmax/workflow";
import type { ZodType } from "zod";

import { requireNoSoDViolationForOrder, type EventTypeToPermission } from "./sod.js";
import type {
  AuditEntryDraft,
  Command,
  HandlerDeps,
  HandlerResult,
  OutboxEventDraft,
  PrismaTxClient,
} from "./types.js";

// ===========================================================================
// Public types
// ===========================================================================

/** Tables the factory knows how to row-lock. */
export type LockableTable = "order";

/** Description of how to find the row the factory should lock. */
export interface LockTargetSpec<TInput> {
  readonly table: LockableTable;
  /** Resolves the target id from validated input. */
  readonly by: (input: TInput) => { readonly id: string };
}

/**
 * The columns the factory pulls back from a locked order row.
 *
 * Includes the tenant scope columns (`organizationId`, `clinicId`,
 * `siteId`) because every in-flight order command needs them to
 * resolve site-scoped buckets and stamp scope on outbox payloads.
 * These columns are non-PHI by design — they're organizational
 * identifiers, not patient data — so widening the SELECT list does
 * not change the PHI invariant. The row is already locked, so the
 * extra columns are free (same row, same fetch).
 */
export interface LockedOrderTarget {
  readonly id: string;
  readonly organizationId: string;
  readonly clinicId: string;
  readonly siteId: string;
  /**
   * The bucket the order is currently sitting in. Exposed to the
   * handler so commands that need to know "what queue is this in
   * right now?" (notably `EscalateOrderToEmergencyBucket`, which
   * short-circuits when the order is already in EMERGENCY) can
   * read it off the lock without a second roundtrip.
   *
   * Bucket id is non-PHI by design — it's an organizational
   * queue identifier, not patient data. Same rationale as
   * exposing `siteId` / `clinicId` on this row.
   */
  readonly currentBucketId: string;
  readonly currentStatus: string;
  readonly version: number;
  readonly workflowPolicyId: string;
  readonly workflowPolicyVersion: number;
}

/**
 * How to resolve the workflow policy row for this command.
 *
 *   - `{ from: "target" }` — reads `workflowPolicyId` +
 *     `workflowPolicyVersion` off the locked target. Requires
 *     `lockTarget` to be set on the command.
 *   - `{ code, version }` — hardcoded lookup. Used by `CreateOrder`
 *     where no target exists yet; the factory looks up the policy
 *     row by `(organizationId, code, version)`.
 */
export type LoadPolicySpec =
  | { readonly from: "target" }
  | { readonly code: string; readonly version: number };

/** Resolved policy row exposed to the handler. */
export interface LoadedPolicy {
  readonly id: string;
  readonly code: string;
  readonly version: number;
}

/**
 * Declarative SoD rule. The factory passes `attempted` and the
 * `translate` function to `requireNoSoDViolationForOrder`, which
 * loads the resource history and checks for a violating prior
 * act by the same actor.
 *
 * `against: "target"` means "use the locked target order's id"; it
 * is the only mode supported in Phase 2.
 */
export interface SoDRuleSpec {
  readonly attempted: PermissionCode;
  readonly against: "target";
  readonly translate: EventTypeToPermission;
}

/**
 * Optional optimistic-lock CAS on the locked order's `version`
 * column. The factory issues a `Prisma update` with a `where: {
 * id, version: from }` and asserts the update count is exactly 1.
 * Mismatch → ConflictError(ORDER_VERSION_MISMATCH).
 */
export interface BumpVersionInstruction {
  readonly from: number;
  readonly to: number;
}

/** Single saga step registered by the handler. */
export interface SagaStep {
  /** Stable name for diagnostics; not user-facing. */
  readonly name: string;
  /**
   * Undo callback. Runs in LIFO order on handler throw, BEFORE the
   * tx rollback. For DB-only steps, this is normally a no-op
   * because the rollback handles it.
   */
  readonly undo: () => Promise<void>;
}

/** Saga registry handed to the handler via `deps.saga`. */
export interface SagaRegistry {
  /** Record a compensation step. */
  readonly step: (step: SagaStep) => void;
}

/**
 * Dependencies passed into the `exec` function. A superset of
 * `HandlerDeps` with the factory-resolved `target`, `policy`, and
 * `saga` slots.
 */
export interface DefineCommandExecDeps<TInput> extends HandlerDeps<TInput> {
  /** The locked target row, present iff `lockTarget` is set. */
  readonly target?: LockedOrderTarget;
  /** The resolved policy row, present iff `loadPolicy` is set. */
  readonly policy?: LoadedPolicy;
  /** Saga registry; record compensations here. */
  readonly saga: SagaRegistry;
}

/**
 * Return shape from the `exec` callback. The factory turns this
 * into a `HandlerResult<TOutput>` for the bus AND performs the
 * version CAS / order_event writeback steps.
 */
export interface DefineCommandExecResult<TOutput> {
  readonly output: TOutput;
  /**
   * The audit draft the bus will pass to the chained writer.
   * Same shape as `HandlerResult.audit`.
   */
  readonly audit: AuditEntryDraft;
  /**
   * Emitted events. The factory writes one `event_outbox` row per
   * emit (via the bus) AND, if `targetOrderId` is set, one
   * `order_event` row per emit with a monotonic per-order
   * sequence number.
   */
  readonly emits: ReadonlyArray<OutboxEventDraft>;
  /**
   * The order this command targets. Required for `order_event`
   * writeback. Set for every order-touching command (CreateOrder,
   * ApprovePV1, etc.); omit only for commands that don't operate
   * on an order aggregate.
   */
  readonly targetOrderId?: string;
  /** Optimistic-lock CAS instruction; see `BumpVersionInstruction`. */
  readonly bumpVersion?: BumpVersionInstruction;
}

/** Top-level `defineCommand` input. */
export interface DefineCommandSpec<TInput, TOutput> {
  readonly name: string;
  readonly inputSchema: ZodType<TInput>;
  readonly permission: PermissionCode | null;
  readonly requiresWorkstation?: boolean;
  readonly redactFields?: ReadonlyArray<string>;
  readonly lockTarget?: LockTargetSpec<TInput>;
  readonly loadPolicy?: LoadPolicySpec;
  readonly sodRules?: ReadonlyArray<SoDRuleSpec>;
  readonly exec: (deps: DefineCommandExecDeps<TInput>) => Promise<DefineCommandExecResult<TOutput>>;
}

// ===========================================================================
// Error codes
// ===========================================================================

export const ORDER_VERSION_MISMATCH = "ORDER_VERSION_MISMATCH";
export const ORDER_NOT_FOUND = "ORDER_NOT_FOUND";
export const WORKFLOW_POLICY_NOT_FOUND = "WORKFLOW_POLICY_NOT_FOUND";
export const WORKFLOW_POLICY_INACTIVE = "WORKFLOW_POLICY_INACTIVE";
export const DEFINE_COMMAND_CONFIG_INVALID = "DEFINE_COMMAND_CONFIG_INVALID";

// ===========================================================================
// Factory
// ===========================================================================

/**
 * Compile a declarative command spec into a `Command<TInput,
 * TOutput>` that the bus can dispatch.
 *
 * Step ordering inside the synthesized `handle`:
 *
 *   1. (optional) Lock target row → `SELECT … FOR UPDATE`.
 *   2. (optional) Load workflow policy.
 *   3. (optional) Enforce SoD rules against target's event history.
 *   4. Invoke caller's `exec` with the resolved deps.
 *   5. (optional) CAS bump target's `version`.
 *   6. (optional) Write `order_event` per emit.
 *   7. Return `HandlerResult` to the bus.
 *
 * Saga compensation: if any of steps 4–6 throw AND the handler
 * registered any `saga.step()` calls before the throw, those
 * undos fire in LIFO order before the throw propagates. The bus
 * sees the same error it would have seen from a hand-written
 * handler; the tx still rolls back.
 */
export function defineCommand<TInput, TOutput>(
  spec: DefineCommandSpec<TInput, TOutput>
): Command<TInput, TOutput> {
  validateSpec(spec);

  const handle = async (deps: HandlerDeps<TInput>): Promise<HandlerResult<TOutput>> => {
    const sagaSteps: SagaStep[] = [];
    const saga: SagaRegistry = {
      step: (s) => {
        sagaSteps.push(s);
      },
    };

    try {
      // Step 1 — lock target row.
      const target =
        spec.lockTarget === undefined
          ? undefined
          : await lockOrderRow({
              tx: deps.tx,
              organizationId: deps.ctx.organizationId,
              id: spec.lockTarget.by(deps.input).id,
            });

      // Step 2 — load workflow policy.
      const policy =
        spec.loadPolicy === undefined
          ? undefined
          : await resolvePolicy({
              tx: deps.tx,
              organizationId: deps.ctx.organizationId,
              spec: spec.loadPolicy,
              target,
            });

      // Step 3 — SoD rules.
      if (spec.sodRules !== undefined && spec.sodRules.length > 0) {
        if (target === undefined) {
          // The factory's only SoD mode is "against target"; the
          // validator above asserts that lockTarget is set when
          // sodRules is set. If we land here, the validator missed.
          throw new errors.InternalError({
            code: DEFINE_COMMAND_CONFIG_INVALID,
            message: `Command ${spec.name} declares sodRules without a lockTarget.`,
          });
        }
        for (const rule of spec.sodRules) {
          await requireNoSoDViolationForOrder({
            tx: deps.tx,
            orderId: target.id,
            attempted: rule.attempted,
            translate: rule.translate,
          });
        }
      }

      // Step 4 — caller's exec.
      const execDeps: DefineCommandExecDeps<TInput> = {
        ...deps,
        ...(target === undefined ? {} : { target }),
        ...(policy === undefined ? {} : { policy }),
        saga,
      };
      const result = await spec.exec(execDeps);

      // Step 5 — version CAS.
      if (result.bumpVersion !== undefined) {
        if (target === undefined) {
          throw new errors.InternalError({
            code: DEFINE_COMMAND_CONFIG_INVALID,
            message: `Command ${spec.name} returned bumpVersion without a locked target.`,
          });
        }
        await casBumpOrderVersion({
          tx: deps.tx,
          organizationId: deps.ctx.organizationId,
          id: target.id,
          from: result.bumpVersion.from,
          to: result.bumpVersion.to,
        });
      }

      // Step 6 — order_event writeback.
      if (result.targetOrderId !== undefined && result.emits.length > 0) {
        await writeOrderEventsInTx({
          tx: deps.tx,
          organizationId: deps.ctx.organizationId,
          orderId: result.targetOrderId,
          emits: result.emits,
          actorUserId: deps.ctx.actor.userId,
          commandLogId: deps.commandLogId,
        });
      }

      return {
        output: result.output,
        audit: result.audit,
        outboxEvents: result.emits,
        ...(result.targetOrderId === undefined ? {} : { targetOrderId: result.targetOrderId }),
      };
    } catch (err) {
      // Saga compensation in LIFO order. Compensations are async
      // and may themselves throw; we collect those into a
      // suppressed-error chain on the original error and surface
      // the original error to the bus so the audit story is "this
      // is why the command failed", not "this is why the
      // compensation failed".
      while (sagaSteps.length > 0) {
        const step = sagaSteps.pop()!;
        try {
          await step.undo();
        } catch (undoErr) {
          // Best-effort; do not mask the original error. We log
          // via the deps logger so ops can investigate.
          deps.logger.warn("saga compensation step failed", {
            commandName: spec.name,
            step: step.name,
            err: describe(undoErr),
          });
        }
      }
      throw err;
    }
  };

  return {
    name: spec.name,
    inputSchema: spec.inputSchema,
    permission: spec.permission,
    ...(spec.requiresWorkstation === undefined
      ? {}
      : { requiresWorkstation: spec.requiresWorkstation }),
    ...(spec.redactFields === undefined ? {} : { redactFields: spec.redactFields }),
    handle,
  };
}

// ===========================================================================
// Internals
// ===========================================================================

function validateSpec<TInput, TOutput>(spec: DefineCommandSpec<TInput, TOutput>): void {
  if (spec.sodRules !== undefined && spec.sodRules.length > 0 && spec.lockTarget === undefined) {
    throw new errors.InternalError({
      code: DEFINE_COMMAND_CONFIG_INVALID,
      message: `Command ${spec.name} declares sodRules but no lockTarget. SoD checks require a locked target whose event history is the source of truth.`,
    });
  }
  if (
    spec.loadPolicy !== undefined &&
    "from" in spec.loadPolicy &&
    spec.loadPolicy.from === "target" &&
    spec.lockTarget === undefined
  ) {
    throw new errors.InternalError({
      code: DEFINE_COMMAND_CONFIG_INVALID,
      message: `Command ${spec.name} declares loadPolicy: { from: "target" } but no lockTarget.`,
    });
  }
}

interface LockOrderInput {
  readonly tx: PrismaTxClient;
  readonly organizationId: string;
  readonly id: string;
}

/**
 * `SELECT … FOR UPDATE` the order row inside the tx. The SELECT
 * list is intentionally narrow — non-PHI columns only — so the
 * locked-row read does not surface decrypted patient data into
 * memory or audit logs.
 *
 * The id and organizationId are passed as bound parameters (NOT
 * interpolated into the SQL text) so the query is safe even if a
 * caller somehow constructs an id from untrusted input.
 *
 * Returns `LockedOrderTarget`, or throws `NotFoundError` if no
 * row matches. The org filter belt-and-braces the RLS GUC: even
 * if the GUC were misconfigured, a cross-org id wouldn't return
 * a row.
 */
async function lockOrderRow(input: LockOrderInput): Promise<LockedOrderTarget> {
  // Prisma's typed surface doesn't expose `FOR UPDATE`; we use
  // $queryRaw to issue the lock. Bound parameters via the tagged
  // template means no injection surface.
  const rows = await input.tx.$queryRaw<
    Array<{
      id: string;
      organizationId: string;
      clinicId: string;
      siteId: string;
      currentBucketId: string;
      currentStatus: string;
      version: number;
      workflowPolicyId: string;
      workflowPolicyVersion: number;
    }>
  >`SELECT id, "organizationId", "clinicId", "siteId", "currentBucketId", "currentStatus"::text AS "currentStatus", version, "workflowPolicyId", "workflowPolicyVersion"
    FROM "order"
    WHERE id = ${input.id}::uuid AND "organizationId" = ${input.organizationId}::uuid
    FOR UPDATE`;

  if (rows.length === 0) {
    throw new errors.NotFoundError({
      code: ORDER_NOT_FOUND,
      message: "Order not found for the active tenancy.",
      metadata: { orderId: input.id, organizationId: input.organizationId },
    });
  }
  const row = rows[0]!;
  return {
    id: row.id,
    organizationId: row.organizationId,
    clinicId: row.clinicId,
    siteId: row.siteId,
    currentBucketId: row.currentBucketId,
    currentStatus: row.currentStatus,
    version: row.version,
    workflowPolicyId: row.workflowPolicyId,
    workflowPolicyVersion: row.workflowPolicyVersion,
  };
}

interface ResolvePolicyInput {
  readonly tx: PrismaTxClient;
  readonly organizationId: string;
  readonly spec: LoadPolicySpec;
  readonly target: LockedOrderTarget | undefined;
}

async function resolvePolicy(input: ResolvePolicyInput): Promise<LoadedPolicy> {
  // The `"from" in spec` test is the discriminated-union check; we
  // bind a local so TypeScript narrows it through to the policy
  // lookup below.
  const spec = input.spec;
  if ("from" in spec) {
    if (input.target === undefined) {
      // Already screened in validateSpec; defensive.
      throw new errors.InternalError({
        code: DEFINE_COMMAND_CONFIG_INVALID,
        message: "loadPolicy: { from: 'target' } requires a lockTarget.",
      });
    }
    // The locked target row already carries the policy id +
    // version. We still verify the policy row exists and is
    // readable. The accepted statuses widen to ACTIVE | SUPERSEDED
    // here per the grandfather rule (ADR-0017): an in-flight order
    // that was born under v1 must continue to evaluate against v1
    // even after v1 has been demoted by an activation of v2.
    // DRAFT and ARCHIVED are still rejected; see
    // `assertReadablePolicy` below for the per-mode allowlist.
    const policy = await input.tx.workflowPolicy.findUnique({
      where: { id: input.target.workflowPolicyId },
      select: { id: true, code: true, version: true, status: true },
    });
    return assertReadablePolicy({
      policy,
      acceptedStatuses: IN_FLIGHT_READABLE_STATUSES,
      lookup: {
        organizationId: input.organizationId,
        id: input.target.workflowPolicyId,
        version: input.target.workflowPolicyVersion,
      },
    });
  }

  // Hardcoded code+version lookup — the CREATE-side path. Used by
  // `CreateOrder` (and any future create command that wants to pin
  // a specific version). Only ACTIVE is accepted here: creating a
  // new order against a SUPERSEDED policy would birth an in-flight
  // order whose first command would succeed under the grandfather
  // rule but whose entire lifetime would be governed by a policy
  // operators have already moved past — there is no use case this
  // serves. Mismatch surfaces `WORKFLOW_POLICY_INACTIVE` (the
  // existing error code is preserved so downstream HTTP mappings
  // and dashboards don't have to change).
  const policy = await input.tx.workflowPolicy.findUnique({
    where: {
      organizationId_code_version: {
        organizationId: input.organizationId,
        code: spec.code,
        version: spec.version,
      },
    },
    select: { id: true, code: true, version: true, status: true },
  });
  return assertReadablePolicy({
    policy,
    acceptedStatuses: CREATE_READABLE_STATUSES,
    lookup: {
      organizationId: input.organizationId,
      code: spec.code,
      version: spec.version,
    },
  });
}

/**
 * Workflow-policy admissibility guard.
 *
 *   - `acceptedStatuses` is the per-mode allowlist (sourced from
 *     `@pharmax/workflow`'s `CREATE_READABLE_STATUSES` and
 *     `IN_FLIGHT_READABLE_STATUSES` registries).
 *   - Missing row → `WORKFLOW_POLICY_NOT_FOUND` (NotFoundError).
 *   - Row exists but status not in allowlist →
 *     `WORKFLOW_POLICY_INACTIVE` (ConflictError). Same error code
 *     for both modes — the metadata distinguishes them.
 */
function assertReadablePolicy(input: {
  readonly policy: {
    readonly id: string;
    readonly code: string;
    readonly version: number;
    readonly status: string;
  } | null;
  readonly acceptedStatuses: ReadonlyArray<WorkflowPolicyStatusValue>;
  readonly lookup: Record<string, unknown>;
}): LoadedPolicy {
  if (input.policy === null) {
    throw new errors.NotFoundError({
      code: WORKFLOW_POLICY_NOT_FOUND,
      message: "Workflow policy not found for this organization.",
      metadata: input.lookup,
    });
  }
  if (!(input.acceptedStatuses as ReadonlyArray<string>).includes(input.policy.status)) {
    throw new errors.ConflictError({
      code: WORKFLOW_POLICY_INACTIVE,
      message: `Workflow policy ${input.policy.code} v${input.policy.version} is not readable in this mode (status: ${input.policy.status}; accepted: ${input.acceptedStatuses.join(", ")}).`,
      metadata: {
        ...input.lookup,
        policyId: input.policy.id,
        status: input.policy.status,
        acceptedStatuses: [...input.acceptedStatuses],
      },
    });
  }
  return { id: input.policy.id, code: input.policy.code, version: input.policy.version };
}

interface CasBumpInput {
  readonly tx: PrismaTxClient;
  readonly organizationId: string;
  readonly id: string;
  readonly from: number;
  readonly to: number;
}

async function casBumpOrderVersion(input: CasBumpInput): Promise<void> {
  const result = await input.tx.order.updateMany({
    where: { id: input.id, organizationId: input.organizationId, version: input.from },
    data: { version: input.to },
  });
  if (result.count !== 1) {
    throw new errors.ConflictError({
      code: ORDER_VERSION_MISMATCH,
      message:
        "Order was modified by another command between this command's lock and CAS. Refetch and retry.",
      metadata: {
        orderId: input.id,
        expectedVersion: input.from,
        organizationId: input.organizationId,
      },
    });
  }
}

interface WriteOrderEventsInput {
  readonly tx: PrismaTxClient;
  readonly organizationId: string;
  readonly orderId: string;
  readonly emits: ReadonlyArray<OutboxEventDraft>;
  readonly actorUserId: string;
  readonly commandLogId: string;
}

/**
 * Writes one `order_event` row per emit, with a monotonic
 * per-order sequence number. The first emit for a brand-new order
 * gets seq=1.
 *
 * Sequence numbering is safe here because the factory's row lock
 * (or, for CreateOrder, the unique (orderId, sequenceNumber)
 * constraint plus the same-tx insert) serializes concurrent
 * writers. We read the current max once and assign +1, +2, … in
 * the emit order.
 */
async function writeOrderEventsInTx(input: WriteOrderEventsInput): Promise<void> {
  // Read the current head sequence. For a brand-new order
  // (CreateOrder), this returns null → next seq is 1.
  const head = await input.tx.orderEvent.findFirst({
    where: { orderId: input.orderId },
    orderBy: { sequenceNumber: "desc" },
    select: { sequenceNumber: true },
  });
  let nextSeq = (head?.sequenceNumber ?? 0) + 1;

  for (const emit of input.emits) {
    await input.tx.orderEvent.create({
      data: {
        organizationId: input.organizationId,
        orderId: input.orderId,
        eventType: emit.eventType,
        sequenceNumber: nextSeq,
        actorUserId: input.actorUserId,
        sourceCommandLogId: input.commandLogId,
        payload: emit.payload as Prisma.InputJsonValue,
      },
    });
    nextSeq += 1;
  }
}

function describe(err: unknown): { readonly code: string; readonly message: string } {
  if (errors.isPharmaxError(err)) {
    return { code: err.code, message: err.message };
  }
  if (err instanceof Error) {
    return { code: err.name, message: err.message };
  }
  return { code: "UNCAUGHT", message: String(err) };
}
