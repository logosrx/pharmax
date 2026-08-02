// RecordCompoundingPreparation — write the USP <795>/<797> Compounding
// Record at the FILL stage (ADR-0035 slice 2).
//
// A fill-stage activity on a locked order: the actor must hold the
// order in FILL_IN_PROGRESS (same guards as AssignLot, imported from
// @pharmax/fill so both stages reject with identical codes). The
// command:
//
//   1. Pins the ACTIVE formula version (id + denormalized code/version,
//      like VerificationRecord pins its policy).
//   2. Requires the consumption list to cover the formula's ingredient
//      list EXACTLY — every ingredient once, nothing extra.
//   3. Guards each product-backed ingredient lot exactly like AssignLot
//      (in-org, same site, ACTIVE, unexpired, right product) and writes
//      a COMPOUND_CONSUMED inventory transaction per consumption. Bulk
//      chemicals without a catalog row record a manual lot number
//      (+ optional expiration) instead — USP requires every
//      component's source lot to be documented.
//   4. Computes the BUD: preparedAt + formula.budDays, clamped to the
//      EARLIEST expiration among consumed lots and manual expirations
//      (the BUD never exceeds a component's expiration).
//   5. Requires handling documentation for hazardous formulas
//      (USP <800>) and notes on any FAIL quality outcome.
//   6. Renders the human-readable record document and stores it in-row
//      with its sha-256 (PrintJob.renderedZpl precedent) — atomic with
//      the record, RLS-protected, never logged or emitted.
//
// The finished preparation itself keeps being modeled as a Product +
// Lot (ADR-0035 slice-2 amendment #1): AssignLot / CompleteFill guards
// are unchanged; this record is the ingredient-side traceability
// behind that finished lot.

import { createHash, randomUUID } from "node:crypto";

import { defineCommand, ORDER_VERSION_MISMATCH } from "@pharmax/command-bus";
import {
  CompoundFormulaStatus,
  CompoundingQualityOutcome,
  InventoryTransactionReason,
  LotStatus,
  Prisma,
} from "@pharmax/database";
import { assertFillAssignee, assertFillInProgressWithAssignee } from "@pharmax/fill";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

import {
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
} from "../shared.js";

// ---------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------

const consumptionSchema = z
  .object({
    formulaIngredientId: z.uuid(),
    /** Required for product-backed ingredients (enforced in-handler,
     *  where the formula is known). */
    lotId: z.uuid().optional(),
    /** Required for ingredients WITHOUT a catalog product. */
    manualLotNumber: z.string().min(1).max(120).optional(),
    manualExpirationDate: z.iso.date().optional(),
    /** Actual quantity consumed (may differ from the per-unit recipe
     *  quantity — batches scale). */
    quantity: z.coerce
      .number()
      .positive()
      .refine((n) => Number.isFinite(n), "must be finite"),
  })
  .strict();

const inputSchema = z
  .object({
    orderId: z.uuid(),
    orderLineId: z.uuid(),
    formulaId: z.uuid(),
    consumptions: z.array(consumptionSchema).min(1).max(50),
    /** USP <800> containment/PPE documentation; required when the
     *  formula is hazardous (enforced in-handler). */
    handlingNotes: z.string().min(1).max(5000).optional(),
    qualityOutcome: z.enum(CompoundingQualityOutcome),
    /** Required when qualityOutcome is FAIL (every failure carries a
     *  reason). */
    qualityNotes: z.string().min(1).max(5000).optional(),
  })
  .strict();

export type RecordCompoundingPreparationInput = z.infer<typeof inputSchema>;

export interface RecordCompoundingPreparationOutput {
  readonly compoundingRecordId: string;
  readonly orderId: string;
  readonly orderLineId: string;
  readonly formulaId: string;
  readonly formulaCode: string;
  readonly formulaVersion: number;
  readonly budAt: string;
  readonly qualityOutcome: CompoundingQualityOutcome;
  readonly version: number;
}

// ---------------------------------------------------------------------
// Rendered document
// ---------------------------------------------------------------------

interface RenderedIngredientLine {
  readonly sortOrder: number;
  readonly ingredientName: string;
  readonly lotLabel: string;
  readonly expirationLabel: string;
  readonly quantityLabel: string;
}

