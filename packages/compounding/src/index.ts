// @pharmax/compounding — the compounding domain (ADR-0035).
//
// Slice 1: Master Formulation Record (USP <795>/<797>) lifecycle.
// Slice 2: compounding records as fill-stage workflow artifacts
// (RecordCompoundingPreparation). Slice 3 adds DSCSA transaction
// records.

export {
  CreateCompoundFormula,
  type CreateCompoundFormulaInput,
  type CreateCompoundFormulaOutput,
} from "./commands/create-compound-formula.js";
export {
  PublishCompoundFormula,
  type PublishCompoundFormulaInput,
  type PublishCompoundFormulaOutput,
} from "./commands/publish-compound-formula.js";
export {
  RetireCompoundFormula,
  type RetireCompoundFormulaInput,
  type RetireCompoundFormulaOutput,
} from "./commands/retire-compound-formula.js";
export {
  RecordCompoundingPreparation,
  type RecordCompoundingPreparationInput,
  type RecordCompoundingPreparationOutput,
} from "./commands/record-compounding-preparation.js";

export {
  BUD_BASES_FOR_PREPARATION_KIND,
  BUD_DAYS_ABSOLUTE_MAX,
  COMPOUND_FORMULA_BUD_BASIS_MISMATCH,
  COMPOUND_FORMULA_BUD_EXCEEDS_BASIS,
  COMPOUND_FORMULA_BUD_REFERENCE_REQUIRED,
  COMPOUND_FORMULA_DRAFT_EXISTS,
  COMPOUND_FORMULA_INGREDIENT_PRODUCT_NOT_FOUND,
  COMPOUND_FORMULA_INVALID_STATE,
  COMPOUND_FORMULA_NOT_FOUND,
  COMPOUNDING_HANDLING_NOTES_REQUIRED,
  COMPOUNDING_INGREDIENT_LOT_REQUIRED,
  COMPOUNDING_INGREDIENT_MANUAL_LOT_REQUIRED,
  COMPOUNDING_INGREDIENT_MISMATCH,
  COMPOUNDING_LOT_DEPLETED,
  COMPOUNDING_LOT_EXPIRED,
  COMPOUNDING_LOT_HELD,
  COMPOUNDING_LOT_NOT_FOUND,
  COMPOUNDING_LOT_PRODUCT_MISMATCH,
  COMPOUNDING_LOT_SITE_MISMATCH,
  COMPOUNDING_ORDER_LINE_NOT_FOUND,
  COMPOUNDING_QUALITY_NOTES_REQUIRED,
  USP_795_BUD_CAPS_DAYS,
  USP_797_BUD_CAPS_DAYS,
} from "./shared.js";
