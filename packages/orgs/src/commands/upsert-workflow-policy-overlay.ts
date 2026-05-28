// UpsertWorkflowPolicyOverlay — admin command for the Tier-2
// per-tenant workflow policy overlay surface (see ADR-0019).
//
// Semantics:
//
//   Each (organizationId, clinicId|null, workflowPolicyId) scope
//   holds AT MOST ONE ACTIVE overlay at a time. Calling this command
//   for a scope:
//
//     1. Validates the input overlay shape at the Zod boundary
//        (.strict() rejects unknown keys).
//     2. Resolves the base policy row by id and asserts it is
//        readable (ACTIVE or SUPERSEDED — grandfather rule from
//        ADR-0017 lets overlays bind to SUPERSEDED bases for
//        in-flight orders).
//     3. Re-runs `mergePolicyWithOverlay` against the live base shape
//        as a write-time safety check. The merge function rejects
//        any overlay that would LOOSEN base, raising
//        ValidationError(OVERLAY_LOOSENS_BASE_POLICY). Doing the
//        merge here AND at every command dispatch is intentional:
//        the dispatch-time merge is the load-bearing safety, but
//        a write-time merge surfaces the failure to the admin
//        immediately instead of failing the first downstream
//        command.
//     4. Atomically:
//          a. Demotes any prior ACTIVE row in the same scope to
//             SUPERSEDED.
//          b. INSERTs the new ACTIVE row at
//             `version = (prior?.version ?? 0) + 1`.
//        The partial-unique index `workflow_policy_overlay_active_unique`
//        is the structural guarantee — a concurrent racer that
//        beats us to the swap surfaces as P2002 →
//        OVERLAY_ACTIVE_RACE so the UI can refresh.
//     5. Emits `workflow.overlay.upserted.v1` with the supersede
//        chain + affected transitions so sibling workers can
//        invalidate their overlay cache and the SOC-2 admin-change
//        feed picks it up.
//
// Why supersedure (vs. UPDATE-in-place):
//
//   Audit history. Every overlay rotation is replayable: an
//   incident reviewer can answer "which overlay shaped this
//   command on 2026-03-15?" by joining `command_log.overlayBindings`
//   against the historical `workflow_policy_overlay` rows. Mutating
//   in place destroys that lineage. ADR-0017 (workflow policy
//   lifecycle) takes the same stance for base policies; overlays
//   inherit by symmetry.
//
// Why a single command (vs. draft → activate two-step):
//
//   Operator UX. The two-step model exists in
//   `validateActivateOverlay` for a future admin UI that wants to
//   stage rotations before flipping them live. Today we ship the
//   single-step path because it matches the operator's mental
//   model ("I want this rule in effect now") and keeps the write
//   surface small. The two-step pair lands as `CreateOverlayDraft`
//   + `ActivateOverlay` when the admin UI needs them.
//
// Permission: `workflow.overlay.manage` (ORGANIZATION scope;
// OrgAdmin only by default — see role-templates.ts).
//
// PHI invariant: overlays are configuration. The input zod schema
// is `.strict()` so an operator cannot land patient identifiers in
// `overlayJson`. The outbox payload carries ids and the
// affected-transition list only — never the merged policy shape
// itself.

import type { Command, HandlerResult, PrismaTxClient } from "@pharmax/command-bus";
import { Prisma, WorkflowPolicyOverlayStatus } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import {
  ORDER_STANDARD_V1,
  isOrderState,
  isOrderWorkflowCommand,
  mergePolicyWithOverlay,
  type OrderState,
  type OrderWorkflowCommand,
  type OrderWorkflowPolicy,
  type WorkflowPolicyOverlay,
} from "@pharmax/workflow";
import { randomUUID } from "node:crypto";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export const UPSERT_OVERLAY_BASE_POLICY_NOT_FOUND = "UPSERT_OVERLAY_BASE_POLICY_NOT_FOUND";
export const UPSERT_OVERLAY_BASE_POLICY_NOT_READABLE = "UPSERT_OVERLAY_BASE_POLICY_NOT_READABLE";
export const UPSERT_OVERLAY_BASE_POLICY_UNSUPPORTED = "UPSERT_OVERLAY_BASE_POLICY_UNSUPPORTED";
export const UPSERT_OVERLAY_CLINIC_NOT_FOUND = "UPSERT_OVERLAY_CLINIC_NOT_FOUND";
export const UPSERT_OVERLAY_ACTIVE_RACE = "UPSERT_OVERLAY_ACTIVE_RACE";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------
//
// The overlay subshape is the ZOD mirror of the
// `WorkflowPolicyOverlay` interface from `@pharmax/workflow`. The
// `.strict()` calls on every object reject unknown keys so a future
// client that adds a typoed field (or PHI) lands a 400 instead of
// silently storing junk in `overlayJson`.
//
// We re-validate the structure at the write boundary even though
// `mergePolicyWithOverlay` will reject incompatible overlays — the
// Zod schema catches shape errors with field-level paths the API
// can show to the admin, while the merge throws a single
// `OVERLAY_LOOSENS_BASE_POLICY` for the whole document.

