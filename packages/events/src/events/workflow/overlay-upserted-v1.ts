// workflow.overlay.upserted.v1 — a per-tenant policy overlay was created
// and activated (or rotated), superseding any prior ACTIVE row in the
// same (organizationId, clinicId|null, workflowPolicyId) scope.
//
// Producer: `UpsertWorkflowPolicyOverlay` (`@pharmax/workflow`).
// Consumers:
//   - the process-local overlay cache invalidator on workers that
//     resolve policies for the same tenant (so a sibling worker
//     picks up the new shape on its next cache miss instead of
//     waiting the full 30s TTL);
//   - the SOC 2 admin-change audit feed (every overlay rotation
//     appears in the per-org change log under criterion CC6.3);
//   - the future admin UI's "overlay rotated" live indicator.
//
// PHI invariant: the overlay shape is configuration. Schema is
// `.strict()` and carries org / clinic / policy / overlay-row ids
// only — never patient or order data.
//
// Tightening invariant note: the payload INTENTIONALLY does not
// re-emit the full `overlayJson`. The shape is replayed against
// the live row by consumers that need it (audit feed, cache
// warmer). Embedding the shape inline would invite consumers to
// trust the event over the row, which collides with the
// snapshot-from-the-bus semantic in ADR-0019.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    /** The new ACTIVE overlay row id. */
    overlayId: z.uuid(),
    /**
     * The prior ACTIVE row that was superseded by this upsert; null
     * when this is the first overlay for the (org, clinic|null,
     * workflowPolicyId) scope.
     */
    supersededOverlayId: z.uuid().nullable(),
    /**
     * Optional clinic scope. Null means org-wide overlay (applies
     * to every order in the org); a value means the overlay only
     * applies to orders whose clinic_id matches.
     */
    clinicId: z.uuid().nullable(),
    /**
     * Base workflow policy row id this overlay is bound to. Bound to
     * a specific row (not just code+version) so the grandfather rule
     * from ADR-0017 extends to overlays.
     */
    workflowPolicyId: z.uuid(),
    /**
     * Monotonically-increasing version within the
     * (org, clinic|null, workflowPolicyId) scope. Every rotation
     * increments; cited by audit metadata for replay correlation.
     */
    overlayVersion: z.number().int().min(1),
    /**
     * Transition ids the overlay tightens (forbid + attestation
     * keys combined). Surfaced so the cache invalidator can choose
     * to scope-down its invalidation when the consumer-side
     * `loadPolicy` step starts reading `mergedPolicy` (see ADR-0019
     * implementation notes — that wiring is the follow-up slice).
     */
    affectedTransitionIds: z.array(z.string().min(1)).readonly(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const WorkflowOverlayUpsertedV1 = defineEvent({
  name: "workflow.overlay.upserted",
  version: 1,
  aggregateType: "WorkflowPolicyOverlay",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.overlayId,
  owner: "workflow",
  retention: "7y",
  phiSafe: true,
  routingKey: "workflow.overlay",
  description:
    "Emitted by UpsertWorkflowPolicyOverlay when a per-tenant overlay is created and activated, superseding any prior ACTIVE overlay in the same (org, clinic|null, workflowPolicyId) scope. Drives overlay-cache invalidation on sibling workers and the SOC 2 admin-change audit feed.",
});

export type WorkflowOverlayUpsertedV1Payload = z.infer<typeof payloadSchema>;
