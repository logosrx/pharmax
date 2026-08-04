import { describe, expect, it } from "vitest";

import {
  createInMemoryDrugKnowledgeSource,
  type DrugKnowledge,
  type InteractionFact,
} from "./index.js";

// Synthetic codes throughout. Nothing here is clinical guidance and
// nothing is derived from a licensed source; see the module header of
// `in-memory-knowledge-source.ts`.

const ALFA: DrugKnowledge = {
  ingredientCodes: ["ING_ALFA"],
  therapeuticClassCodes: ["CLASS_ONE"],
  crossSensitivityClassCodes: ["XCLASS_ONE"],
  doseRange: null,
};

const FACT: InteractionFact = {
  severity: "MODERATE",
  certainty: "PROBABLE",
  citation: "synthetic fixture",
};

describe("createInMemoryDrugKnowledgeSource", () => {
  it("returns null for every lookup when seeded with nothing", () => {
    // The default construction is the honest one: this package ships
    // no drug data, and an unseeded source knows nothing.
    const source = createInMemoryDrugKnowledgeSource();
    expect(source.describeDrug("DRUG_ALFA")).toBeNull();
    expect(source.describeAllergen("ING_ALFA")).toBeNull();
    expect(source.findIngredientInteraction("ING_ALFA", "ING_BRAVO")).toBeNull();
  });

  it("returns seeded drug knowledge", () => {
    const source = createInMemoryDrugKnowledgeSource({ drugs: { DRUG_ALFA: ALFA } });
    expect(source.describeDrug("DRUG_ALFA")).toEqual(ALFA);
  });

  it("distinguishes an unknown drug from a drug with no ingredients", () => {
    // The contract requires `null` for unknown, because the engine
    // turns that into a visible screening gap while an empty
    // DrugKnowledge would silently screen clean.
    const source = createInMemoryDrugKnowledgeSource({
      drugs: {
        DRUG_EMPTY: {
          ingredientCodes: [],
          therapeuticClassCodes: [],
          crossSensitivityClassCodes: [],
          doseRange: null,
        },
      },
    });
    expect(source.describeDrug("DRUG_EMPTY")).not.toBeNull();
    expect(source.describeDrug("DRUG_MISSING")).toBeNull();
  });

  it("answers an interaction identically whichever way the pair is ordered", () => {
    // The DrugKnowledgeSource contract requires symmetry. The engine
    // enumerates pairs in profile order and does not normalise them,
    // so an asymmetric source would make findings depend on row order.
    const source = createInMemoryDrugKnowledgeSource({
      interactions: [{ ingredients: ["ING_BRAVO", "ING_ALFA"], fact: FACT }],
    });
    expect(source.findIngredientInteraction("ING_ALFA", "ING_BRAVO")).toEqual(FACT);
    expect(source.findIngredientInteraction("ING_BRAVO", "ING_ALFA")).toEqual(FACT);
  });

  it("does not confuse pairs that share a code", () => {
    const other: InteractionFact = { severity: "MAJOR", certainty: "DEFINITE", citation: null };
    const source = createInMemoryDrugKnowledgeSource({
      interactions: [
        { ingredients: ["ING_ALFA", "ING_BRAVO"], fact: FACT },
        { ingredients: ["ING_ALFA", "ING_CHARLIE"], fact: other },
      ],
    });
    expect(source.findIngredientInteraction("ING_ALFA", "ING_BRAVO")).toEqual(FACT);
    expect(source.findIngredientInteraction("ING_ALFA", "ING_CHARLIE")).toEqual(other);
    expect(source.findIngredientInteraction("ING_BRAVO", "ING_CHARLIE")).toBeNull();
  });

  it("resolves allergens independently of drugs", () => {
    // An allergy is routinely recorded against a substance that is not
    // a dispensable product, so the two lookups are separate.
    const source = createInMemoryDrugKnowledgeSource({
      allergens: { ALLERGEN_ALFA: { crossSensitivityClassCodes: ["XCLASS_ONE"] } },
    });
    expect(source.describeAllergen("ALLERGEN_ALFA")).toEqual({
      crossSensitivityClassCodes: ["XCLASS_ONE"],
    });
    expect(source.describeDrug("ALLERGEN_ALFA")).toBeNull();
  });

  it("is unaffected by later mutation of the caller's seed", () => {
    // Construction copies into lookup structures, so a seed the caller
    // keeps editing cannot change what an in-flight screen sees.
    const interactions = [{ ingredients: ["ING_ALFA", "ING_BRAVO"] as const, fact: FACT }];
    const drugs: Record<string, DrugKnowledge> = { DRUG_ALFA: ALFA };
    const source = createInMemoryDrugKnowledgeSource({ drugs, interactions });

    delete drugs["DRUG_ALFA"];
    interactions.pop();

    expect(source.describeDrug("DRUG_ALFA")).toEqual(ALFA);
    expect(source.findIngredientInteraction("ING_ALFA", "ING_BRAVO")).toEqual(FACT);
  });

  it("carries no release identity unless the seed supplies one", () => {
    // A caller-seeded container holds no publisher's release, and
    // fabricating one would put false provenance on every persisted
    // finding the wiring layer stamps.
    expect(createInMemoryDrugKnowledgeSource().release).toBeNull();
    const source = createInMemoryDrugKnowledgeSource({
      release: { source: "TEST_SOURCE", version: "0001" },
    });
    expect(source.release).toEqual({ source: "TEST_SOURCE", version: "0001" });
  });

  it("answers IN_NOMENCLATURE for every code by default — the conservative direction", () => {
    const source = createInMemoryDrugKnowledgeSource({ drugs: { DRUG_ALFA: ALFA } });
    expect(source.drugCodeScope("DRUG_ALFA")).toBe("IN_NOMENCLATURE");
    expect(source.drugCodeScope("NEVER_SEEN")).toBe("IN_NOMENCLATURE");
  });

  it("declares only the seeded codes OUT_OF_NOMENCLATURE", () => {
    const source = createInMemoryDrugKnowledgeSource({
      drugs: { DRUG_ALFA: ALFA },
      outOfNomenclatureDrugCodes: ["COMPOUND_LOCAL_1"],
    });
    expect(source.drugCodeScope("COMPOUND_LOCAL_1")).toBe("OUT_OF_NOMENCLATURE");
    expect(source.drugCodeScope("DRUG_ALFA")).toBe("IN_NOMENCLATURE");
  });
});
