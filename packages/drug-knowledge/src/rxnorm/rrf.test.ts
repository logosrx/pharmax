// The RRF mapping chain, against small hand-written fixtures.
//
// FIXTURE DATA IS SYNTHETIC by clean-room rule: fake RXCUIs in the
// 9xxxxx range, fake 11-digit NDCs in the 99999… labeler space, and
// ingredient names that name themselves as fixtures. Only the FILE
// FORMAT is real (public NLM RxNorm Technical Documentation); no line
// here appears in any actual release.

import { describe, expect, it } from "vitest";

import { RxnormReleaseModelBuilder } from "./rrf.js";

// -- RRF line constructors (public column layouts) --------------------

/** RXNCONSO: 18 fields. rxcui[0], SAB[11], TTY[12], STR[14], SUPPRESS[16]. */
function conso(input: {
  rxcui: string;
  tty: string;
  name: string;
  sab?: string;
  suppress?: string;
}): string {
  const f = new Array<string>(18).fill("");
  f[0] = input.rxcui;
  f[11] = input.sab ?? "RXNORM";
  f[12] = input.tty;
  f[14] = input.name;
  f[16] = input.suppress ?? "N";
  return f.join("|");
}

/** RXNREL: 16 fields. rxcui1[0], rxcui2[4], RELA[7], SAB[10]. */
function rel(input: { a: string; b: string; rela: string; sab?: string }): string {
  const f = new Array<string>(16).fill("");
  f[0] = input.a;
  f[4] = input.b;
  f[7] = input.rela;
  f[10] = input.sab ?? "RXNORM";
  return f.join("|");
}

/** RXNSAT: 13 fields. rxcui[0], ATN[8], SAB[9], ATV[10]. */
function sat(input: { rxcui: string; atn?: string; sab?: string; atv: string }): string {
  const f = new Array<string>(13).fill("");
  f[0] = input.rxcui;
  f[8] = input.atn ?? "NDC";
  f[9] = input.sab ?? "RXNORM";
  f[10] = input.atv;
  return f.join("|");
}

// -- The synthetic release ---------------------------------------------
//
//   IN  900001 FIXTURE-INGREDIENT-ALFA
//   PIN 900002 FIXTURE-PRECISE-ALFA
//   SCDC 910001  (component of the clinical drug)
//   SCD 920001 FIXTURE-DRUG-ALFA        ← NDC 99999000101
//   SBD 930001 FIXTURE-BRAND-ALFA       ← NDC 99999000201 (tradename of SCD)
//   GPCK 940001 FIXTURE-PACK            ← NDC 99999000301 (contains SCD)
//   SCD 920002 FIXTURE-DRUG-NO-ING      ← NDC 99999000401 (no ingredients!)

const CONSO_LINES = [
  conso({ rxcui: "900001", tty: "IN", name: "FIXTURE-INGREDIENT-ALFA" }),
  conso({ rxcui: "900002", tty: "PIN", name: "FIXTURE-PRECISE-ALFA" }),
  conso({ rxcui: "910001", tty: "SCDC", name: "FIXTURE-COMPONENT-ALFA" }),
  conso({ rxcui: "920001", tty: "SCD", name: "FIXTURE-DRUG-ALFA" }),
  conso({ rxcui: "930001", tty: "SBD", name: "FIXTURE-BRAND-ALFA" }),
  conso({ rxcui: "940001", tty: "GPCK", name: "FIXTURE-PACK" }),
  conso({ rxcui: "920002", tty: "SCD", name: "FIXTURE-DRUG-NO-ING" }),
];

// Directions deliberately MIXED between the two RELA spellings, to pin
// that orientation comes from TTY and never from column position.
const REL_LINES = [
  rel({ a: "920001", b: "910001", rela: "consists_of" }),
  rel({ a: "900001", b: "910001", rela: "has_ingredient" }),
  rel({ a: "910001", b: "900002", rela: "has_precise_ingredient" }),
  rel({ a: "930001", b: "920001", rela: "tradename_of" }),
  rel({ a: "920001", b: "940001", rela: "contained_in" }),
];

const SAT_LINES = [
  sat({ rxcui: "920001", atv: "99999000101" }),
  sat({ rxcui: "930001", atv: "99999000201" }),
  sat({ rxcui: "940001", atv: "99999000301" }),
  sat({ rxcui: "920002", atv: "99999000401" }),
];

function buildModel(input: {
  conso?: ReadonlyArray<string>;
  rels?: ReadonlyArray<string>;
  sats?: ReadonlyArray<string>;
}) {
  const builder = new RxnormReleaseModelBuilder();
  for (const line of input.conso ?? CONSO_LINES) builder.addConsoLine(line);
  for (const line of input.rels ?? REL_LINES) builder.addRelLine(line);
  for (const line of input.sats ?? SAT_LINES) builder.addSatLine(line);
  return builder.build();
}

