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
  DrugKnowledge,
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

  return {
    describeDrug(code: DrugCode): DrugKnowledge | null {
      return drugs.get(code) ?? null;
    },
    describeAllergen(code: AllergenCode): AllergenKnowledge | null {
      return allergens.get(code) ?? null;
    },
    findIngredientInteraction(a: IngredientCode, b: IngredientCode): InteractionFact | null {
      return interactions.get(pairKey(a, b)) ?? null;
    },
  };
}
