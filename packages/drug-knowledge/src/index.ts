// @pharmax/drug-knowledge — the drug knowledge sources: the
// RxNorm-backed adapter (ingestion of the NLM's public "Current
// Prescribable Content" subset into versioned global reference tables
// plus the per-screen adapter over them), the compound-formula adapter
// (the org's own coded Master Formulation Records, tenant data), and
// the composite that satisfies `@pharmax/clinical-screening`'s
// `DrugKnowledgeSource` seam from both — national codes from the
// release, compound codes from the formulary.
//
// Sits below the domain tier (like `@pharmax/clinical-screening` and
// `@pharmax/drug-identity`): it may be imported by any domain package
// and imports no domain package itself. It is deliberately absent from
// `DOMAIN_PACKAGES` in `scripts/check-package-layers.ts`.
//
// CLEAN ROOM: everything in here is derived from public NLM
// documentation and the FHIR `MedicationKnowledge`-shaped seam. The
// package holds NOMENCLATURE machinery only — no interaction facts,
// cross-sensitivity groupings, dose ranges or severity gradings exist
// here, and none may be added (see
// docs/governance/public-sources-reference.md).

export {
  loadRxnormKnowledgeSourceForScreen,
  RXNORM_KNOWLEDGE_SOURCE_CODE,
} from "./rxnorm/adapter.js";
export type { LoadRxnormKnowledgeSourceInput } from "./rxnorm/adapter.js";

export { loadDrugKnowledgeSourceForScreen } from "./composite.js";
export type { LoadDrugKnowledgeSourceInput } from "./composite.js";

export { loadCompoundFormulaDeclarationsForScreen } from "./compound/adapter.js";
export type {
  CompoundFormulaDeclarations,
  LoadCompoundFormulaKnowledgeInput,
} from "./compound/adapter.js";

export { ingestRxnormRelease, RxnormIngestError, RXNORM_INGEST_ERRORS } from "./rxnorm/ingest.js";
export type {
  IngestAction,
  IngestRxnormReleaseInput,
  IngestRxnormReleaseSummary,
} from "./rxnorm/ingest.js";

export {
  RxnormReleaseModelBuilder,
  RXNORM_INGREDIENT_TTYS,
  RXNORM_PRODUCT_TTYS,
} from "./rxnorm/rrf.js";
export type { RxnormIngredient, RxnormReleaseModel } from "./rxnorm/rrf.js";

export { parseRxnormVersion, rxnormVersionFromArchiveName } from "./rxnorm/version.js";
export type { ParsedRxnormVersion } from "./rxnorm/version.js";

export { assessRxnormStaleness, RXNORM_STALENESS_THRESHOLD_DAYS } from "./rxnorm/staleness.js";
export type { StalenessAssessment } from "./rxnorm/staleness.js";
