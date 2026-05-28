// Per-domain barrel for workflow.* event definitions.
//
// New workflow events MUST land here so they're picked up by the
// top-level `events/index.ts` barrel + the parity guard.

export { WorkflowOverlayUpsertedV1 } from "./overlay-upserted-v1.js";
