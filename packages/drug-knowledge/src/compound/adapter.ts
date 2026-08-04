// The compound-formula knowledge source — the org's OWN body of drug
// knowledge, satisfying the same `DrugKnowledgeSource` seam the RxNorm
// adapter does, from the tenant's coded Master Formulation Records.
//
// WHAT THIS ANSWERS AND FROM WHERE. A compound product's identifier
// appears in no national nomenclature, so the RxNorm source can never
// resolve it. What CAN resolve it is the recipe the org itself wrote:
// `compound_formula` rows whose `compoundProductId` claims the product,
// with ingredient rows coded to RxNorm ingredient (IN) RXCUIs — the
// code space `patient_allergy` RXNORM rows use, which is what makes the
// engine's string-equality allergy match a real comparison. The answers
// here need NO RxNorm release to be loaded: the formulary team wrote
// the codes down, and comparing them to the patient's coded allergies
// is pure string equality.
//
// WHAT THIS HONESTLY DOES NOT KNOW, in the same spirit as the RxNorm
// adapter's header:
//
//   - `findIngredientInteraction` is ALWAYS null; `describeAllergen`
//     is ALWAYS null. A formula names ingredients; it asserts no
//     pharmacology. Cross-reactivity stays out (clean room).
//   - A formula with no RXNORM_IN rows answers NOTHING. Zero coded
//     ingredients must be unrepresentable as knowledge — "this drug
//     has no ingredients" screens CLEAR, and an uncoded recipe is the
//     opposite of screened. Such codes gap as LOCALLY_DECLARABLE.
//   - A formula with SOME uncoded rows answers the coded subset and
//     DECLARES the remainder (`uncodedIngredientCount`), which the
//     engine turns into `SCR_COMPOUND_INGREDIENTS_PARTIALLY_CODED`.
//     Rows asserted NO_RXNORM_INGREDIENT (a base or excipient a human
//     stated has no RxNorm concept) are neither: a made claim, not a
//     missing one.
//
// SHAPE: a per-screen prefetch inside the caller's transaction, like
// the RxNorm loader — reads bounded by the order's codes, one formula
// version per screen even if a publish lands mid-command, and no I/O
// after construction so the source stays pure and synchronous.
//
// VERSIONS AND ATTRIBUTION. The screen reads the ACTIVE formula
// version at screen time; `compoundFormulaProvenance` names that
// version (id + code + version) per drug code so the wiring layer can
// stamp it onto persisted findings — the org-formulary counterpart of
// the RxNorm release stamp. Provenance is answered even when the
// formula produced no knowledge (all rows uncoded): the gap row's
// reader asks "which uncoded recipe was on file?", and the answer is
// this one.
//
// PHI: reads the org's product catalog and formula tables. Recipes are
// not patient data; no patient-bearing model is touched; nothing is
// logged.

import type { CompoundFormulaProvenance, DrugKnowledge } from "@pharmax/clinical-screening";
import type { TenantTransactionClient } from "@pharmax/database";

export interface LoadCompoundFormulaKnowledgeInput {
  readonly tx: TenantTransactionClient;
  readonly organizationId: string;
  /** Every drug code the screen will ask about: candidate + profile. */
  readonly drugCodes: ReadonlyArray<string>;
}

/**
 * The org-declared half of a screen's drug knowledge, resolved once
 * per screen. Consumed by the composite source in `composite.ts`; not
 * itself a `DrugKnowledgeSource`, because coverage and nomenclature
 * questions for national codes belong to the published-release source
 * it is composed with.
 */
export interface CompoundFormulaDeclarations {
  /**
   * Codes whose catalog product is IN_HOUSE_COMPOUND — the codes for
   * which the org's formulary, not any national release, is the body
   * of knowledge. Membership here makes an unresolved code
   * LOCALLY_DECLARABLE rather than OUT_OF_NOMENCLATURE.
   */
  readonly compoundCodes: ReadonlySet<string>;
  /** Codes that resolved to at least one coded ingredient. */
  readonly knowledgeByCode: ReadonlyMap<string, DrugKnowledge>;
  /** Every code whose ACTIVE formula was consulted, resolved or not. */
  readonly provenanceByCode: ReadonlyMap<string, CompoundFormulaProvenance>;
}

export async function loadCompoundFormulaDeclarationsForScreen(
  input: LoadCompoundFormulaKnowledgeInput
): Promise<CompoundFormulaDeclarations> {
  const uniqueCodes = [...new Set(input.drugCodes)];

  const compoundProducts =
    uniqueCodes.length === 0
      ? []
      : await input.tx.product.findMany({
          where: {
            organizationId: input.organizationId,
            ndc: { in: uniqueCodes },
            ndcKind: "IN_HOUSE_COMPOUND",
          },
          select: { id: true, ndc: true },
        });

  const compoundCodes = new Set(compoundProducts.map((product) => product.ndc));
  const codeByProductId = new Map(compoundProducts.map((product) => [product.id, product.ndc]));

  const formulas =
    compoundProducts.length === 0
      ? []
      : await input.tx.compoundFormula.findMany({
          where: {
            organizationId: input.organizationId,
            compoundProductId: { in: [...codeByProductId.keys()] },
            // The partial unique index caps ACTIVE at one per product,
            // so this read is unambiguous by construction.
            status: "ACTIVE",
          },
          select: {
            id: true,
            code: true,
            version: true,
            compoundProductId: true,
            ingredients: { select: { coding: true, rxnormInRxcui: true } },
          },
        });

  const knowledgeByCode = new Map<string, DrugKnowledge>();
  const provenanceByCode = new Map<string, CompoundFormulaProvenance>();

  for (const formula of formulas) {
    // Non-null by the WHERE above; narrowed for the type system.
    if (formula.compoundProductId === null) continue;
    const drugCode = codeByProductId.get(formula.compoundProductId);
    if (drugCode === undefined) continue;

    provenanceByCode.set(drugCode, {
      formulaId: formula.id,
      formulaCode: formula.code,
      formulaVersion: formula.version,
    });

    const codedRxcuis = [
      ...new Set(
        formula.ingredients
          .map((row) => row.rxnormInRxcui)
          .filter((rxcui): rxcui is string => rxcui !== null)
      ),
    ].sort((a, b) => a.localeCompare(b));

    // Zero coded rows answer NOTHING (an honest LOCALLY_DECLARABLE
    // gap), never an empty ingredient list — "this drug has no
    // ingredients" screens CLEAR and must stay unrepresentable.
    if (codedRxcuis.length === 0) continue;

    const uncodedIngredientCount = formula.ingredients.filter(
      (row) => row.coding === "UNCODED"
    ).length;

    knowledgeByCode.set(drugCode, {
      ingredientCodes: Object.freeze(codedRxcuis),
      uncodedIngredientCount,
      therapeuticClassCodes: Object.freeze([]),
      crossSensitivityClassCodes: Object.freeze([]),
      doseRange: null,
    });
  }

  return { compoundCodes, knowledgeByCode, provenanceByCode };
}
