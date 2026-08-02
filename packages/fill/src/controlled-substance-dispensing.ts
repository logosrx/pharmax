// Part 1306 enforcement at the dispensing moment (ADR-0037
// commitment 1).
//
// `CompleteFill` is where a controlled substance actually leaves the
// pharmacy, so it is where the DEA dispensing rules have to bite.
// Enforcing them at order intake instead would be theatre: an order can
// sit for days, refills accrue, and the earliest-fill and six-month
// clocks are all evaluated against the moment of supply.
//
// This module does the impure half — read the ledger, derive the fill
// ordinal, write the row. The rules themselves stay pure in
// `@pharmax/controlled-substances`.

import {
  evaluateDispensing,
  isControlled,
  type ControlledPrescriptionSnapshot,
  type DispensingViolation,
  type PartialFillBasis,
} from "@pharmax/controlled-substances";
import type { ControlledSubstanceSchedule, Prisma } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";

/** A controlled substance may not be dispensed on these facts. */
export const FILL_CONTROLLED_SUBSTANCE_NOT_PERMITTED = "FILL_CONTROLLED_SUBSTANCE_NOT_PERMITTED";
/** Supplying less than the authorized quantity requires a stated basis. */
export const FILL_PARTIAL_FILL_BASIS_REQUIRED = "FILL_PARTIAL_FILL_BASIS_REQUIRED";
/** A partial-fill basis was declared for a line that cannot carry one. */
export const FILL_PARTIAL_FILL_BASIS_UNEXPECTED = "FILL_PARTIAL_FILL_BASIS_UNEXPECTED";

export interface DispensingLine {
  readonly orderLineId: string;
  readonly clinicId: string;
  readonly quantityToFill: number;
  readonly prescriptionId: string;
  readonly prescription: ControlledPrescriptionSnapshot;
}

export interface ControlledSubstanceDispensingRow {
  readonly orderLineId: string;
  readonly clinicId: string;
  readonly prescriptionId: string;
  readonly schedule: ControlledSubstanceSchedule;
  readonly fillNumber: number;
  readonly quantityDispensed: number;
  readonly partialFillBasis: PartialFillBasis | null;
}

export interface EvaluateFillDispensingArgs {
  readonly tx: Prisma.TransactionClient;
  readonly organizationId: string;
  readonly orderId: string;
  readonly lines: ReadonlyArray<DispensingLine>;
  /** Operator-declared partial-fill basis, keyed by order line. */
  readonly declaredBases: ReadonlyMap<string, PartialFillBasis>;
  readonly now: Date;
}

/**
 * Evaluate every controlled line on the order and return the ledger
 * rows to write. Throws a ConflictError on the first line that may not
 * be dispensed — with EVERY violation for that line in the metadata, so
 * a pharmacist sees the full reason rather than one per attempt.
 *
 * Non-controlled lines are returned as nothing: the ledger stays small,
 * and a row's mere existence means a controlled substance was supplied.
 */
