// Compound screening coverage, per recipe row — extracted from the
// order page so the badge wiring is renderable in a test.
//
// The findings panel says WHAT the screen concluded; this says WHICH
// rows it read — and which ones only the pharmacist will ever read,
// the same per-row honesty the allergy panel gives uncoded allergens.
//
// The three badges are a safety vocabulary, not decoration, and the
// dangerous mutation is a QUIET one: swap "asserted non-drug" onto a
// row that was actually screened (or vice versa) and the page still
// renders, still typechecks, and tells the pharmacist a human
// judgement was made where only a machine comparison happened — or
// the reverse. That wiring lives here, in one switch, where a render
// test can hold it.
//
// Recipe data, not PHI: ingredient names and quantities describe the
// preparation, never the patient.

import { Badge } from "../ui/badge.js";
import { Banner } from "../ui/feedback.js";

import type {
  OrderDetailCompoundInfo,
  OrderDetailCompoundIngredient,
} from "../../server/ops/get-order-detail.js";

function ingredientBadge(ingredient: OrderDetailCompoundIngredient) {
  switch (ingredient.coding) {
    case "RXNORM_IN":
      return <Badge tone="success">screened · RXCUI {ingredient.rxnormInRxcui}</Badge>;
    case "NO_RXNORM_INGREDIENT":
      return <Badge tone="neutral">asserted non-drug — base/excipient</Badge>;
    case "UNCODED":
      return <Badge tone="warning">not machine-screened — read this row</Badge>;
    default: {
      // Adding a coding value fails to compile here until someone
      // decides what its badge says. If a value from a newer schema
      // reaches an older binary at runtime, it renders as unscreened —
      // the direction that invites a human to read the row.
      const exhaustive: never = ingredient.coding;
      void exhaustive;
      return <Badge tone="warning">not machine-screened — read this row</Badge>;
    }
  }
}

/**
 * The compound-coverage block of one prescription line. Callers pass
 * the line's `compound` context; a line whose product is not an
 * in-house compound has none and renders nothing of this.
 */
export function CompoundCoveragePanel({
  compound,
}: {
  readonly compound: OrderDetailCompoundInfo;
}) {
  if (compound.formula === null) {
    return (
      <Banner tone="warning" title="Compounded preparation — no active formula linked">
        No published formula claims this compound product, so none of its ingredients were
        machine-screened against the patient&rsquo;s allergies. Screen it by reading the
        preparation&rsquo;s recipe yourself. Linking and coding a formula (a formulary task) closes
        this for every future order.
      </Banner>
    );
  }

  const formula = compound.formula;
  return (
    <div className="space-y-1.5 border-t border-subtle pt-2">
      <p className="text-xs text-subtle">
        Compound formula{" "}
        <code className="font-mono text-muted">
          {formula.formulaCode} v{formula.formulaVersion}
        </code>{" "}
        — {formula.formulaName}.{" "}
        {formula.ingredients.some((i) => i.coding === "UNCODED")
          ? "Rows marked below were NOT machine-screened; read them."
          : "Every ingredient row is coded or accounted for."}
      </p>
      <ul className="space-y-1">
        {formula.ingredients.map((ingredient) => (
          <li key={ingredient.ingredientId} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-fg">{ingredient.ingredientName}</span>
            <span className="font-mono text-xs text-subtle">
              {ingredient.quantity} {ingredient.unit}
            </span>
            {ingredientBadge(ingredient)}
          </li>
        ))}
      </ul>
    </div>
  );
}
