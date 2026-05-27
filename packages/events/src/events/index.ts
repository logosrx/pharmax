// Top-level barrel for every domain's event definitions.
//
// Consumers should prefer importing FROM the public package
// surface (`@pharmax/events`), but this barrel exists so
// per-domain integrations (e.g. an internal BI ingestion service)
// can opt into the per-domain shape rather than the flat
// re-export catalog on `@pharmax/events`.
//
// Adding a new domain:
//   1. Create `events/<domain>/<event-name>-v1.ts`.
//   2. Create `events/<domain>/index.ts` re-exporting it.
//   3. Add the line below.
//   4. Add the import + entry in `../registry.ts`'s
//      `ALL_DEFINITIONS`.
//   5. Re-export the symbol from `../index.ts`'s public barrel.
//
// The parity-guard test fails if any new event name appears in
// source without a corresponding registry entry — so missing
// step (4) above is caught in CI.

export * from "./billing/index.js";
export * from "./fill/index.js";
export * from "./labels/index.js";
export * from "./order/index.js";
export * from "./org/index.js";
export * from "./organization/index.js";
export * from "./patient/index.js";
export * from "./provider/index.js";
export * from "./shipment/index.js";
export * from "./shipping/index.js";
