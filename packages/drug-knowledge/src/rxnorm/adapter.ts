// The RxNorm-backed `DrugKnowledgeSource` — the first production
// implementation of the knowledge seam.
//
// SHAPE: A PER-SCREEN PREFETCH, NOT A CACHE. `screenPrescription` is
// pure and synchronous by contract, so an adapter must resolve its
// facts BEFORE the engine runs (the seam's own documentation says
// exactly this). This loader is that resolution: called inside the
// command's transaction with the drug codes the screen is about to
// ask about, it reads only those codes' rows and hands back a
// synchronous source over them. Three consequences fall out:
//
//   - Reads are bounded by the order's size (a handful of NDCs), not
//     the release's (~hundreds of thousands of rows), so nothing here
//     is an unbounded query and no in-process copy of the release
//     exists to go stale.
//   - Everything is read inside the caller's transaction, so one
//     screen resolves against exactly one release even if an
//     ingestion promotes a new one mid-command.
//   - The screening path never leaves Postgres. No NLM/RxNav API call
//     sits inside PV1 — a third-party outage or rate limit cannot
//     stop a pharmacist verifying a prescription.
//
// WHAT THIS SOURCE HONESTLY DOES NOT KNOW, stated here because
// implying otherwise is the failure mode:
//
//   - `findIngredientInteraction` is ALWAYS null. RxNorm holds no
//     interaction facts; those are licensed editorial content.
//   - `describeAllergen` is ALWAYS null. Cross-reactivity grouping
//     (cephalosporin/penicillin) is clinical judgement, not an RxNorm
//     fact, so cross-sensitivity screening does not run from this
//     source — only EXACT ingredient matches can fire. The engine
//     treats a null allergen lookup as "no cross-sensitivity data",
//     which is precisely true.
//   - `therapeuticClassCodes` is empty (Prescribable Content carries
//     no classification), so class-level duplication does not fire;
//     ingredient-level duplication still does.
//   - `doseRange` is null; the DOSE_RANGE axis is independently
//     NOT_SUPPORTED_BY_PLATFORM (see axis-capability.ts).
//
// CODE SPACES. `describeDrug` is keyed by the prescription's NDC
// (normalized 11-digit, same normalization `@pharmax/drug-identity`
// gives `prescription.drugNdc`); the ingredient codes it emits are
// bare RxNorm ingredient RXCUIs — the code space `patient_allergy`
// rows with `substanceCodeSystem = RXNORM` are recorded in, which is
// what makes the engine's string-equality ingredient match a real
// comparison. Allergies coded as NDC or SNOMED CT are not matched by
// this source; they remain visible to the pharmacist in the PV1
// allergy panel, which stays load-bearing for them.
//
// PHI: reads nomenclature tables and the org's product catalog rows
// for the NDCs on the screen. No patient-bearing model is touched and
// nothing is logged.

import type {
  DrugCode,
  DrugCodeScope,
  DrugKnowledge,
  DrugKnowledgeSource,
} from "@pharmax/clinical-screening";
import type { TenantTransactionClient } from "@pharmax/database";
import { normalizeNdc } from "@pharmax/drug-identity";

/** Stamped into `order_screening_finding.knowledgeSourceCode`. */
export const RXNORM_KNOWLEDGE_SOURCE_CODE = "RXNORM_PRESCRIBABLE";

export interface LoadRxnormKnowledgeSourceInput {
  readonly tx: TenantTransactionClient;
  readonly organizationId: string;
  /** Every drug code the screen will ask about: candidate + profile. */
  readonly drugCodes: ReadonlyArray<string>;
}

/**
 * Build the source for one screen.
 *
 * Coverage is declared from whether a LIVE release exists — which is
 * the "was I given a dataset?" question the seam requires a real
 * adapter to answer at construction, asked of the database that IS
 * the dataset. Boot with empty tables therefore degrades to
 * NOT_PROVISIONED (informational gaps, exactly as before this adapter
 * existed) rather than crashing or, worse, answering.
 */
