// Reading a prescription's structured sig for a PV1 screen, and
// answering the question that decides whether the dose axis runs for
// that line.
//
// The dose analogue of `allergy-input.ts`, with one structural
// difference that changes everything downstream: an allergy is a fact
// about the PATIENT, resolved once per order, while a dose is a fact
// about one PRESCRIPTION LINE — a two-line order can carry one
// structured sig and one legacy free-text sig, and the two lines'
// screens must say different things. So the functions here are pure
// per-row mappings the wiring layer applies per candidate, not probes
// over the database; the row was already loaded by `run-screen.ts`
// inside the command's transaction.
//
// =====================================================================
// THE TWO STATES, AND WHY THE ABSENT ONE IS GRADED THE WAY IT IS
// =====================================================================
//
//   1. `sigStructureKind` non-null → AVAILABLE. The transcriptionist
//      structured the sig, and what the engine gets depends on the
//      kind — see `doseStatementFor`. A structured PRN or taper with
//      no captured numbers is AVAILABLE with a null `DoseStatement`:
//      "structured, and honestly numberless" is an answer, not a gap.
//   2. `sigStructureKind` null → NOT_CAPTURED_FOR_RECORD. Not
//      NOT_RECORDED_FOR_SUBJECT, and the difference is the design
//      decision of this slice: a structured sig can only be captured
//      at transcription, prescriptions are immutable once written,
//      and there is no amend command — so "go and obtain it", the
//      instruction the acknowledge-tier gap carries, is one nobody on
//      the order can follow. The gap is recorded (every screen says
//      the dose axis did not run for this line, under
//      remediation=RECORD_IMMUTABLE) and does not interrupt: on the
//      day this ships EVERY existing prescription is unstructured,
//      and an acknowledgement per order for a fact nobody can change
//      is the machine #86 dismantled. The population drains by
//      itself — prescriptions expire within a year, and new
//      transcriptions capture the structure.
//
// =====================================================================
// WHAT THE ENGINE IS TOLD PER KIND
// =====================================================================
//
// The engine's `DoseStatement` carries a `basis` that decides which
// checks run and how findings are worded (see the engine's own docs):
//
//   FIXED  → SCHEDULED. The numbers are the regimen; every check
//            runs, including the sub-therapeutic minimum.
//   PRN    → MAXIMUM_PERMITTED when a per-dose amount was captured
//            (dosesPerDay, when present, is the prescriber's stated
//            daily ceiling; absent → 0, which skips the daily
//            arithmetic). A bare PRN maps to null.
//   RANGE  → MAXIMUM_PERMITTED over the range's UPPER end — the
//            safety-relevant bound of "1–2 tablets".
//   TAPER  → MAXIMUM_PERMITTED over the captured peak step, when the
//            transcriptionist summarized one; a bare TAPER maps to
//            null. A taper has no single daily dose, and inventing
//            one would screen a fiction.
//
// PHI: the columns read are the coded dose columns and the structure
// kind — never `sigEnc`. Values reach the engine, whose findings
// carry codes, limits and magnitudes but no narrative and no patient
// identifier. Nothing here is logged.

import type { DoseStatement, ScreeningInputAvailability } from "@pharmax/clinical-screening";
import type { DoseUnit, Prisma, SigStructureKind } from "@pharmax/database";

/**
 * The structured-sig columns of one prescription row, as
 * `run-screen.ts` selects them. Decimals arrive as Prisma `Decimal`.
 */
export interface StructuredSigRow {
  readonly sigStructureKind: SigStructureKind | null;
  readonly doseAmount: Prisma.Decimal | null;
  readonly doseUnit: DoseUnit | null;
  readonly dosesPerDay: Prisma.Decimal | null;
}

/**
 * The unit token the engine compares against a knowledge source's
 * `DoseRange.unit`. The schema's bounded `DoseUnit` enum, lowercased —
 * "MG" → "mg" — matching the conventional pharmacy spelling and the
 * spelling every seeded test source uses. An adapter over licensed
 * dosing content MUST normalize its units onto these tokens; a unit
 * it cannot normalize should be left verbatim so the engine reports
 * `SCR_DOSE_UNIT_NOT_COMPARABLE` instead of guessing a conversion.
 */
export function doseUnitToken(unit: DoseUnit): string {
  return unit.toLowerCase();
}

/**
 * Whether the DOSE_RANGE axis can be declared AVAILABLE for one
 * prescription line. The per-record policy behind
 * `SCREENING_AXIS_CAPABILITY.DOSE_RANGE`; see the header for why the
 * absent case is NOT_CAPTURED_FOR_RECORD and what that grades.
 */
export function doseInputAvailabilityFor(row: StructuredSigRow): ScreeningInputAvailability {
  return row.sigStructureKind === null ? "NOT_CAPTURED_FOR_RECORD" : "AVAILABLE";
}

/**
 * The `DoseStatement` one prescription line contributes, or null for
 * a line that carries no comparable numbers — which is either "not
 * structured at all" (the caller must ALSO declare the axis
 * NOT_CAPTURED_FOR_RECORD, or the engine would read silence as "no
 * dose to compare") or a structured-but-numberless PRN/TAPER, where
 * null under an AVAILABLE axis is exactly the honest answer.
 *
 * `Decimal.toNumber()` is safe here: the columns are bounded at
 * DECIMAL(12,4) and DECIMAL(8,4), well inside double precision, and
 * the engine compares with a relative tolerance in any case.
 */
export function doseStatementFor(row: StructuredSigRow): DoseStatement | null {
  const kind = row.sigStructureKind;
  if (kind === null) return null;

  // The shape constraint `prescription_structured_sig_shape`
  // guarantees amount and unit travel together and that FIXED/RANGE
  // carry all three values; these guards restate it so a row that
  // somehow violated it degrades to "nothing to compare" rather than
  // to a half-read dose.
  if (row.doseAmount === null || row.doseUnit === null) return null;

  const amount = row.doseAmount.toNumber();
  const unit = doseUnitToken(row.doseUnit);
  const dosesPerDay = row.dosesPerDay === null ? 0 : row.dosesPerDay.toNumber();

  switch (kind) {
    case "FIXED":
      return { amount, unit, dosesPerDay, basis: "SCHEDULED" };
    case "PRN":
    case "RANGE":
    case "TAPER":
      return { amount, unit, dosesPerDay, basis: "MAXIMUM_PERMITTED" };
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}
