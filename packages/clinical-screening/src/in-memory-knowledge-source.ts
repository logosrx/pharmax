// An in-memory `DrugKnowledgeSource`, for tests and for local
// development against a screening flow before a licensed adapter
// exists.
//
// THIS MODULE SHIPS NO DRUG DATA. It is an empty container: every fact
// it can return is one the caller put there. That is not an oversight
// to be filled in later — a curated interaction table baked into this
// repository is precisely the artefact the clean-room policy exists to
// keep out, and its absence here is the guarantee.
//
// Callers seeding it for tests should use obviously synthetic codes
// (`INGREDIENT_ALFA`, `CLASS_BRAVO`) rather than real drug names. Real
// names in a fixture invite two failures: a reader mistakes the
// fixture for clinical guidance, and a reviewer has to work out
// whether the pharmacology came from a licensed source or a textbook.
// Synthetic codes make both questions unaskable.

import type {
  AllergenCode,
  AllergenKnowledge,
  DrugCode,
  DrugCodeScope,
  DrugKnowledge,
  DrugKnowledgeCoverage,
  DrugKnowledgeRelease,
  DrugKnowledgeSource,
  IngredientCode,
  InteractionFact,
} from "./knowledge-source.js";

/** One seeded interaction. The pair is unordered. */
export interface SeededInteraction {
  readonly ingredients: readonly [IngredientCode, IngredientCode];
  readonly fact: InteractionFact;
}

export interface InMemoryKnowledgeSeed {
  readonly drugs?: Readonly<Record<DrugCode, DrugKnowledge>>;
  readonly allergens?: Readonly<Record<AllergenCode, AllergenKnowledge>>;
  readonly interactions?: ReadonlyArray<SeededInteraction>;
  /**
   * Overrides the derived coverage. Supply this to model an adapter
   * that holds a licence but happens to know nothing about the drugs
   * in a particular test.
   */
  readonly coverage?: DrugKnowledgeCoverage;
  /**
   * Codes the source declares OUT_OF_NOMENCLATURE — never resolvable,
   * so their gaps grade informational rather than acknowledge-tier.
   * Models a compounded preparation's org-local identifier. Every
   * other code answers IN_NOMENCLATURE, the conservative default.
   */
  readonly outOfNomenclatureDrugCodes?: ReadonlyArray<DrugCode>;
  /**
   * The release identity the wiring layer stamps onto persisted
   * findings. Defaults to `null`: a caller-seeded container holds no
   * publisher's release, and claiming one would fabricate provenance.
   */
  readonly release?: DrugKnowledgeRelease;
}

/**
 * Order-independent key for an ingredient pair. Sorting the pair is
 * what makes the resulting source satisfy the symmetry the
 * `DrugKnowledgeSource` contract requires of implementers.
 */
function pairKey(a: IngredientCode, b: IngredientCode): string {
  return a.localeCompare(b) <= 0 ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

/**
 * Build a source over the supplied facts. The seed is copied into
 * lookup structures at construction, so later mutation of the caller's
 * objects cannot change what an in-flight screen sees.
 *
 * COVERAGE IS DERIVED HERE, which is the one place deriving it is
 * legitimate. A real adapter must DECLARE its coverage, because
 * "answered nothing so far" and "holds nothing" are different claims
 * it alone can distinguish. This container is the exception: its
 * entire contents are the argument the caller just passed, so
 * "were any drugs seeded?" is not an inference about the world, it is
 * a reading of the caller's own expression. An unseeded container —
 * which is what an unlicensed deployment boots with — is
 * NOT_PROVISIONED, and that is the answer that keeps a permanent
 * product gap from being reported as if a pharmacist could fix it.
 */
export function createInMemoryDrugKnowledgeSource(
  seed: InMemoryKnowledgeSeed = {}
): DrugKnowledgeSource {
  const drugs = new Map<DrugCode, DrugKnowledge>(Object.entries(seed.drugs ?? {}));
  const allergens = new Map<AllergenCode, AllergenKnowledge>(Object.entries(seed.allergens ?? {}));

  const interactions = new Map<string, InteractionFact>();
  for (const entry of seed.interactions ?? []) {
    const [a, b] = entry.ingredients;
    interactions.set(pairKey(a, b), entry.fact);
  }

  const coverage: DrugKnowledgeCoverage =
    seed.coverage ?? (drugs.size > 0 ? "PROVISIONED" : "NOT_PROVISIONED");

  const outOfNomenclature = new Set(seed.outOfNomenclatureDrugCodes ?? []);

  return {
    coverage,
    release: seed.release ?? null,
    describeDrug(code: DrugCode): DrugKnowledge | null {
      return drugs.get(code) ?? null;
    },
    describeAllergen(code: AllergenCode): AllergenKnowledge | null {
      return allergens.get(code) ?? null;
    },
    drugCodeScope(code: DrugCode): DrugCodeScope {
      return outOfNomenclature.has(code) ? "OUT_OF_NOMENCLATURE" : "IN_NOMENCLATURE";
    },
    findIngredientInteraction(a: IngredientCode, b: IngredientCode): InteractionFact | null {
      return interactions.get(pairKey(a, b)) ?? null;
    },
  };
}
