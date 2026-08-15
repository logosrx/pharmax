// "Does a routing override point at this bucket?" — the shared read
// behind the delete and rename refusals in the bucket admin commands.
//
// Lives OUTSIDE `src/commands/` for the same reason `bucket-guards.ts`
// does: `scripts/check-command-files.ts` requires every file directly
// under a package's `commands/` directory to export a Command, and
// this module exports plain functions.
//
// ---------------------------------------------------------------------
// The interaction this module exists to close
// ---------------------------------------------------------------------
//
// `DeleteBucket` already refuses while any ORDER references the bucket,
// and `Order.currentBucketId` is a non-nullable FK with
// `onDelete: Restrict`, so the database backs that refusal up.
//
// A routing override is NOT an order reference and has no FK. It is a
// bucket CODE inside `workflow_policy_overlay.overlayJson`, a `Json`
// column. Nothing in the database connects the two. So an admin could
// delete the empty `TYPING_REWORK` bucket — zero orders in it, the
// refusal does not fire — while an ACTIVE overlay still routes
// `PV1_REJECTED` there. Nothing would fail loudly; PV1 rejections would
// simply stop arriving in the rework queue and start piling back into
// the shared typing queue, and the first person to notice would be
// whoever eventually asks why the rework queue has been empty for a
// week.
//
// Two layers close it, and both are wanted:
//
//   1. THIS module, used by `DeleteBucket` and by `UpdateBucket`'s
//      rename path, to REFUSE the edit while a route depends on the
//      code. That is the primary guard, and it matches the philosophy
//      already in `DeleteBucket`: "move the orders out first" is a
//      sentence an operator can act on, and so is "re-point the route
//      first". Refusing also keeps the overlay's audit lineage intact
//      — the alternative, silently rewriting `overlayJson` to follow a
//      rename, would mutate a row whose whole design is
//      supersede-never-mutate.
//
//   2. The canonical fallback inside `resolveStageBucketRoute`
//      (`@pharmax/workflow`), which sends the stage to its platform
//      default if the override's target cannot be resolved at runtime.
//      That is the safety net for everything this refusal cannot see:
//      a DBA deleting a row directly, a restore from an older dump, a
//      race between this check and a concurrent delete. Orders keep
//      flowing to the canonical bucket instead of failing.
//
// Layer 1 without layer 2 would turn a stale route into halted intake.
// Layer 2 without layer 1 would make a deliberate routing decision
// evaporate in silence. Both, and the failure is loud at config time
// and harmless at run time.
//
// PHI: none. Overlay rows are configuration; this module reads bucket
// codes, overlay ids, and clinic ids only.

import type { PrismaTxClient } from "@pharmax/command-bus";
import { WorkflowPolicyOverlayStatus } from "@pharmax/database";
import {
  ROUTABLE_ORDER_STATES,
  statesRoutedTo,
  type StageBucketRouteTable,
} from "@pharmax/workflow";

/**
 * One ACTIVE overlay that routes at least one stage to the code we
 * asked about, plus which stages those are.
 *
 * `states` is what makes the refusal actionable: "referenced by an
 * overlay" tells an admin nothing, "PV1_REJECTED routes here" tells
 * them exactly which route to re-point.
 */
export interface OverlayRouteReference {
  readonly overlayId: string;
  /** Null for an org-wide overlay; set for a clinic-scoped one. */
  readonly clinicId: string | null;
  /** Workflow states this overlay routes to the queried code. */
  readonly states: ReadonlyArray<string>;
}

/**
 * Pull the route table out of a raw `overlayJson` value.
 *
 * Defensive by design. The argument is whatever the `Json` column
 * holds, which is not guaranteed to match today's overlay shape: a row
 * written by an older build predates this key entirely, and a row
 * hand-patched during an incident can hold anything. Every unexpected
 * shape yields `undefined` (read as "this overlay declares no
 * routes") rather than throwing, because an unparseable overlay row
 * must not be able to break the bucket admin screen.
 *
 * Note the asymmetry with the WRITE path, which is strict: the Zod
 * schema in `UpsertWorkflowPolicyOverlay` rejects unknown keys and
 * unknown states outright. Strict on write, tolerant on read, is the
 * right way round — it keeps junk out of the column while keeping the
 * readers that must tolerate history from becoming a denial of
 * service.
 */
export function readOverlayRouteTable(overlayJson: unknown): StageBucketRouteTable | undefined {
  if (typeof overlayJson !== "object" || overlayJson === null || Array.isArray(overlayJson)) {
    return undefined;
  }
  const routes = (overlayJson as Record<string, unknown>)["routeStatesToBucketCodes"];
  if (typeof routes !== "object" || routes === null || Array.isArray(routes)) {
    return undefined;
  }
  return routes as StageBucketRouteTable;
}

/**
 * Every ACTIVE overlay in the organization that routes a stage to
 * `code`, with the offending stages named.
 *
 * Only ACTIVE rows are considered. SUPERSEDED rows are history — they
 * are exactly what makes a historical replay resolvable, and a
 * superseded route must never be able to block an admin from deleting
 * a bucket it once pointed at. Were superseded rows counted, the first
 * routing override an organization ever authored would pin its target
 * bucket in place permanently.
 *
 * Org-scoped explicitly. RLS already scopes the read; the redundant
 * predicate is the same belt-and-braces pattern the overlay upsert
 * command uses on `workflowPolicy`.
 *
 * Returns an empty array when nothing references the code. Results are
 * ordered by overlay id for deterministic error metadata.
 */
export async function findActiveOverlaysRoutingToCode(
  tx: PrismaTxClient,
  args: { readonly organizationId: string; readonly code: string }
): Promise<ReadonlyArray<OverlayRouteReference>> {
  const overlays = await tx.workflowPolicyOverlay.findMany({
    where: {
      organizationId: args.organizationId,
      status: WorkflowPolicyOverlayStatus.ACTIVE,
    },
    select: { id: true, clinicId: true, overlayJson: true },
  });

  const references: OverlayRouteReference[] = [];
  for (const overlay of overlays) {
    const states = statesRoutedTo(readOverlayRouteTable(overlay.overlayJson), args.code);
    if (states.length === 0) continue;
    references.push({
      overlayId: overlay.id,
      clinicId: overlay.clinicId,
      states: [...states],
    });
  }
  references.sort((a, b) => a.overlayId.localeCompare(b.overlayId));
  return references;
}

/**
 * Flatten route references into a deduplicated list of stage names for
 * the human-readable half of a refusal message.
 *
 * Ordered by lifecycle, matching `statesRoutedTo`, so a message listing
 * several stages reads down the workflow rather than alphabetically.
 */
export function referencedStateNames(
  references: ReadonlyArray<OverlayRouteReference>
): ReadonlyArray<string> {
  const states = new Set<string>();
  for (const reference of references) {
    for (const state of reference.states) states.add(state);
  }
  return ROUTABLE_ORDER_STATES.filter((state) => states.has(state));
}