describe("RxnormReleaseModelBuilder — the NDC → ingredient chain", () => {
  it("resolves a clinical drug's NDC to its IN and PIN ingredients", () => {
    const model = buildModel({});
    expect(model.ndcToProduct.get("99999000101")).toBe("920001");
    expect(model.productIngredients.get("920001")?.map((i) => i.rxcui)).toEqual([
      "900001",
      "900002",
    ]);
  });

  it("carries the ingredient TTY and name for diagnostics", () => {
    const model = buildModel({});
    const ingredients = model.productIngredients.get("920001") ?? [];
    expect(ingredients).toContainEqual({
      rxcui: "900001",
      tty: "IN",
      name: "FIXTURE-INGREDIENT-ALFA",
    });
    expect(ingredients).toContainEqual({
      rxcui: "900002",
      tty: "PIN",
      name: "FIXTURE-PRECISE-ALFA",
    });
  });

  it("resolves a brand drug through its tradename edge to the generic's ingredients", () => {
    const model = buildModel({});
    expect(model.ndcToProduct.get("99999000201")).toBe("930001");
    expect(model.productIngredients.get("930001")?.map((i) => i.rxcui)).toEqual([
      "900001",
      "900002",
    ]);
  });

  it("resolves a pack through its contained products", () => {
    const model = buildModel({});
    expect(model.ndcToProduct.get("99999000301")).toBe("940001");
    expect(model.productIngredients.get("940001")?.map((i) => i.rxcui)).toEqual([
      "900001",
      "900002",
    ]);
  });

  it("DROPS an NDC whose product resolves zero ingredients, and counts it", () => {
    // "This drug has no ingredients" screens CLEAR; the model must
    // return unresolvable (→ an honest gap) instead.
    const model = buildModel({});
    expect(model.ndcToProduct.has("99999000401")).toBe(false);
    expect(model.ndcsWithoutIngredients).toBe(1);
  });

  it("accepts relationship rows in either direction (orientation is by TTY, not column)", () => {
    const flipped = [
      rel({ a: "910001", b: "920001", rela: "constitutes" }),
      rel({ a: "910001", b: "900001", rela: "ingredient_of" }),
      rel({ a: "900002", b: "910001", rela: "precise_ingredient_of" }),
    ];
    const model = buildModel({ rels: flipped });
    expect(model.productIngredients.get("920001")?.map((i) => i.rxcui)).toEqual([
      "900001",
      "900002",
    ]);
  });

  it("ignores suppressed concepts, non-RXNORM SABs, and non-NDC attributes", () => {
    const model = buildModel({
      conso: [
        ...CONSO_LINES,
        conso({ rxcui: "999999", tty: "SCD", name: "SUPPRESSED", suppress: "Y" }),
        conso({ rxcui: "888888", tty: "SCD", name: "OTHER-SAB", sab: "NOT_RXNORM" }),
      ],
      sats: [
        ...SAT_LINES,
        sat({ rxcui: "920001", atn: "NOT_NDC", atv: "99999009999" }),
        sat({ rxcui: "999999", atv: "99999008888" }),
        sat({ rxcui: "888888", atv: "99999007777" }),
      ],
    });
    expect(model.ndcToProduct.has("99999009999")).toBe(false);
    // NDCs pointing at suppressed / foreign-SAB concepts resolve no
    // ingredients and are dropped.
    expect(model.ndcToProduct.has("99999008888")).toBe(false);
    expect(model.ndcToProduct.has("99999007777")).toBe(false);
  });

  it("ignores an NDC attached to a non-product concept (an ingredient cannot be dispensed)", () => {
    const model = buildModel({
      sats: [...SAT_LINES, sat({ rxcui: "900001", atv: "99999006666" })],
    });
    expect(model.ndcToProduct.has("99999006666")).toBe(false);
  });

  it("prunes ingredient lists that no surviving NDC reaches", () => {
    // The no-ingredient SCD contributes nothing; only reachable
    // products remain in the ingredient map.
    const model = buildModel({});
    expect([...model.productIngredients.keys()].sort()).toEqual(["920001", "930001", "940001"]);
  });

  it("still resolves when synonym atoms (PSN/SY/TMSY) share the concept's RXCUI", () => {
    // A real release prints SEVERAL atoms per RXCUI: the defining atom
    // (SCD, SCDC, IN, …) plus prescribable-name and synonym atoms on
    // the same concept. A last-write-wins TTY map let whichever atom
    // came last rename the concept — an SCD followed by its PSN row
    // stopped looking like a product, and ~98% of a real release's
    // NDCs were dropped as "no ingredients". Regression: interleave
    // synonym atoms before AND after every defining atom; resolution
    // must be identical to the plain fixture.
    const model = buildModel({
      conso: [
        conso({ rxcui: "920001", tty: "SY", name: "FIXTURE-DRUG-ALFA-SYNONYM" }),
        ...CONSO_LINES,
        conso({ rxcui: "920001", tty: "PSN", name: "FIXTURE-DRUG-ALFA-PRESCRIBABLE" }),
        conso({ rxcui: "930001", tty: "TMSY", name: "FIXTURE-BRAND-ALFA-TMSY" }),
        conso({ rxcui: "940001", tty: "PSN", name: "FIXTURE-PACK-PRESCRIBABLE" }),
        conso({ rxcui: "910001", tty: "SY", name: "FIXTURE-COMPONENT-ALFA-SYNONYM" }),
        conso({ rxcui: "900001", tty: "SY", name: "FIXTURE-INGREDIENT-ALFA-SYNONYM" }),
        conso({ rxcui: "900002", tty: "SY", name: "FIXTURE-PRECISE-ALFA-SYNONYM" }),
      ],
    });
    for (const [ndc, product] of [
      ["99999000101", "920001"],
      ["99999000201", "930001"],
      ["99999000301", "940001"],
    ] as const) {
      expect(model.ndcToProduct.get(ndc)).toBe(product);
      expect(model.productIngredients.get(product)?.map((i) => i.rxcui)).toEqual([
        "900001",
        "900002",
      ]);
    }
    // The ingredient TTY still reports the DEFINING type, not a synonym.
    expect(model.productIngredients.get("920001")?.map((i) => i.tty)).toEqual(["IN", "PIN"]);
  });
});
