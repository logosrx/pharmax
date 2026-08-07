// What the compound-coverage block tells a pharmacist, per recipe row.
//
// Three badges, three different instructions, and the failure mode is
// a QUIET swap: "screened" on a row the machine never compared, or
// "asserted non-drug" on a row that was actually screened, renders
// fine and typechecks fine while telling the pharmacist a judgement
// happened that did not. Before this component was extracted from the
// order page, no test rendered the wiring at all — a swapped condition
// was caught by nothing. These tests pin badge-to-coding association
// per row, not just badge presence somewhere on the page.
//
// CLEAN ROOM / PHI: recipe data only, every name below is synthetic.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  OrderDetailCompoundInfo,
  OrderDetailCompoundIngredient,
} from "../../server/ops/get-order-detail.js";

import { CompoundCoveragePanel } from "./compound-coverage-panel.js";

const SCREENED_BADGE = "screened · RXCUI";
const ASSERTED_BADGE = "asserted non-drug — base/excipient";
const UNCODED_BADGE = "not machine-screened — read this row";

interface IngredientOverrides {
  readonly ingredientId?: string;
  readonly ingredientName?: string;
  readonly coding?: OrderDetailCompoundIngredient["coding"];
  readonly rxnormInRxcui?: string | null;
}

function ingredient(overrides: IngredientOverrides = {}): OrderDetailCompoundIngredient {
  const coding = overrides.coding ?? "RXNORM_IN";
  return {
    ingredientId: overrides.ingredientId ?? "ing-1",
    ingredientName: overrides.ingredientName ?? "SYNTHETIC INGREDIENT ALFA",
    quantity: "10",
    unit: "g",
    coding,
    rxnormInRxcui:
      overrides.rxnormInRxcui !== undefined
        ? overrides.rxnormInRxcui
        : coding === "RXNORM_IN"
          ? "1234567"
          : null,
  };
}

function compoundOf(
  ingredients: ReadonlyArray<OrderDetailCompoundIngredient>
): OrderDetailCompoundInfo {
  return {
    formula: {
      formulaId: "formula-1",
      formulaCode: "FRM-SYNTH-01",
      formulaVersion: 3,
      formulaName: "Synthetic Preparation Alfa",
      ingredients,
    },
  };
}

function render(compound: OrderDetailCompoundInfo): string {
  return renderToStaticMarkup(createElement(CompoundCoveragePanel, { compound }));
}

/**
 * The `<li>` markup for one ingredient row, so an assertion binds a
 * badge to ITS row rather than to the page as a whole — the whole
 * point, since the mutation this suite exists to catch moves a badge
 * between rows without removing it from the document.
 */
function rowFor(markup: string, ingredientName: string): string {
  const rows = markup.split("<li").filter((chunk) => chunk.includes(ingredientName));
  expect(rows, `exactly one row for ${ingredientName}`).toHaveLength(1);
  return rows[0] ?? "";
}

describe("CompoundCoveragePanel — no active formula", () => {
  it("shows the wholly-unscreened banner and no per-row badges", () => {
    const markup = render({ formula: null });

    expect(markup).toContain("no active formula linked");
    expect(markup).toContain("none of its ingredients");
    expect(markup).not.toContain(SCREENED_BADGE);
    expect(markup).not.toContain(ASSERTED_BADGE);
    expect(markup).not.toContain(UNCODED_BADGE);
  });
});

describe("CompoundCoveragePanel — badge-to-coding wiring", () => {
  // One formula, all three codings at once. Any pairwise swap of the
  // switch's branches fails at least one row's assertion.
  const mixed = compoundOf([
    ingredient({
      ingredientId: "ing-screened",
      ingredientName: "SYNTHETIC INGREDIENT ALFA",
      coding: "RXNORM_IN",
      rxnormInRxcui: "1234567",
    }),
    ingredient({
      ingredientId: "ing-asserted",
      ingredientName: "SYNTHETIC BASE BRAVO",
      coding: "NO_RXNORM_INGREDIENT",
    }),
    ingredient({
      ingredientId: "ing-uncoded",
      ingredientName: "SYNTHETIC INGREDIENT CHARLIE",
      coding: "UNCODED",
    }),
  ]);

  it("marks the RXNORM_IN row screened, with its RXCUI, and nothing else", () => {
    const row = rowFor(render(mixed), "SYNTHETIC INGREDIENT ALFA");
    expect(row).toContain(SCREENED_BADGE);
    expect(row).toContain("1234567");
    expect(row).not.toContain(ASSERTED_BADGE);
    expect(row).not.toContain(UNCODED_BADGE);
  });

  it("marks the NO_RXNORM_INGREDIENT row asserted non-drug — never screened", () => {
    // The swap that matters most: "asserted non-drug" records a HUMAN
    // claim that the row has no drug substance; "screened" records a
    // MACHINE comparison against the patient's allergies. Reading one
    // as the other misstates who vouched for the row.
    const row = rowFor(render(mixed), "SYNTHETIC BASE BRAVO");
    expect(row).toContain(ASSERTED_BADGE);
    expect(row).not.toContain(SCREENED_BADGE);
    expect(row).not.toContain(UNCODED_BADGE);
  });

  it("marks the UNCODED row as needing the pharmacist's eyes", () => {
    const row = rowFor(render(mixed), "SYNTHETIC INGREDIENT CHARLIE");
    expect(row).toContain(UNCODED_BADGE);
    expect(row).not.toContain(SCREENED_BADGE);
    expect(row).not.toContain(ASSERTED_BADGE);
  });

  it("summarizes a formula with any uncoded row as 'read them'", () => {
    expect(render(mixed)).toContain("Rows marked below were NOT machine-screened; read them.");
  });
});

describe("CompoundCoveragePanel — fully accounted-for formula", () => {
  it("says every row is coded or accounted for, with no warning badge", () => {
    // NO_RXNORM_INGREDIENT counts as accounted for: a pharmacist
    // asserted the row carries no drug substance, which is a settled
    // judgement, not a pending one.
    const markup = render(
      compoundOf([
        ingredient({ ingredientId: "ing-1", ingredientName: "SYNTHETIC INGREDIENT ALFA" }),
        ingredient({
          ingredientId: "ing-2",
          ingredientName: "SYNTHETIC BASE BRAVO",
          coding: "NO_RXNORM_INGREDIENT",
        }),
      ])
    );

    expect(markup).toContain("Every ingredient row is coded or accounted for.");
    expect(markup).not.toContain("read them");
    expect(markup).not.toContain(UNCODED_BADGE);
  });

  it("names the formula's code, version and name", () => {
    const markup = render(compoundOf([ingredient()]));
    expect(markup).toContain("FRM-SYNTH-01");
    expect(markup).toContain("v3");
    expect(markup).toContain("Synthetic Preparation Alfa");
  });
});