function renderCompoundingRecordDocument(input: {
  readonly recordId: string;
  readonly organizationId: string;
  readonly orderId: string;
  readonly orderLineId: string;
  readonly rxNumber: string;
  readonly formulaCode: string;
  readonly formulaVersion: number;
  readonly formulaName: string;
  readonly preparationKind: string;
  readonly storageCondition: string;
  readonly hazardous: boolean;
  readonly preparedByUserId: string;
  readonly preparedAt: Date;
  readonly budAt: Date;
  readonly ingredients: ReadonlyArray<RenderedIngredientLine>;
  readonly qualityOutcome: CompoundingQualityOutcome;
  readonly qualityNotes: string | undefined;
  readonly handlingNotes: string | undefined;
}): string {
  const lines: string[] = [
    "# Compounding Record",
    "",
    `Record ID: ${input.recordId}`,
    `Organization: ${input.organizationId}`,
    `Order: ${input.orderId}`,
    `Order line: ${input.orderLineId}`,
    `Rx number: ${input.rxNumber}`,
    "",
    `Master Formulation Record: ${input.formulaCode} v${input.formulaVersion} — ${input.formulaName}`,
    `Preparation kind: ${input.preparationKind}`,
    `Storage condition: ${input.storageCondition}`,
    `Hazardous (USP <800>): ${input.hazardous ? "YES" : "no"}`,
    "",
    `Prepared by (user): ${input.preparedByUserId}`,
    `Prepared at: ${input.preparedAt.toISOString()}`,
    `Beyond-use date: ${input.budAt.toISOString()}`,
    "",
    "## Components",
    "",
  ];
  for (const ingredient of input.ingredients) {
    lines.push(
      `${ingredient.sortOrder + 1}. ${ingredient.ingredientName} — lot ${ingredient.lotLabel}, expires ${ingredient.expirationLabel}, quantity ${ingredient.quantityLabel}`
    );
  }
  lines.push("", "## Quality control", "", `Outcome: ${input.qualityOutcome}`);
  if (input.qualityNotes !== undefined) {
    lines.push(`Notes: ${input.qualityNotes}`);
  }
  if (input.hazardous) {
    lines.push("", "## Hazardous-drug handling (USP <800>)", "", input.handlingNotes ?? "");
  }
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------

export const RecordCompoundingPreparation = defineCommand<
  RecordCompoundingPreparationInput,
  RecordCompoundingPreparationOutput
>({
  name: "RecordCompoundingPreparation",
  inputSchema,
  permission: PERMISSIONS.COMPOUNDING_PREPARE,
  lockTarget: { table: "order", by: (input) => ({ id: input.orderId }) },
  loadPolicy: { from: "target" },
  // Free-text fields could carry incidental clinical detail; keep them
  // out of the command_log input snapshot.
  redactFields: ["handlingNotes", "qualityNotes"],

  async exec({ tx, ctx, input, target, policy, clock, commandLogId }) {
    if (target === undefined || policy === undefined) {
      throw new errors.InternalError({
        code: "RECORD_COMPOUNDING_PREPARATION_INTERNAL",
        message: "RecordCompoundingPreparation missing locked target or policy.",
      });
    }

    assertFillInProgressWithAssignee({ target, ctx });
    await assertFillAssignee({ tx, target, ctx });

    const orderLine = await tx.orderLine.findFirst({
      where: {
        id: input.orderLineId,
        orderId: target.id,
        organizationId: ctx.organizationId,
      },
      select: {
        id: true,
        prescription: { select: { rxNumber: true } },
      },
    });
    if (orderLine === null) {
      throw new errors.NotFoundError({
        code: COMPOUNDING_ORDER_LINE_NOT_FOUND,
        message: "Order line not found on this order.",
        metadata: { orderId: target.id, orderLineId: input.orderLineId },
      });
    }

    const formula = await tx.compoundFormula.findFirst({
      where: { id: input.formulaId, organizationId: ctx.organizationId },
      include: { ingredients: { orderBy: { sortOrder: "asc" } } },
    });
    if (formula === null) {
      throw new errors.NotFoundError({
        code: COMPOUND_FORMULA_NOT_FOUND,
        message: "Compound formula not found.",
        metadata: { formulaId: input.formulaId },
      });
    }
    if (formula.status !== CompoundFormulaStatus.ACTIVE) {
      throw new errors.ConflictError({
        code: COMPOUND_FORMULA_INVALID_STATE,
        message: "Preparations may only be recorded against an ACTIVE formula version.",
        metadata: { formulaId: formula.id, status: formula.status },
      });
    }

    if (formula.hazardous && input.handlingNotes === undefined) {
      throw new errors.ValidationError({
        code: COMPOUNDING_HANDLING_NOTES_REQUIRED,
        message:
          "handlingNotes (USP <800> containment/PPE documentation) is required for a hazardous formula.",
        metadata: { formulaId: formula.id },
      });
    }
    if (
      input.qualityOutcome === CompoundingQualityOutcome.FAIL &&
      input.qualityNotes === undefined
    ) {
      throw new errors.ValidationError({
        code: COMPOUNDING_QUALITY_NOTES_REQUIRED,
        message: "qualityNotes is required when the quality outcome is FAIL.",
        metadata: { formulaId: formula.id },
      });
    }

    // The consumption list must cover the recipe exactly: every
    // formula ingredient consumed once, nothing that isn't in the
    // recipe. A preparation that deviates from the MFR is a formula
    // change, not a data-entry variant.
    const ingredientById = new Map(formula.ingredients.map((i) => [i.id, i]));
    const consumedIds = input.consumptions.map((c) => c.formulaIngredientId);
    const missing = formula.ingredients.filter((i) => !consumedIds.includes(i.id)).map((i) => i.id);
    const unknownOrDuplicate = consumedIds.filter(
      (id, index) => !ingredientById.has(id) || consumedIds.indexOf(id) !== index
    );
    if (missing.length > 0 || unknownOrDuplicate.length > 0) {
      throw new errors.ValidationError({
        code: COMPOUNDING_INGREDIENT_MISMATCH,
        message:
          "Consumptions must cover the formula's ingredient list exactly (every ingredient once).",
        metadata: {
          formulaId: formula.id,
          missingFormulaIngredientIds: missing,
          unknownOrDuplicateFormulaIngredientIds: unknownOrDuplicate,
        },
      });
    }

    const now = clock.now();
    const todayDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    // Validate each consumption; collect expirations for the BUD clamp
    // and the rows/ledger entries to write.
    const expirationBounds: Date[] = [];
    const consumedLotIds: string[] = [];
    const ingredientRows: Array<{
      formulaIngredientId: string;
      ingredientName: string;
      lotId: string | null;
      manualLotNumber: string | null;
      manualExpirationDate: Date | null;
      quantity: number;
      unit: string;
      sortOrder: number;
      lotLabel: string;
      expirationLabel: string;
    }> = [];

    for (const consumption of input.consumptions) {
      const ingredient = ingredientById.get(consumption.formulaIngredientId);
      if (ingredient === undefined) {
        // Unreachable after the mismatch guard; keeps the type narrow.
        throw new errors.InternalError({
          code: "RECORD_COMPOUNDING_PREPARATION_INTERNAL",
          message: "Consumption references an ingredient that passed the mismatch guard.",
        });
      }

      if (ingredient.productId !== null) {
        // Product-backed: the actual Lot must be identified and pass
        // the same guards AssignLot applies to dispensed lots.
        if (consumption.lotId === undefined) {
          throw new errors.ValidationError({
            code: COMPOUNDING_INGREDIENT_LOT_REQUIRED,
            message: "A lotId is required for a product-backed ingredient.",
            metadata: { formulaIngredientId: ingredient.id },
          });
        }
        const lot = await tx.lot.findFirst({
          where: { id: consumption.lotId, organizationId: ctx.organizationId },
          select: {
            id: true,
            siteId: true,
            productId: true,
            lotNumber: true,
            expirationDate: true,
            status: true,
          },
        });
        if (lot === null) {
          throw new errors.NotFoundError({
            code: COMPOUNDING_LOT_NOT_FOUND,
            message: "Ingredient lot not found.",
            metadata: { formulaIngredientId: ingredient.id, lotId: consumption.lotId },
          });
        }
        if (lot.siteId !== target.siteId) {
          throw new errors.ConflictError({
            code: COMPOUNDING_LOT_SITE_MISMATCH,
            message: "Ingredient lot belongs to a different pharmacy site than the order.",
            metadata: { lotId: lot.id, lotSiteId: lot.siteId, orderSiteId: target.siteId },
          });
        }
        switch (lot.status) {
          case LotStatus.ACTIVE:
            break;
          case LotStatus.ON_HOLD:
            throw new errors.ConflictError({
              code: COMPOUNDING_LOT_HELD,
              message: "Held lots cannot be consumed by a preparation.",
              metadata: { lotId: lot.id, status: lot.status },
            });
          case LotStatus.DEPLETED:
            throw new errors.ConflictError({
              code: COMPOUNDING_LOT_DEPLETED,
              message: "Depleted lots cannot be consumed by a preparation.",
              metadata: { lotId: lot.id, status: lot.status },
            });
          default: {
            const exhaustive: never = lot.status;
            throw new errors.InternalError({
              code: "LOT_STATUS_UNHANDLED",
              message: `Unhandled lot status: ${String(exhaustive)}`,
            });
          }
        }
        if (lot.expirationDate < todayDate) {
          throw new errors.ConflictError({
            code: COMPOUNDING_LOT_EXPIRED,
            message: "Expired lots cannot be consumed by a preparation.",
            metadata: {
              lotId: lot.id,
              expirationDate: lot.expirationDate.toISOString().slice(0, 10),
            },
          });
        }
        if (lot.productId !== ingredient.productId) {
          throw new errors.ConflictError({
            code: COMPOUNDING_LOT_PRODUCT_MISMATCH,
            message: "Ingredient lot is a different product than the formula ingredient.",
            metadata: {
              formulaIngredientId: ingredient.id,
              expectedProductId: ingredient.productId,
              lotId: lot.id,
              lotProductId: lot.productId,
            },
          });
        }

        expirationBounds.push(lot.expirationDate);
        consumedLotIds.push(lot.id);
        ingredientRows.push({
          formulaIngredientId: ingredient.id,
          ingredientName: ingredient.ingredientName,
          lotId: lot.id,
          manualLotNumber: null,
          manualExpirationDate: null,
          quantity: consumption.quantity,
          unit: ingredient.unit,
          sortOrder: ingredient.sortOrder,
          lotLabel: lot.lotNumber,
          expirationLabel: lot.expirationDate.toISOString().slice(0, 10),
        });
      } else {
        // Bulk chemical without a catalog row: the source lot must
        // still be documented (USP component-documentation rule).
        if (consumption.manualLotNumber === undefined) {
          throw new errors.ValidationError({
            code: COMPOUNDING_INGREDIENT_MANUAL_LOT_REQUIRED,
            message: "manualLotNumber is required for an ingredient without a catalog product.",
            metadata: { formulaIngredientId: ingredient.id },
          });
        }
        let manualExpiration: Date | null = null;
        if (consumption.manualExpirationDate !== undefined) {
          manualExpiration = new Date(`${consumption.manualExpirationDate}T00:00:00.000Z`);
          if (manualExpiration < todayDate) {
            throw new errors.ConflictError({
              code: COMPOUNDING_LOT_EXPIRED,
              message: "An expired component cannot be consumed by a preparation.",
              metadata: {
                formulaIngredientId: ingredient.id,
                expirationDate: consumption.manualExpirationDate,
              },
            });
          }
          expirationBounds.push(manualExpiration);
        }
        ingredientRows.push({
          formulaIngredientId: ingredient.id,
          ingredientName: ingredient.ingredientName,
          lotId: null,
          manualLotNumber: consumption.manualLotNumber,
          manualExpirationDate: manualExpiration,
          quantity: consumption.quantity,
          unit: ingredient.unit,
          sortOrder: ingredient.sortOrder,
          lotLabel: consumption.manualLotNumber,
          expirationLabel: consumption.manualExpirationDate ?? "not recorded",
        });
      }
    }

    // BUD: preparedAt + budDays, clamped to the earliest component
    // expiration. Every guard above already rejected expired
    // components, so the clamp can only shorten, never invert.
    let budAt = new Date(now.getTime() + formula.budDays * 24 * 60 * 60 * 1000);
    for (const bound of expirationBounds) {
      if (bound < budAt) {
        budAt = bound;
      }
    }

    // Inventory ledger: one deduction per consumed lot.
    for (const row of ingredientRows) {
      if (row.lotId !== null) {
        await tx.inventoryTransaction.create({
          data: {
            organizationId: ctx.organizationId,
            lotId: row.lotId,
            orderLineId: orderLine.id,
            quantityDelta: new Prisma.Decimal(row.quantity).mul(-1),
            reason: InventoryTransactionReason.COMPOUND_CONSUMED,
            commandLogId,
          },
        });
      }
    }

    const recordId = randomUUID();
    ingredientRows.sort((a, b) => a.sortOrder - b.sortOrder);
    const renderedDocument = renderCompoundingRecordDocument({
      recordId,
      organizationId: ctx.organizationId,
      orderId: target.id,
      orderLineId: orderLine.id,
      rxNumber: orderLine.prescription.rxNumber,
      formulaCode: formula.code,
      formulaVersion: formula.version,
      formulaName: formula.name,
      preparationKind: formula.preparationKind,
      storageCondition: formula.storageCondition,
      hazardous: formula.hazardous,
      preparedByUserId: ctx.actor.userId,
      preparedAt: now,
      budAt,
      ingredients: ingredientRows.map((row) => ({
        sortOrder: row.sortOrder,
        ingredientName: row.ingredientName,
        lotLabel: row.lotLabel,
        expirationLabel: row.expirationLabel,
        quantityLabel: `${row.quantity} ${row.unit}`,
      })),
      qualityOutcome: input.qualityOutcome,
      qualityNotes: input.qualityNotes,
      handlingNotes: input.handlingNotes,
    });
    const documentSha256 = createHash("sha256").update(renderedDocument, "utf8").digest();

    await tx.compoundingRecord.create({
      data: {
        id: recordId,
        organizationId: ctx.organizationId,
        orderId: target.id,
        orderLineId: orderLine.id,
        formulaId: formula.id,
        formulaCode: formula.code,
        formulaVersion: formula.version,
        preparedByUserId: ctx.actor.userId,
        preparedAt: now,
        budAt,
        storageCondition: formula.storageCondition,
        hazardous: formula.hazardous,
        ...(input.handlingNotes === undefined ? {} : { handlingNotes: input.handlingNotes }),
        qualityOutcome: input.qualityOutcome,
        ...(input.qualityNotes === undefined ? {} : { qualityNotes: input.qualityNotes }),
        workflowPolicyId: target.workflowPolicyId,
        workflowPolicyVersion: target.workflowPolicyVersion,
        renderedDocument,
        documentSha256,
        commandLogId,
      },
    });

    await tx.compoundingRecordIngredient.createMany({
      data: ingredientRows.map((row) => ({
        organizationId: ctx.organizationId,
        recordId,
        formulaIngredientId: row.formulaIngredientId,
        ingredientName: row.ingredientName,
        ...(row.lotId === null ? {} : { lotId: row.lotId }),
        ...(row.manualLotNumber === null ? {} : { manualLotNumber: row.manualLotNumber }),
        ...(row.manualExpirationDate === null
          ? {}
          : { manualExpirationDate: row.manualExpirationDate }),
        quantity: new Prisma.Decimal(row.quantity),
        unit: row.unit,
        sortOrder: row.sortOrder,
      })),
    });

    const fromVersion = target.version;
    const toVersion = target.version + 1;

    return {
      output: {
        compoundingRecordId: recordId,
        orderId: target.id,
        orderLineId: orderLine.id,
        formulaId: formula.id,
        formulaCode: formula.code,
        formulaVersion: formula.version,
        budAt: budAt.toISOString(),
        qualityOutcome: input.qualityOutcome,
        version: toVersion,
      },
      targetOrderId: target.id,
      bumpVersion: { from: fromVersion, to: toVersion },
      audit: {
        action: "compounding.preparation.recorded",
        resourceType: "CompoundingRecord",
        resourceId: recordId,
        // No free-text notes and no rendered document here — ids and
        // recipe identity only.
        metadata: {
          orderId: target.id,
          orderLineId: orderLine.id,
          formulaId: formula.id,
          formulaCode: formula.code,
          formulaVersion: formula.version,
          budAt: budAt.toISOString(),
          qualityOutcome: input.qualityOutcome,
          hazardous: formula.hazardous,
          ingredientCount: ingredientRows.length,
          consumedLotIds,
          documentSha256Hex: documentSha256.toString("hex"),
          workflowPolicyId: target.workflowPolicyId,
          workflowPolicyVersion: target.workflowPolicyVersion,
          commandLogId,
        },
      },
      emits: [
        {
          eventType: "compounding.preparation.recorded.v1",
          aggregateType: "CompoundingRecord",
          aggregateId: recordId,
          payload: {
            compoundingRecordId: recordId,
            organizationId: ctx.organizationId,
            orderId: target.id,
            orderLineId: orderLine.id,
            formulaId: formula.id,
            formulaCode: formula.code,
            formulaVersion: formula.version,
            preparedByUserId: ctx.actor.userId,
            budAt: budAt.toISOString(),
            qualityOutcome: input.qualityOutcome,
            hazardous: formula.hazardous,
            consumedLotIds,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
});

export { ORDER_VERSION_MISMATCH };