export async function loadRxnormKnowledgeSourceForScreen(
  input: LoadRxnormKnowledgeSourceInput
): Promise<DrugKnowledgeSource> {
  const uniqueCodes = [...new Set(input.drugCodes)];

  // The org's own catalog says which of these codes are in-house
  // compound identifiers that national nomenclature was never going
  // to hold. Tenant-scoped read (the catalog is org data even though
  // the nomenclature is global); an NDC with no catalog row defaults
  // to "national", the direction that over-prompts rather than
  // silences.
  const catalogRows =
    uniqueCodes.length === 0
      ? []
      : await input.tx.product.findMany({
          where: { organizationId: input.organizationId, ndc: { in: uniqueCodes } },
          select: { ndc: true, ndcKind: true },
        });
  const outOfNomenclature = new Set(
    catalogRows.filter((row) => row.ndcKind === "IN_HOUSE_COMPOUND").map((row) => row.ndc)
  );

  const drugCodeScope = (code: DrugCode): DrugCodeScope =>
    outOfNomenclature.has(code) ? "OUT_OF_NOMENCLATURE" : "IN_NOMENCLATURE";

  const live = await input.tx.rxnormRelease.findFirst({
    where: { status: "LIVE" },
    select: { id: true, version: true },
  });

  if (live === null) {
    return {
      coverage: "NOT_PROVISIONED",
      release: null,
      describeDrug: () => null,
      describeAllergen: () => null,
      drugCodeScope,
      findIngredientInteraction: () => null,
    };
  }

  // Original code → normalized 11-digit NDC. A code that does not
  // normalize cannot be in the reference tables and simply stays
  // unresolvable (an honest gap), never an error.
  const normalizedByCode = new Map<string, string>();
  for (const code of uniqueCodes) {
    const normalized = normalizeNdc(code);
    if (normalized !== null) normalizedByCode.set(code, normalized);
  }

  const ndcRows =
    normalizedByCode.size === 0
      ? []
      : await input.tx.rxnormNdcProduct.findMany({
          where: { releaseId: live.id, ndc11: { in: [...new Set(normalizedByCode.values())] } },
          select: { ndc11: true, productRxcui: true },
        });
  const productByNdc11 = new Map(ndcRows.map((row) => [row.ndc11, row.productRxcui]));

  const productRxcuis = [...new Set(productByNdc11.values())];
  const ingredientRows =
    productRxcuis.length === 0
      ? []
      : await input.tx.rxnormProductIngredient.findMany({
          where: { releaseId: live.id, productRxcui: { in: productRxcuis } },
          select: { productRxcui: true, ingredientRxcui: true },
        });

  const ingredientsByProduct = new Map<string, string[]>();
  for (const row of ingredientRows) {
    const list = ingredientsByProduct.get(row.productRxcui);
    if (list === undefined) {
      ingredientsByProduct.set(row.productRxcui, [row.ingredientRxcui]);
    } else {
      list.push(row.ingredientRxcui);
    }
  }

  const knowledgeByCode = new Map<string, DrugKnowledge>();
  for (const [code, ndc11] of normalizedByCode) {
    const productRxcui = productByNdc11.get(ndc11);
    if (productRxcui === undefined) continue;
    const ingredientCodes = ingredientsByProduct.get(productRxcui);
    // Zero-ingredient products are not loaded by ingestion, but the
    // guard is repeated here because "this drug has no ingredients"
    // screens CLEAR and must be unrepresentable, not merely unlikely.
    if (ingredientCodes === undefined || ingredientCodes.length === 0) continue;
    knowledgeByCode.set(code, {
      ingredientCodes: Object.freeze([...ingredientCodes].sort((a, b) => a.localeCompare(b))),
      therapeuticClassCodes: Object.freeze([]),
      crossSensitivityClassCodes: Object.freeze([]),
      doseRange: null,
    });
  }

  return {
    coverage: "PROVISIONED",
    release: { source: RXNORM_KNOWLEDGE_SOURCE_CODE, version: live.version },
    describeDrug: (code) => knowledgeByCode.get(code) ?? null,
    describeAllergen: () => null,
    drugCodeScope,
    findIngredientInteraction: () => null,
  };
}
