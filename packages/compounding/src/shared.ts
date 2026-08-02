// Shared constants for the compounding domain (ADR-0035).

import { CompoundBudBasis, CompoundPreparationKind } from "@pharmax/database";

// ---------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------

export const COMPOUND_FORMULA_NOT_FOUND = "COMPOUND_FORMULA_NOT_FOUND";
export const COMPOUND_FORMULA_INVALID_STATE = "COMPOUND_FORMULA_INVALID_STATE";
export const COMPOUND_FORMULA_DRAFT_EXISTS = "COMPOUND_FORMULA_DRAFT_EXISTS";
export const COMPOUND_FORMULA_BUD_EXCEEDS_BASIS = "COMPOUND_FORMULA_BUD_EXCEEDS_BASIS";
export const COMPOUND_FORMULA_BUD_REFERENCE_REQUIRED = "COMPOUND_FORMULA_BUD_REFERENCE_REQUIRED";
export const COMPOUND_FORMULA_INGREDIENT_PRODUCT_NOT_FOUND =
  "COMPOUND_FORMULA_INGREDIENT_PRODUCT_NOT_FOUND";
export const COMPOUND_FORMULA_BUD_BASIS_MISMATCH = "COMPOUND_FORMULA_BUD_BASIS_MISMATCH";

// Slice 2 — RecordCompoundingPreparation.
export const COMPOUNDING_ORDER_LINE_NOT_FOUND = "COMPOUNDING_ORDER_LINE_NOT_FOUND";
export const COMPOUNDING_INGREDIENT_MISMATCH = "COMPOUNDING_INGREDIENT_MISMATCH";
export const COMPOUNDING_INGREDIENT_LOT_REQUIRED = "COMPOUNDING_INGREDIENT_LOT_REQUIRED";
export const COMPOUNDING_INGREDIENT_MANUAL_LOT_REQUIRED =
  "COMPOUNDING_INGREDIENT_MANUAL_LOT_REQUIRED";
export const COMPOUNDING_LOT_NOT_FOUND = "COMPOUNDING_LOT_NOT_FOUND";
export const COMPOUNDING_LOT_HELD = "COMPOUNDING_LOT_HELD";
export const COMPOUNDING_LOT_DEPLETED = "COMPOUNDING_LOT_DEPLETED";
export const COMPOUNDING_LOT_EXPIRED = "COMPOUNDING_LOT_EXPIRED";
export const COMPOUNDING_LOT_SITE_MISMATCH = "COMPOUNDING_LOT_SITE_MISMATCH";
export const COMPOUNDING_LOT_PRODUCT_MISMATCH = "COMPOUNDING_LOT_PRODUCT_MISMATCH";
export const COMPOUNDING_HANDLING_NOTES_REQUIRED = "COMPOUNDING_HANDLING_NOTES_REQUIRED";
export const COMPOUNDING_QUALITY_NOTES_REQUIRED = "COMPOUNDING_QUALITY_NOTES_REQUIRED";

// ---------------------------------------------------------------------
// BUD caps (USP <795>, 2023 revision)
// ---------------------------------------------------------------------

/**
 * Hard beyond-use-date ceilings, in days, for the nonsterile bases.
 * These are unconditional chapter limits (USP <795> 2023): nonaqueous
 * 90 days, aqueous preserved 35 days, aqueous nonpreserved 14 days.
 *
 * STABILITY_STUDY has no cap by design: the documented study
 * (required via `budReference`) is the justification.
 */
export const USP_795_BUD_CAPS_DAYS: Partial<Record<CompoundBudBasis, number>> = Object.freeze({
  [CompoundBudBasis.USP795_NONAQUEOUS]: 90,
  [CompoundBudBasis.USP795_AQUEOUS_PRESERVED]: 35,
  [CompoundBudBasis.USP795_AQUEOUS_NONPRESERVED]: 14,
});

/**
 * Outer beyond-use-date bounds, in days, for the USP <797> categories
 * (2023 revision). The chapter's precise limits vary by storage
 * condition AND processing mode (aseptic vs. terminally sterilized,
 * sterility-tested or not), which the formula does not yet model —
 * so we enforce each category's MOST PERMISSIVE table row as a hard
 * ceiling that catches gross errors without rejecting a legitimately
 * justified BUD (ADR-0035 slice-2 amendment #5):
 *
 *   Category 1: hours-scale (12 h room / 24 h refrigerated) → 1 day
 *     is the smallest representable ceiling at day granularity.
 *   Category 2: 45 days (frozen, terminally sterilized).
 *   Category 3: 180 days (frozen, terminally sterilized, full
 *     testing per the chapter).
 */
export const USP_797_BUD_CAPS_DAYS: Partial<Record<CompoundBudBasis, number>> = Object.freeze({
  [CompoundBudBasis.USP797_CATEGORY_1]: 1,
  [CompoundBudBasis.USP797_CATEGORY_2]: 45,
  [CompoundBudBasis.USP797_CATEGORY_3]: 180,
});

/**
 * BUD bases valid for each preparation kind: a NONSTERILE formula must
 * justify its BUD from <795> (or a stability study); a STERILE formula
 * from a <797> category (or a stability study).
 */
export const BUD_BASES_FOR_PREPARATION_KIND: Record<
  CompoundPreparationKind,
  ReadonlySet<CompoundBudBasis>
> = Object.freeze({
  [CompoundPreparationKind.NONSTERILE]: new Set([
    CompoundBudBasis.USP795_NONAQUEOUS,
    CompoundBudBasis.USP795_AQUEOUS_PRESERVED,
    CompoundBudBasis.USP795_AQUEOUS_NONPRESERVED,
    CompoundBudBasis.STABILITY_STUDY,
  ]),
  [CompoundPreparationKind.STERILE]: new Set([
    CompoundBudBasis.USP797_CATEGORY_1,
    CompoundBudBasis.USP797_CATEGORY_2,
    CompoundBudBasis.USP797_CATEGORY_3,
    CompoundBudBasis.STABILITY_STUDY,
  ]),
});

/**
 * Absolute sanity ceiling for any BUD regardless of basis (5 years).
 * Also enforced by the input schema; kept here so slice-2 BUD
 * computation can share the constant.
 */
export const BUD_DAYS_ABSOLUTE_MAX = 1825;
