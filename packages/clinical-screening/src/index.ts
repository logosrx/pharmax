// @pharmax/clinical-screening — prospective clinical screening for the
// PV1 pharmacist-verification stage: drug-drug interactions,
// drug-allergy conflicts including cross-sensitivity, therapeutic
// duplication, and dose-range concerns.
//
// Pure and dependency-light by design: no clock, no I/O, no database,
// no Prisma, no network, and no dependency on any other @pharmax
// package. Consumers pass facts in and get a total evaluation back,
// which is what lets a command handler, a UI affordance check and a
// `command_log` replay all call the same function.
//
// NOTE: this package contains NO DRUG DATA and must not acquire any.
// The clinical knowledge is a seam — `DrugKnowledgeSource` — that a
// licensed commercial database satisfies behind a customer-licensed
// adapter. See `knowledge-source.ts` for the clean-room reasoning.
//
// Because it sits below the domain tier and imports nothing, any
// domain package may depend on it freely; it is deliberately absent
// from `DOMAIN_PACKAGES` in `scripts/check-package-layers.ts`.

export {
  dispositionFor,
  fingerprintOf,
  isAtLeastAsSevere,
  leastSevere,
  severityRank,
  suggestedPv1RejectionReason,
  toFhirDetectedIssueSeverity,
  FHIR_DETECTED_ISSUE_SEVERITIES,
  SCREENING_CERTAINTIES,
  SCREENING_DISPOSITIONS,
  SCREENING_FINDING_CODES,
  SCREENING_FINDING_KINDS,
  SCREENING_SEVERITIES,
  SCREENING_TRIGGER_SOURCES,
} from "./findings.js";

export type {
  FhirDetectedIssueSeverity,
  ScreeningCertainty,
  ScreeningDisposition,
  ScreeningFinding,
  ScreeningFindingCode,
  ScreeningFindingKind,
  ScreeningSeverity,
  ScreeningTrigger,
  ScreeningTriggerSource,
  SuggestedPv1RejectionReason,
} from "./findings.js";

export type {
  AllergenCode,
  AllergenKnowledge,
  CrossSensitivityClassCode,
  DoseRange,
  DrugCode,
  DrugKnowledge,
  DrugKnowledgeSource,
  IngredientCode,
  InteractionFact,
  TherapeuticClassCode,
} from "./knowledge-source.js";

export { createInMemoryDrugKnowledgeSource } from "./in-memory-knowledge-source.js";

export type { InMemoryKnowledgeSeed, SeededInteraction } from "./in-memory-knowledge-source.js";

export {
  findingsRequiringAcknowledgement,
  hardStopFindings,
  screenPrescription,
  ALLERGY_CATEGORIES,
  ALLERGY_CRITICALITIES,
  ALLERGY_TYPES,
  ALLERGY_VERIFICATION_STATUSES,
  DEFAULT_SCREENING_POLICY,
  SCREENING_OUTCOMES,
} from "./screening.js";

export type {
  AllergyCategory,
  AllergyCriticality,
  AllergyType,
  AllergyVerificationStatus,
  DoseStatement,
  PrescribedDrug,
  RecordedAllergy,
  ScreeningEvaluation,
  ScreeningOutcome,
  ScreeningPolicy,
  ScreeningRequest,
} from "./screening.js";
