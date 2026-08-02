// CreateCompoundFormula — draft a new Master Formulation Record
// version (ADR-0035, USP <795>/<797>).
//
// Creates version 1 of a new code, or the next version of an existing
// code. The new version is always born DRAFT; nothing about drafting
// affects the currently ACTIVE version (publish does the supersede).
//
// Concurrency: the partial UNIQUE index "one DRAFT per (org, code)"
// serializes concurrent drafts — the second writer gets a typed
// conflict, not a torn aggregate. Version numbering reads
// MAX(version)+1 inside the same transaction; a concurrent create of
// the SAME code is excluded by the draft constraint, and creates of
// different codes don't contend.
//
// BUD validation (the part USP actually caps):
//   - The basis must match the preparation kind: NONSTERILE justifies
//     from <795>, STERILE from a <797> category; STABILITY_STUDY is
//     valid for both.
//   - USP795_* bases are validated against the chapter's hard day
//     ceilings (nonaqueous 90 / aqueous preserved 35 / aqueous
//     nonpreserved 14).
//   - USP797_* categories are validated against each category's OUTER
//     bound (1 / 45 / 180 days) — the per-storage/per-processing-mode
//     table needs fields the formula doesn't model yet (ADR-0035
//     slice-2 amendment #5).
//   - STABILITY_STUDY requires `budReference` (the documented study).
//
// No PHI anywhere: formulas are recipes. The full ingredient list is
// intentionally kept OUT of audit metadata and the outbox payload —
// consumers that need the recipe read the aggregate; the event is an
// identity signal.

import { randomUUID } from "node:crypto";

import type { Command, HandlerResult } from "@pharmax/command-bus";
import {
  CompoundBudBasis,
  CompoundFormulaStatus,
  CompoundPreparationKind,
  CompoundStorageCondition,
  Prisma,
} from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

import {
  BUD_BASES_FOR_PREPARATION_KIND,
  BUD_DAYS_ABSOLUTE_MAX,
  COMPOUND_FORMULA_BUD_BASIS_MISMATCH,
  COMPOUND_FORMULA_BUD_EXCEEDS_BASIS,
  COMPOUND_FORMULA_BUD_REFERENCE_REQUIRED,
  COMPOUND_FORMULA_DRAFT_EXISTS,
  COMPOUND_FORMULA_INGREDIENT_PRODUCT_NOT_FOUND,
  USP_795_BUD_CAPS_DAYS,
  USP_797_BUD_CAPS_DAYS,
} from "../shared.js";

// ---------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------

const ingredientSchema = z
  .object({
    /** Set when the ingredient is a stocked catalog product. */
    productId: z.uuid().optional(),
    ingredientName: z.string().min(1).max(200),
    // Decimal-like; Prisma stores Decimal(18,4). Same simple
    // validation as order-line quantities.
    quantity: z.coerce
      .number()
      .positive()
      .refine((n) => Number.isFinite(n), "must be finite"),
    unit: z.string().min(1).max(20),
  })
  .strict();

const inputSchema = z
  .object({
    // Org-unique formula code, machine-friendly (uppercase, digits,
    // hyphen/underscore). This is OUR identifier scheme — a formula
    // code, not an NDC.
    code: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{1,63}$/, "expected 2-64 chars: A-Z, 0-9, '-', '_'"),
    name: z.string().min(1).max(200),
    description: z.string().min(1).max(2000).optional(),

    preparationKind: z.enum(CompoundPreparationKind),
    hazardous: z.boolean().optional(),

    finalForm: z.string().min(1).max(100).optional(),
    finalStrength: z.string().min(1).max(100).optional(),

    budDays: z.int().positive().max(BUD_DAYS_ABSOLUTE_MAX),
    budBasis: z.enum(CompoundBudBasis),
    budReference: z.string().min(1).max(500).optional(),
    storageCondition: z.enum(CompoundStorageCondition),

    instructions: z.string().min(1).max(20000),
    qualityChecks: z.string().min(1).max(20000).optional(),

    ingredients: z.array(ingredientSchema).min(1).max(50),
  })
  .strict();

export type CreateCompoundFormulaInput = z.infer<typeof inputSchema>;

export interface CreateCompoundFormulaOutput {
  readonly formulaId: string;
  readonly code: string;
  readonly version: number;
}

// ---------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------

export const CreateCompoundFormula: Command<
  CreateCompoundFormulaInput,
  CreateCompoundFormulaOutput
