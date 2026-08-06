// @pharmax/drug-identity — how a drug is named and matched.
//
// Pure and dependency-free by design: no clock, no I/O, no database,
// no Prisma. Callers pass strings in and get strings back.
//
// This package exists because NDC normalization is needed by packages
// that must not depend on each other. `@pharmax/scan` normalizes the
// NDC a barcode produced at fill time; `@pharmax/orders` normalizes
// the NDC a technician transcribed. Those two strings have to be
// comparable, which means both sides must run the SAME normalizer —
// and a domain package reaching into a sibling domain to get it is
// exactly the coupling `scripts/check-package-layers.ts` forbids.
//
// Future residents: RxNorm and GPI mapping, display formatting of an
// 11-digit NDC back into its 5-4-2 hyphenated form.

export { normalizeNdc, NDC_INVALID } from "./normalize-ndc.js";
