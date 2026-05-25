// Empty shim used by `vitest.config.ts` to satisfy Next.js's
// `server-only` and `client-only` guard imports during unit tests.
//
// These packages have no runtime exports — they exist solely so Next
// can throw a build-time error if `server-only` is reached from a
// Client Component (or vice versa). In Vitest there is no Next
// compiler, so we just want the import to resolve cleanly.

export {};
