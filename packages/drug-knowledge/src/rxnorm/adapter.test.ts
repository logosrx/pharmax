// The per-screen adapter over a stubbed transaction client. What the
// stub proves: coverage declaration, code-space handling, the
// zero-ingredient guard, and the honest nulls. Behaviour against real
// Postgres — including the atomic-swap visibility guarantees — is
// pinned in packages/integration-tests/src/rxnorm-drug-knowledge.test.ts.

import { describe, expect, it } from "vitest";

import type { TenantTransactionClient } from "@pharmax/database";

import { loadRxnormKnowledgeSourceForScreen, RXNORM_KNOWLEDGE_SOURCE_CODE } from "./adapter.js";

interface StubData {
  readonly live: { id: string; version: string } | null;
  readonly products: ReadonlyArray<{ ndc: string; ndcKind: string }>;
  readonly ndcRows: ReadonlyArray<{ ndc11: string; productRxcui: string }>;
  readonly ingredientRows: ReadonlyArray<{ productRxcui: string; ingredientRxcui: string }>;
}

function stubTx(data: StubData): TenantTransactionClient {
  return {
    product: {
      findMany: async (args: { where: { ndc: { in: string[] } } }) =>
        data.products.filter((p) => args.where.ndc.in.includes(p.ndc)),
    },
    rxnormRelease: {
      findFirst: async () => data.live,
    },
    rxnormNdcProduct: {
      findMany: async (args: { where: { ndc11: { in: string[] } } }) =>
        data.ndcRows.filter((r) => args.where.ndc11.in.includes(r.ndc11)),
    },
    rxnormProductIngredient: {
      findMany: async (args: { where: { productRxcui: { in: string[] } } }) =>
        data.ingredientRows.filter((r) => args.where.productRxcui.in.includes(r.productRxcui)),
    },
  } as unknown as TenantTransactionClient;
}

const ORG = "00000000-0000-4000-8000-000000000001";
const LIVE = { id: "00000000-0000-4000-8000-00000000aaaa", version: "07072026" };

describe("loadRxnormKnowledgeSourceForScreen", () => {
  it("declares NOT_PROVISIONED with a null release when no release is live", async () => {
    const source = await loadRxnormKnowledgeSourceForScreen({
      tx: stubTx({ live: null, products: [], ndcRows: [], ingredientRows: [] }),
      organizationId: ORG,
      drugCodes: ["99999000101"],
    });
    expect(source.coverage).toBe("NOT_PROVISIONED");
    expect(source.release).toBeNull();
    expect(source.describeDrug("99999000101")).toBeNull();
  });

  it("declares PROVISIONED and names the release when one is live", async () => {
    const source = await loadRxnormKnowledgeSourceForScreen({
      tx: stubTx({ live: LIVE, products: [], ndcRows: [], ingredientRows: [] }),
      organizationId: ORG,
      drugCodes: [],
    });
    expect(source.coverage).toBe("PROVISIONED");
    expect(source.release).toEqual({
      source: RXNORM_KNOWLEDGE_SOURCE_CODE,
      version: "07072026",
    });
  });

  it("resolves a known NDC to sorted ingredient RXCUIs, keyed by the code as prescribed", async () => {
    const source = await loadRxnormKnowledgeSourceForScreen({
      tx: stubTx({
        live: LIVE,
        products: [],
        ndcRows: [{ ndc11: "99999000101", productRxcui: "920001" }],
        ingredientRows: [
          { productRxcui: "920001", ingredientRxcui: "900002" },
          { productRxcui: "920001", ingredientRxcui: "900001" },
        ],
      }),
      organizationId: ORG,
      drugCodes: ["99999000101"],
    });
    expect(source.describeDrug("99999000101")).toEqual({
      uncodedIngredientCount: 0,
      ingredientCodes: ["900001", "900002"],
      therapeuticClassCodes: [],
      crossSensitivityClassCodes: [],
      doseRange: null,
    });
  });

  it("normalizes a hyphenated prescription code before the lookup, keyed by the original string", async () => {
    const source = await loadRxnormKnowledgeSourceForScreen({
      tx: stubTx({
        live: LIVE,
        products: [],
        ndcRows: [{ ndc11: "99999000101", productRxcui: "920001" }],
        ingredientRows: [{ productRxcui: "920001", ingredientRxcui: "900001" }],
      }),
      organizationId: ORG,
      drugCodes: ["99999-0001-01"],
    });
    expect(source.describeDrug("99999-0001-01")?.ingredientCodes).toEqual(["900001"]);
  });

  it("answers null for an NDC the release does not hold", async () => {
    const source = await loadRxnormKnowledgeSourceForScreen({
      tx: stubTx({ live: LIVE, products: [], ndcRows: [], ingredientRows: [] }),
      organizationId: ORG,
      drugCodes: ["99999000999"],
    });
    expect(source.describeDrug("99999000999")).toBeNull();
    expect(source.drugCodeScope("99999000999")).toBe("IN_NOMENCLATURE");
  });

  it("answers null rather than an empty DrugKnowledge for a zero-ingredient product", async () => {
    // "This drug has no ingredients" screens clear; the contract
    // forbids it, and the guard must hold even if a load slipped a
    // zero-ingredient product in.
    const source = await loadRxnormKnowledgeSourceForScreen({
      tx: stubTx({
        live: LIVE,
        products: [],
        ndcRows: [{ ndc11: "99999000101", productRxcui: "920001" }],
        ingredientRows: [],
      }),
      organizationId: ORG,
      drugCodes: ["99999000101"],
    });
    expect(source.describeDrug("99999000101")).toBeNull();
  });

  it("declares an IN_HOUSE_COMPOUND catalog code OUT_OF_NOMENCLATURE", async () => {
    const source = await loadRxnormKnowledgeSourceForScreen({
      tx: stubTx({
        live: LIVE,
        products: [{ ndc: "99999000001", ndcKind: "IN_HOUSE_COMPOUND" }],
        ndcRows: [],
        ingredientRows: [],
      }),
      organizationId: ORG,
      drugCodes: ["99999000001"],
    });
    expect(source.drugCodeScope("99999000001")).toBe("OUT_OF_NOMENCLATURE");
    expect(source.describeDrug("99999000001")).toBeNull();
  });

  it("keeps a NATIONAL catalog code IN_NOMENCLATURE", async () => {
    const source = await loadRxnormKnowledgeSourceForScreen({
      tx: stubTx({
        live: LIVE,
        products: [{ ndc: "99999000501", ndcKind: "NATIONAL" }],
        ndcRows: [],
        ingredientRows: [],
      }),
      organizationId: ORG,
      drugCodes: ["99999000501"],
    });
    expect(source.drugCodeScope("99999000501")).toBe("IN_NOMENCLATURE");
  });

  it("holds no interaction facts and no allergen cross-sensitivity knowledge — ever", async () => {
    const source = await loadRxnormKnowledgeSourceForScreen({
      tx: stubTx({
        live: LIVE,
        products: [],
        ndcRows: [{ ndc11: "99999000101", productRxcui: "920001" }],
        ingredientRows: [{ productRxcui: "920001", ingredientRxcui: "900001" }],
      }),
      organizationId: ORG,
      drugCodes: ["99999000101"],
    });
    expect(source.findIngredientInteraction("900001", "900002")).toBeNull();
    expect(source.describeAllergen("900001")).toBeNull();
  });
});