export async function evaluateFillDispensing(
  args: EvaluateFillDispensingArgs
): Promise<ReadonlyArray<ControlledSubstanceDispensingRow>> {
  const { tx, organizationId, orderId, lines, declaredBases, now } = args;

  const controlledLines = lines.filter((line) => isControlled(line.prescription.schedule));

  // A basis on a non-controlled line means the operator misidentified
  // the drug or the UI sent the wrong line id. Either way, silently
  // dropping it would hide a real mistake.
  const controlledLineIds = new Set(controlledLines.map((line) => line.orderLineId));
  for (const orderLineId of declaredBases.keys()) {
    if (!controlledLineIds.has(orderLineId)) {
      throw new errors.ConflictError({
        code: FILL_PARTIAL_FILL_BASIS_UNEXPECTED,
        message:
          "A partial-fill basis was declared for a line that is not a controlled substance on this order.",
        metadata: { orderId, orderLineId },
      });
    }
  }

  if (controlledLines.length === 0) return [];

  const rows: ControlledSubstanceDispensingRow[] = [];

  for (const line of controlledLines) {
    // Prior dispensings for this prescription, EXCLUDING this order
    // line. The exclusion matters: if the order was reworked and
    // CompleteFill runs again, the line's own earlier row must not be
    // read as a prior fill, or a re-verification would look like a
    // refill and be rejected.
    const priorRows = await tx.controlledSubstanceDispensing.findMany({
      where: {
        organizationId,
        prescriptionId: line.prescriptionId,
        orderLineId: { not: line.orderLineId },
      },
      orderBy: [{ fillNumber: "asc" }, { dispensedAt: "asc" }],
      select: {
        fillNumber: true,
        quantityDispensed: true,
        partialFillBasis: true,
        dispensedAt: true,
      },
    });

    const declaredBasis = declaredBases.get(line.orderLineId) ?? null;
    const authorized = line.prescription.quantityAuthorized;

    const latestFillNumber = priorRows.reduce((max, row) => Math.max(max, row.fillNumber), 0);
    const latestFillRows = priorRows.filter((row) => row.fillNumber === latestFillNumber);
    const quantityInLatestFill = latestFillRows.reduce(
      (sum, row) => sum + row.quantityDispensed.toNumber(),
      0
    );

    // The previous fill is still OPEN — and so this dispensing can
    // complete it rather than starting a new one — only when it was
    // itself partial and has not yet reached the authorized quantity.
    // Requiring a declared basis here too keeps the operator's
    // intention explicit: continuing a partial fill and starting a
    // refill are different regulatory acts and must not be inferred.
    const previousFillIsOpen =
      latestFillNumber > 0 &&
      quantityInLatestFill < authorized &&
      latestFillRows.some((row) => row.partialFillBasis !== null);
    const isContinuation = declaredBasis !== null && previousFillIsOpen;

    const fillNumber = isContinuation ? latestFillNumber : latestFillNumber + 1;
    const quantityDispensedInFill = isContinuation ? quantityInLatestFill : 0;
    const firstPartialFillAt = isContinuation ? (latestFillRows[0]?.dispensedAt ?? null) : null;

    // Supplying less than the prescription authorizes IS a partial
    // fill, whatever it is called. Part 1306 permits it only on a
    // stated basis, and the basis determines the completion window, so
    // it cannot be inferred after the fact.
    if (declaredBasis === null && quantityDispensedInFill + line.quantityToFill < authorized) {
      throw new errors.ConflictError({
        code: FILL_PARTIAL_FILL_BASIS_REQUIRED,
        message:
          "This dispensing supplies less than the authorized quantity. Record the basis for the partial fill before completing.",
        metadata: {
          orderId,
          orderLineId: line.orderLineId,
          schedule: line.prescription.schedule,
          quantityToFill: line.quantityToFill,
          quantityAuthorized: authorized,
        },
      });
    }

    const evaluation = evaluateDispensing({
      prescription: line.prescription,
      fillNumber,
      quantityDispensedInFill,
      quantityToFill: line.quantityToFill,
      firstPartialFillAt,
      partialFillBasis: declaredBasis,
      asOf: now,
    });

    if (!evaluation.ok) {
      throw new errors.ConflictError({
        code: FILL_CONTROLLED_SUBSTANCE_NOT_PERMITTED,
        message: summarizeViolations(evaluation.violations),
        metadata: {
          orderId,
          orderLineId: line.orderLineId,
          schedule: line.prescription.schedule,
          fillNumber,
          violations: evaluation.violations.map((violation) => ({
            code: violation.code,
            citation: violation.citation,
            reason: violation.reason,
          })),
        },
      });
    }

    rows.push({
      orderLineId: line.orderLineId,
      clinicId: line.clinicId,
      prescriptionId: line.prescriptionId,
      schedule: line.prescription.schedule,
      fillNumber,
      quantityDispensed: line.quantityToFill,
      partialFillBasis: declaredBasis,
    });
  }

  return rows;
}

function summarizeViolations(violations: ReadonlyArray<DispensingViolation>): string {
  return violations.map((violation) => `${violation.reason} (${violation.citation})`).join(" ");
}