const attestationRequirementSchema = z
  .object({
    id: z.string().min(1).max(120),
    minSignatures: z.number().int().min(1).max(10),
    permission: z.string().min(1).max(120),
    description: z.string().max(500).optional(),
  })
  .strict();

// Zod 4 note: `z.record(enumSchema, ...)` requires every enum value as
// a key (total record). We model the partial-keyed map by validating
// keys + values structurally with `z.record(z.string(), ...)` and a
// `.superRefine` that checks each key against the OrderWorkflowCommand
// vocabulary and each value against the OrderState vocabulary. Doing
// it in a single refine keeps every error path scoped to its specific
// field for the admin UI.
const overlayShapeSchema = z
  .object({
    forbidTransitionsFromStates: z
      .record(z.string().min(1), z.array(z.string().min(1)).min(1))
      .optional(),
    addRequiredAttestations: z
      .record(z.string().min(1), z.array(attestationRequirementSchema).min(1))
      .optional(),
  })
  .strict()
  .superRefine((overlay, ctx) => {
    if (overlay.forbidTransitionsFromStates !== undefined) {
      for (const command of Object.keys(overlay.forbidTransitionsFromStates)) {
        if (!isOrderWorkflowCommand(command)) {
          ctx.addIssue({
            code: "custom",
            message: `Unknown order workflow command: ${command}`,
            path: ["forbidTransitionsFromStates", command],
          });
          continue;
        }
        const states = overlay.forbidTransitionsFromStates[command] ?? [];
        for (const state of states) {
          if (!isOrderState(state)) {
            ctx.addIssue({
              code: "custom",
              message: `Unknown order state: ${state}`,
              path: ["forbidTransitionsFromStates", command],
            });
          }
        }
      }
    }
    const forbidEmpty =
      overlay.forbidTransitionsFromStates === undefined ||
      Object.keys(overlay.forbidTransitionsFromStates).length === 0;
    const attestationsEmpty =
      overlay.addRequiredAttestations === undefined ||
      Object.keys(overlay.addRequiredAttestations).length === 0;
    if (forbidEmpty && attestationsEmpty) {
      ctx.addIssue({
        code: "custom",
        message:
          "Overlay must declare at least one of `forbidTransitionsFromStates` or `addRequiredAttestations`. An empty overlay is a no-op; do not persist one.",
        path: [],
      });
    }
  });

const inputSchema = z
  .object({
    /** Base workflow_policy row id. */
    workflowPolicyId: z.uuid(),
    /** Null ⇒ overlay applies org-wide. Non-null ⇒ clinic-scoped. */
    clinicId: z.uuid().nullable().default(null),
    /** The declarative overlay shape (tighten-only). */
    overlay: overlayShapeSchema,
  })
  .strict();

