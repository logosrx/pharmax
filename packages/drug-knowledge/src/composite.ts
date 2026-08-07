// The production `DrugKnowledgeSource`: RxNorm nomenclature for
// national codes, the org's coded compound formulas for its own.
//
// ONE SOURCE, TWO BODIES OF KNOWLEDGE, DISJOINT CODE SPACES. A
// prescription's drug code is either a national NDC (answered from the
// RxNorm release, when one is live) or an org-local compound
// identifier flagged IN_HOUSE_COMPOUND in the catalog (answered from
// the ACTIVE coded formula claiming that product). The catalog flag is
// the router; a code with no catalog row defaults to the national
// path, the direction that over-prompts rather than silences — the
// same posture the RxNorm adapter takes on its own.
//
// WHAT COMPOSES HOW, and why each answer belongs to the side it does:
//
//   - `describeDrug`: formula answers win for compound-flagged codes
//     (national nomenclature has nothing to say about them); all other
//     codes go to RxNorm.
//   - `coverage` and `release`: the RxNorm side's. Coverage grades the
//     gap for an unresolved NATIONAL code, and the release stamp names
//     the published dataset — the org's formulary versions per recipe,
//     not per release, and is stamped per finding through
//     `compoundFormulaProvenance` instead.
//   - `drugCodeScope`: compound-flagged codes are LOCALLY_DECLARABLE —
//     closable by the org coding the formula, at ANY RxNorm coverage,
//     because the formulary answers independently of national
//     licensing. Everything else defers to the RxNorm side (which
//     no longer sees compound codes at all).
//   - `describeAllergen` / `findIngredientInteraction`: null from both
//     sides, delegated to the RxNorm side for the day it learns more.
//
// The compound side needs NO live RxNorm release: allergy matching is
// string equality between the formula's RXCUIs and the patient's coded
// allergies. A deployment with no license and a coded formulary still
// hard-stops a confirmed ingredient allergy on a compound.

import type { DrugKnowledgeSource } from "@pharmax/clinical-screening";
import type { TenantTransactionClient } from "@pharmax/database";

import { loadCompoundFormulaDeclarationsForScreen } from "./compound/adapter.js";
import { loadRxnormKnowledgeSourceForScreen } from "./rxnorm/adapter.js";

export interface LoadDrugKnowledgeSourceInput {
  readonly tx: TenantTransactionClient;
  readonly organizationId: string;
  /** Every drug code the screen will ask about: candidate + profile. */
  readonly drugCodes: ReadonlyArray<string>;
}

/**
 * Build the composite source for one screen. Both halves prefetch
 * inside the caller's transaction, so the whole screen answers from
 * one RxNorm release and one formula version per recipe even if an
 * ingestion or a publish lands mid-command.
 */
export async function loadDrugKnowledgeSourceForScreen(
  input: LoadDrugKnowledgeSourceInput
): Promise<DrugKnowledgeSource> {
  const [rxnorm, compound] = await Promise.all([
    loadRxnormKnowledgeSourceForScreen(input),
    loadCompoundFormulaDeclarationsForScreen(input),
  ]);

  return {
    coverage: rxnorm.coverage,
    // The formulary side declares recipes, never dosing envelopes, so
    // the facet is the RxNorm side's — NOT_PROVISIONED until licensed
    // dosing content is wired.
    doseRangeCoverage: rxnorm.doseRangeCoverage,
    release: rxnorm.release,
    describeDrug: (code) =>
      compound.compoundCodes.has(code)
        ? (compound.knowledgeByCode.get(code) ?? null)
        : rxnorm.describeDrug(code),
    describeAllergen: (code) => rxnorm.describeAllergen(code),
    drugCodeScope: (code) =>
      compound.compoundCodes.has(code) ? "LOCALLY_DECLARABLE" : rxnorm.drugCodeScope(code),
    compoundFormulaProvenance: (code) => compound.provenanceByCode.get(code) ?? null,
    findIngredientInteraction: (a, b) => rxnorm.findIngredientInteraction(a, b),
  };
}