> = {
  name: "CreateCompoundFormula",
  inputSchema,
  permission: PERMISSIONS.COMPOUNDING_FORMULA_MANAGE,

  async handle({
    input,
    ctx,
    tx,
    commandLogId,
    clock,
  }): Promise<HandlerResult<CreateCompoundFormulaOutput>> {
    const now = clock.now();

    // BUD guards that Zod can't express (cross-field).
    if (!BUD_BASES_FOR_PREPARATION_KIND[input.preparationKind].has(input.budBasis)) {
      throw new errors.ValidationError({
        code: COMPOUND_FORMULA_BUD_BASIS_MISMATCH,
        message: `budBasis ${input.budBasis} is not valid for a ${input.preparationKind} preparation.`,
        metadata: { budBasis: input.budBasis, preparationKind: input.preparationKind },
      });
    }
    const cap = USP_795_BUD_CAPS_DAYS[input.budBasis] ?? USP_797_BUD_CAPS_DAYS[input.budBasis];
    if (cap !== undefined && input.budDays > cap) {
      throw new errors.ValidationError({
        code: COMPOUND_FORMULA_BUD_EXCEEDS_BASIS,
        message: `budDays ${input.budDays} exceeds the USP ceiling of ${cap} days for basis ${input.budBasis}.`,
        metadata: { budDays: input.budDays, budBasis: input.budBasis, capDays: cap },
      });
    }
    if (input.budBasis === CompoundBudBasis.STABILITY_STUDY && input.budReference === undefined) {
      throw new errors.ValidationError({
        code: COMPOUND_FORMULA_BUD_REFERENCE_REQUIRED,
        message: "budReference (the documented stability study) is required for STABILITY_STUDY.",
        metadata: { budBasis: input.budBasis },
      });
    }

    // Every referenced ingredient product must exist in THIS org's
    // catalog. The FK alone would let a hand-crafted UUID from another
    // org fail opaquely at insert; checking here gives a typed error
    // and (belt-and-suspenders with RLS) keeps the reference in-tenant.
    const referencedProductIds = [
      ...new Set(
        input.ingredients.map((i) => i.productId).filter((id): id is string => id !== undefined)
      ),
    ];
    if (referencedProductIds.length > 0) {
      const found = await tx.product.findMany({
        where: { organizationId: ctx.organizationId, id: { in: referencedProductIds } },
        select: { id: true },
      });
      const foundIds = new Set(found.map((p) => p.id));
      const missing = referencedProductIds.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        throw new errors.NotFoundError({
          code: COMPOUND_FORMULA_INGREDIENT_PRODUCT_NOT_FOUND,
          message: "One or more ingredient productIds are not in this organization's catalog.",
          metadata: { missingProductIds: missing },
        });
      }
    }

    // Next version for this code. Concurrent drafts of the same code
    // are serialized by the partial UNIQUE (one DRAFT per org+code);
    // see the P2002 translation below.
    const latest = await tx.compoundFormula.findFirst({
      where: { organizationId: ctx.organizationId, code: input.code },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    const version = (latest?.version ?? 0) + 1;

    const formulaId = randomUUID();
    try {
      await tx.compoundFormula.create({
        data: {
          id: formulaId,
          organizationId: ctx.organizationId,
          code: input.code,
          version,
          status: CompoundFormulaStatus.DRAFT,
          name: input.name,
          ...(input.description === undefined ? {} : { description: input.description }),
          preparationKind: input.preparationKind,
          hazardous: input.hazardous ?? false,
          ...(input.finalForm === undefined ? {} : { finalForm: input.finalForm }),
          ...(input.finalStrength === undefined ? {} : { finalStrength: input.finalStrength }),
          budDays: input.budDays,
          budBasis: input.budBasis,
          ...(input.budReference === undefined ? {} : { budReference: input.budReference }),
          storageCondition: input.storageCondition,
          instructions: input.instructions,
          ...(input.qualityChecks === undefined ? {} : { qualityChecks: input.qualityChecks }),
          createdByUserId: ctx.actor.userId,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        // Partial unique "one DRAFT per (org, code)" — someone else
        // holds an open draft for this code. (The (org, code, version)
        // key collapses into the same user-facing story: retry after
        // the open draft is published or a fresh create re-reads the
        // version.)
        throw new errors.ConflictError({
          code: COMPOUND_FORMULA_DRAFT_EXISTS,
          message: `A draft of formula ${input.code} already exists; publish or discard it before drafting again.`,
          metadata: { code: input.code },
        });
      }
      throw err;
    }

    await tx.compoundFormulaIngredient.createMany({
      data: input.ingredients.map((ingredient, index) => ({
        organizationId: ctx.organizationId,
        formulaId,
        ...(ingredient.productId === undefined ? {} : { productId: ingredient.productId }),
        ingredientName: ingredient.ingredientName,
        quantity: new Prisma.Decimal(ingredient.quantity),
        unit: ingredient.unit,
        sortOrder: index,
      })),
    });

    return {
      output: { formulaId, code: input.code, version },
      audit: {
        action: "compounding.formula.created",
        resourceType: "CompoundFormula",
        resourceId: formulaId,
        metadata: {
          code: input.code,
          version,
          preparationKind: input.preparationKind,
          hazardous: input.hazardous ?? false,
          budDays: input.budDays,
          budBasis: input.budBasis,
          ingredientCount: input.ingredients.length,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "compounding.formula.created.v1",
          aggregateType: "CompoundFormula",
          aggregateId: formulaId,
          payload: {
            formulaId,
            organizationId: ctx.organizationId,
            code: input.code,
            version,
            preparationKind: input.preparationKind,
            hazardous: input.hazardous ?? false,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
