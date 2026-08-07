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
// `SCR_KNOWLEDGE_UNAVAILABLE`, a `SCREENING_GAP` finding persisted on
// every order — so an unconfigured deployment does not quietly approve
// unscreened prescriptions, and its `order_screening_finding` rows say
// on their face that no screening could be performed. "Could not
// screen" reaching the record is strictly better than PV1 refusing to
// function; refusing would be interpreted as a bug and routed around,
// and the failure mode of routing around it is worse than the failure
// mode of an honest gap.
//
// WHAT THE EMPTY SOURCE DOES NOT DO IS DEMAND A CLICK PER ORDER. It
// declares `coverage: "NOT_PROVISIONED"`, which grades that gap
// MINOR/INFORMATIONAL: no pharmacist can license a drug database from
// the PV1 queue, and an alert on 100% of orders that nobody can act on
// trains the reflex that dismisses the alert that mattered. The
// systemic deficiency is stated where it can be acted on — the boot
// warning in the entry point, and `gapCount` in reporting — rather
// than charged to every prescription. See `screeningGapSeverity`.
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
import type { Prisma } from "@pharmax/database";
import { runtime } from "@pharmax/platform-core";

/**
 * What a per-screen resolver gets: the command's own transaction and
 * the codes the engine is about to ask about, so the resolver can
 * prefetch exactly those rows and hand back a synchronous source over
 * them. Reads inside the caller's transaction are what make one
 * screen resolve against exactly one knowledge release even while an
 * ingestion swaps releases mid-command.
 */
export interface DrugKnowledgeScreenContext {
  readonly tx: Prisma.TransactionClient;
  readonly organizationId: string;
  /** Candidate + profile drug codes, deduplicated. */
  readonly drugCodes: ReadonlyArray<string>;
  /** Screenable allergy substance codes, deduplicated. */
  readonly allergenCodes: ReadonlyArray<string>;
}

export type DrugKnowledgeSourceResolver = (
  context: DrugKnowledgeScreenContext
) => Promise<DrugKnowledgeSource>;

/**
 * Either a STATIC source (an in-memory container whose facts never
 * change — tests, local development) or a per-screen RESOLVER (a
 * database-backed adapter that prefetches inside the command's
 * transaction — production). A union rather than two optional fields,
 * so a configuration that supplies both or neither is unrepresentable
 * instead of silently tie-broken.
 *
 * Either way, what the engine receives MUST be pure and synchronous —
 * the engine is a total function and stays that way so the same call
 * is usable from a command handler, a UI affordance check, and a
 * `command_log` replay. Resolving facts BEFORE the engine runs is the
 * resolver's whole job.
 */
export type ClinicalScreeningConfiguration =
  | { readonly knowledgeSource: DrugKnowledgeSource }
  | { readonly knowledgeSourceResolver: DrugKnowledgeSourceResolver };

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
  box.value = Object.freeze(
    "knowledgeSource" in config
      ? { knowledgeSource: config.knowledgeSource }
      : { knowledgeSourceResolver: config.knowledgeSourceResolver }
  );
}

/**
 * The source for ONE screen: the configured static source, the
 * configured resolver applied to this screen's context, or the empty
 * in-memory source when boot wired nothing. See the header for why
 * the unconfigured case does not throw.
 */
export async function resolveClinicalScreeningKnowledgeSource(
  context: DrugKnowledgeScreenContext
): Promise<DrugKnowledgeSource> {
  const configured = box.value;
  if (configured === null) return EMPTY_KNOWLEDGE_SOURCE;
  if ("knowledgeSource" in configured) return configured.knowledgeSource;
  return configured.knowledgeSourceResolver(context);
}

/**
 * The static source, for callers OUTSIDE the screening path (boot
 * assertions, composition tests). The screening path itself must use
 * `resolveClinicalScreeningKnowledgeSource`, which is the only way a
 * per-screen resolver can answer.
 *
 * Throws for a resolver configuration rather than returning anything:
 * a resolver has no single source to return, and handing back the
 * empty source would tell the caller "nothing is provisioned" about a
 * deployment that is provisioned per screen.
 */
export function getClinicalScreeningKnowledgeSource(): DrugKnowledgeSource {
  const configured = box.value;
  if (configured === null) return EMPTY_KNOWLEDGE_SOURCE;
  if ("knowledgeSource" in configured) return configured.knowledgeSource;
  throw new Error(
    "A per-screen knowledge source resolver is configured; there is no static source to return. " +
      "Screening-path callers must use resolveClinicalScreeningKnowledgeSource."
  );
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