export type UpsertWorkflowPolicyOverlayInput = z.infer<typeof inputSchema>;

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface UpsertWorkflowPolicyOverlayOutput {
  readonly overlayId: string;
  readonly supersededOverlayId: string | null;
  readonly clinicId: string | null;
  readonly workflowPolicyId: string;
  readonly overlayVersion: number;
  readonly affectedTransitionIds: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reconstruct the live base `OrderWorkflowPolicy` object from a
 * persisted `workflow_policy` row. Today the only policy in the
 * registry is `order.standard v1`; a future v2 lands as a separate
 * exported object from `@pharmax/workflow` and gets added to the
 * dispatch table here. Failing closed on an unknown policy is
 * deliberate — we cannot validate an overlay against a shape we
 * do not know.
 */
function resolveBasePolicyShape(row: { code: string; version: number }): OrderWorkflowPolicy {
  if (row.code === "order.standard" && row.version === 1) {
    return ORDER_STANDARD_V1;
  }
  throw new errors.InternalError({
    code: UPSERT_OVERLAY_BASE_POLICY_UNSUPPORTED,
    message:
      `UpsertWorkflowPolicyOverlay does not yet support policy ${row.code} v${row.version}. ` +
      `Register the policy shape in @pharmax/workflow and extend resolveBasePolicyShape() before authoring overlays for it.`,
    metadata: { policyCode: row.code, policyVersion: row.version },
  });
}

/**
 * Compute the transition ids the overlay touches, for the outbox
 * payload + audit metadata. Combines forbid keys (mapped through
 * base) and attestation keys.
 */
function computeAffectedTransitionIds(
  base: OrderWorkflowPolicy,
  overlay: WorkflowPolicyOverlay
): ReadonlyArray<string> {
  const ids = new Set<string>();
  if (overlay.forbidTransitionsFromStates !== undefined) {
    const pairToId = new Map<string, string>();
    for (const t of base.transitions) {
      pairToId.set(`${t.command}|${t.fromState}`, t.transitionId);
    }
    for (const command of Object.keys(overlay.forbidTransitionsFromStates)) {
      const states = overlay.forbidTransitionsFromStates[command as OrderWorkflowCommand];
      if (states === undefined) continue;
      for (const state of states) {
        const id = pairToId.get(`${command}|${state}`);
        if (id !== undefined) ids.add(id);
      }
    }
  }
  if (overlay.addRequiredAttestations !== undefined) {
    for (const id of Object.keys(overlay.addRequiredAttestations)) {
      ids.add(id);
    }
  }
  // Stable order so the audit row + outbox row + test snapshots
  // are deterministic across runs.
  return [...ids].sort();
}

async function validateClinicScope(
  tx: PrismaTxClient,
  args: { organizationId: string; clinicId: string | null }
): Promise<void> {
  if (args.clinicId === null) return;
  const clinic = await tx.clinic.findUnique({
    where: { id: args.clinicId },
    select: { id: true, organizationId: true },
  });
  if (clinic === null || clinic.organizationId !== args.organizationId) {
    throw new errors.NotFoundError({
      code: UPSERT_OVERLAY_CLINIC_NOT_FOUND,
      message: "Clinic not found in this organization.",
      metadata: { clinicId: args.clinicId },
    });
  }
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const UpsertWorkflowPolicyOverlay: Command<
  UpsertWorkflowPolicyOverlayInput,
  UpsertWorkflowPolicyOverlayOutput
> = {
  name: "UpsertWorkflowPolicyOverlay",
  inputSchema,
  permission: PERMISSIONS.WORKFLOW_OVERLAY_MANAGE,
  redactFields: [],

  async handle({
    input,
    ctx,
    tx,
    clock,
    commandLogId,
  }): Promise<HandlerResult<UpsertWorkflowPolicyOverlayOutput>> {
    // ---- 1. Resolve base policy row ----
    // RLS scopes by organizationId; we re-filter on org defensively
    // (same belt-and-braces pattern as lockOrderRow in
    // @pharmax/command-bus).
    const basePolicy = await tx.workflowPolicy.findFirst({
      where: { id: input.workflowPolicyId, organizationId: ctx.organizationId },
      select: { id: true, code: true, version: true, status: true },
    });
    if (basePolicy === null) {
      throw new errors.NotFoundError({
        code: UPSERT_OVERLAY_BASE_POLICY_NOT_FOUND,
        message: "Workflow policy not found in this organization.",
        metadata: { workflowPolicyId: input.workflowPolicyId },
      });
    }
    // Overlays can bind to ACTIVE or SUPERSEDED bases (the
    // grandfather rule for in-flight orders). DRAFT and ARCHIVED
    // are not eligible — DRAFT policies have not committed to a
    // shape yet, and ARCHIVED policies should not accept new
    // overlays (they belong to historical replays only).
    if (basePolicy.status !== "ACTIVE" && basePolicy.status !== "SUPERSEDED") {
      throw new errors.ConflictError({
        code: UPSERT_OVERLAY_BASE_POLICY_NOT_READABLE,
        message: `Workflow policy ${basePolicy.code} v${basePolicy.version} is ${basePolicy.status}; overlays can only bind to ACTIVE or SUPERSEDED bases.`,
        metadata: {
          workflowPolicyId: basePolicy.id,
          policyCode: basePolicy.code,
          policyVersion: basePolicy.version,
          policyStatus: basePolicy.status,
        },
      });
    }

    // ---- 2. Validate clinic scope (if any) ----
    await validateClinicScope(tx, {
      organizationId: ctx.organizationId,
      clinicId: input.clinicId,
    });

    // ---- 3. Re-run the tighten-only merge against the live base ----
    // The Zod parse already accepted the shape; this is the
    // semantic check. Throws ValidationError(OVERLAY_LOOSENS_BASE_POLICY)
    // if the overlay would widen base or references an unknown
    // transition. The bus's outer error mapper surfaces it as a
    // 400-class failure to the API caller.
    const baseShape = resolveBasePolicyShape(basePolicy);
    mergePolicyWithOverlay(baseShape, input.overlay as WorkflowPolicyOverlay);

    // ---- 4. Find + supersede the prior ACTIVE row in this scope ----
    // The findFirst is a SELECT against the partial-unique
    // (org, COALESCE(clinic, sentinel), policy) WHERE status =
    // ACTIVE — at most one row by construction.
    const prior = await tx.workflowPolicyOverlay.findFirst({
      where: {
        organizationId: ctx.organizationId,
        clinicId: input.clinicId,
        workflowPolicyId: basePolicy.id,
        status: WorkflowPolicyOverlayStatus.ACTIVE,
      },
      select: { id: true, version: true },
    });
    if (prior !== null) {
      await tx.workflowPolicyOverlay.update({
        where: { id: prior.id },
        data: { status: WorkflowPolicyOverlayStatus.SUPERSEDED },
      });
    }

    // ---- 5. Insert the new ACTIVE row ----
    // overlayJson is the raw declarative shape; the Zod parse + the
    // merge step are the load-bearing validators. Reading the JSON
    // back is a structural cast (the resolver parses it with the
    // same Zod schema on the read side).
    const overlayId = randomUUID();
    const overlayVersion = (prior?.version ?? 0) + 1;
    try {
      await tx.workflowPolicyOverlay.create({
        data: {
          id: overlayId,
          organizationId: ctx.organizationId,
          clinicId: input.clinicId,
          workflowPolicyId: basePolicy.id,
          overlayJson: input.overlay as unknown as Prisma.InputJsonValue,
          status: WorkflowPolicyOverlayStatus.ACTIVE,
          version: overlayVersion,
          createdByUserId: ctx.actor.userId,
        },
      });
    } catch (cause) {
      if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === "P2002") {
        throw new errors.ConflictError({
          code: UPSERT_OVERLAY_ACTIVE_RACE,
          message:
            "A concurrent UpsertWorkflowPolicyOverlay already activated an overlay for this scope. Refresh and retry.",
          metadata: {
            organizationId: ctx.organizationId,
            clinicId: input.clinicId,
            workflowPolicyId: basePolicy.id,
          },
        });
      }
      throw cause;
    }

    const affectedTransitionIds = computeAffectedTransitionIds(
      baseShape,
      input.overlay as WorkflowPolicyOverlay
    );
    const occurredAt = clock.now().toISOString();

    return {
      output: {
        overlayId,
        supersededOverlayId: prior?.id ?? null,
        clinicId: input.clinicId,
        workflowPolicyId: basePolicy.id,
        overlayVersion,
        affectedTransitionIds,
      },
      audit: {
        action: "workflow.overlay.upserted",
        resourceType: "WorkflowPolicyOverlay",
        resourceId: overlayId,
        metadata: {
          organizationId: ctx.organizationId,
          overlayId,
          supersededOverlayId: prior?.id ?? null,
          clinicId: input.clinicId,
          workflowPolicyId: basePolicy.id,
          policyCode: basePolicy.code,
          policyVersion: basePolicy.version,
          overlayVersion,
          affectedTransitionIds,
          commandLogId,
          occurredAt,
        },
      },
      outboxEvents: [
        {
          eventType: "workflow.overlay.upserted.v1",
          aggregateType: "WorkflowPolicyOverlay",
          aggregateId: overlayId,
          payload: {
            organizationId: ctx.organizationId,
            overlayId,
            supersededOverlayId: prior?.id ?? null,
            clinicId: input.clinicId,
            workflowPolicyId: basePolicy.id,
            overlayVersion,
            affectedTransitionIds,
            occurredAt,
          },
        },
      ],
    };
  },
};

// Re-export the OrderState helper so callers can type the
// forbid map keys without re-importing from @pharmax/workflow.
export type { OrderState };
