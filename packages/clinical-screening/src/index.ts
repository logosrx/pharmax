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
// A caller does not get to screen a subset of the axes by accident:
// `ScreeningRequest.inputAvailability` is required and exhaustive
// over `CLINICAL_SCREENING_AXES`, and any axis declared UNAVAILABLE
// comes back as a `SCREENING_GAP` the pharmacist has to acknowledge.
// An axis that contributes nothing in silence is not expressible.
//
// Because it sits below the domain tier and imports nothing, any
// domain package may depend on it freely; it is deliberately absent
// from `DOMAIN_PACKAGES` in `scripts/check-package-layers.ts`.

export {
  dispositionFor,
  fingerprintOf,
  gapRemediationForAvailability,
  gapRemediationForFindingCode,
  gapRemediationFromSeverity,
  isAtLeastAsSevere,
  leastSevere,
  screeningGapSeverity,
  severityRank,
  suggestedPv1RejectionReason,
  toFhirDetectedIssueSeverity,
  CLINICAL_SCREENING_AXES,
  FHIR_DETECTED_ISSUE_SEVERITIES,
  INPUT_UNAVAILABLE_CODE_FOR_AXIS,
  SUGGESTED_PV1_REJECTION_REASONS,
  SCREENING_CERTAINTIES,
  SCREENING_DISPOSITIONS,
  SCREENING_FINDING_CODES,
  SCREENING_FINDING_KINDS,
  SCREENING_GAP_REMEDIATIONS,
  SCREENING_INPUT_AVAILABILITIES,
  SCREENING_SEVERITIES,
  SCREENING_TRIGGER_SOURCES,
} from "./findings.js";

export type {
  FhirDetectedIssueSeverity,
  FingerprintInput,
  ScreeningCertainty,
  ScreeningDisposition,
  ScreeningFinding,
  ScreeningFindingCode,
  ScreeningFindingKind,
  ScreeningGapRemediation,
  ScreeningInputAvailability,
  ScreeningInputAxis,
  ScreeningSeverity,
  ScreeningTrigger,
  ScreeningTriggerSource,
  SuggestedPv1RejectionReason,
} from "./findings.js";

export {
  gapRemediationForCoverage,
  DRUG_CODE_SCOPES,
  DRUG_KNOWLEDGE_COVERAGES,
} from "./knowledge-source.js";

export type {
  AllergenCode,
  AllergenKnowledge,
  CompoundFormulaProvenance,
  CrossSensitivityClassCode,
  DoseRange,
  DrugCode,
  DrugCodeScope,
  DrugKnowledge,
  DrugKnowledgeCoverage,
  DrugKnowledgeRelease,
  DrugKnowledgeSource,
  IngredientCode,
  InteractionFact,
  TherapeuticClassCode,
} from "./knowledge-source.js";

export { createInMemoryDrugKnowledgeSource } from "./in-memory-knowledge-source.js";

export type { InMemoryKnowledgeSeed, SeededInteraction } from "./in-memory-knowledge-source.js";

export {
  isComparableSubstanceCodeSystem,
  isScreenableAllergy,
  isScreenableAllergyCategory,
  isScreenableAllergyClinicalStatus,
  isScreenableAllergyVerificationStatus,
  ALLERGY_CATEGORIES,
  ALLERGY_CLINICAL_STATUSES,
  ALLERGY_CRITICALITIES,
  ALLERGY_SUBSTANCE_CODE_SYSTEMS,
  ALLERGY_TYPES,
  ALLERGY_VERIFICATION_STATUSES,
} from "./allergy.js";

export type {
  AllergyCategory,
  AllergyClinicalStatus,
  AllergyCriticality,
  AllergyScreenability,
  AllergySubstanceCodeSystem,
  AllergyType,
  AllergyVerificationStatus,
} from "./allergy.js";

export {
  findingsRequiringAcknowledgement,
  hardStopFindings,
  screenPrescription,
  DEFAULT_SCREENING_POLICY,
  DOSE_STATEMENT_BASES,
  SCREENING_OUTCOMES,
} from "./screening.js";

export type {
  DoseStatement,
  DoseStatementBasis,
  PrescribedDrug,
  RecordedAllergy,
  ScreeningEvaluation,
  ScreeningOutcome,
  ScreeningPolicy,
  ScreeningRequest,
} from "./screening.js";
