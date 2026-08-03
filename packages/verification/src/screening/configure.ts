// The drug-knowledge seam, resolved by composition.
//
// `@pharmax/clinical-screening` ships the QUESTIONS and none of the
// ANSWERS: `DrugKnowledgeSource` is an interface, and the only
// implementation in this repository is an empty in-memory container.
// That is not a gap to be filled in here. Interaction tables,
// cross-sensitivity groupings and severity gradings published by the
// commercial clinical databases are licensed proprietary content;
// embedding any of it — even "just the severity gradings" — is the
// access-plus-similarity pattern that forfeits a clean-room defence.
// See `.cursor/rules/04-clean-room-policy.mdc` and
// `docs/governance/public-sources-reference.md`.
//
// So the source is injected at boot, exactly like the KMS adapter and
// the carrier factories: a deployment whose customer holds a licence
// wires an adapter over it here, and nothing in this repository ever
// contains the data.
//
// WHY THE DEFAULT IS THE EMPTY SOURCE RATHER THAN A THROW.
//
// The obvious alternative is to fail loudly when nothing is
// configured, as `@pharmax/shipping` does for an unregistered
// carrier. It is the wrong choice here, because the empty source is
// not silent. An unknown drug makes `screenPrescription` return
// `SCR_KNOWLEDGE_UNAVAILABLE` — a MODERATE, DEFINITE
// `SCREENING_GAP` finding whose disposition is
// REQUIRES_ACKNOWLEDGEMENT — so an unconfigured deployment does not
// quietly approve unscreened prescriptions. It tells the pharmacist,
// on every single order, that no screening could be performed, and
// ApprovePV1 will not let the order through until they have recorded
// that they know. "Could not screen" reaching the pharmacist is
// strictly better than PV1 refusing to function; refusing would be
// interpreted as a bug and routed around, and the failure mode of
// routing around it is worse than the failure mode of an honest gap.
//
// What the default must never become is an empty `DrugKnowledge` for
// unknown codes: "I have no record of this drug" and "this drug has
// no ingredients" are different claims, and the second one screens
// clear. The `DrugKnowledgeSource` contract forbids it and the
// in-memory implementation returns `null`.

import {
  createInMemoryDrugKnowledgeSource,
  type DrugKnowledgeSource,
} from "@pharmax/clinical-screening";
import { runtime } from "@pharmax/platform-core";

export interface ClinicalScreeningConfiguration {
  /**
   * The knowledge source every PV1 screen resolves against.
   *
   * MUST be pure and synchronous — the engine is a total function and
   * stays that way so the same call is usable from a command handler,
   * a UI affordance check, and a `command_log` replay. An adapter
   * fronting a network service has to resolve its facts BEFORE the
   * command runs.
   */
  readonly knowledgeSource: DrugKnowledgeSource;
}

// globalThis-backed so boot (the Next instrumentation bundle) and use
// (route bundles) share ONE configuration despite webpack giving each
// bundle its own copy of this module. Same rationale as
// `@pharmax/shipping`'s configuration box.
const box = runtime.globalSingletonBox<ClinicalScreeningConfiguration>(
  "pharmax:verification:clinical-screening:config"
);

/**
 * Module-level so the fallback is one stable instance rather than a
 * fresh object per screen — screening results must not depend on
 * which call built the source.
 */
const EMPTY_KNOWLEDGE_SOURCE: DrugKnowledgeSource = createInMemoryDrugKnowledgeSource();

/**
 * Wire the knowledge source. Call once at boot. Calling again
 * replaces the previous configuration — used by tests via
 * `resetClinicalScreeningConfigurationForTests`.
 */
export function configureClinicalScreening(config: ClinicalScreeningConfiguration): void {
  box.value = Object.freeze({ knowledgeSource: config.knowledgeSource });
}

/**
 * The configured source, or the empty in-memory source when boot did
 * not wire one. See the header for why this does not throw.
 */
export function getClinicalScreeningKnowledgeSource(): DrugKnowledgeSource {
  const configured = box.value;
  if (configured !== null) return configured.knowledgeSource;
  return EMPTY_KNOWLEDGE_SOURCE;
}

/**
 * True when boot wired a source. Exposed so an entry point can log
 * "screening will report a gap on every prescription" once at boot
 * rather than leaving operators to infer it from the finding stream.
 */
export function clinicalScreeningKnowledgeSourceIsConfigured(): boolean {
  return box.value !== null;
}

export function resetClinicalScreeningConfigurationForTests(): void {
  box.value = null;
}
