// CreateCompoundProduct — add an in-house compound to the catalog.
//
// One command, two writes in one transaction:
//
//   1. The allocator increment on `pharmax_product_id_sequence`,
//      which mints the org's next Pharmax Product ID ("PXP-000042")
//      under a row lock so concurrent creations serialize and the
//      series stays dense and monotonic.
//   2. The `Product` row, with `ndcKind = IN_HOUSE_COMPOUND` fixed at
//      birth and `ndc` set to the minted id — the schema's org-local-
//      identifier convention for compounds — so every existing
//      surface keyed on `ndc` (lots, labels, billing, screening)
//      works unchanged.
//
// The serial identity (`serialDrugInitial` + `serialDrugMg` — the
// "T30" in PHX-T30-1-040327-11) is FROZEN here: there is deliberately
// no edit surface, because changing it on a live product would orphan
// every already-printed batch label. Get it wrong, retire the product
// and create a new one.
//
// Screening note (see `Product.ndcKind` in schema.prisma): this
// command CREATES compounds; it cannot flip an existing NATIONAL
// product to IN_HOUSE_COMPOUND, so it is not a channel for silencing
// the "verify the NDC" PV1 prompt on manufactured products.
//
// Non-order aggregate: plain `Command` shape (no order lock), like
// ReceiveLot. Catalog data only — no PHI anywhere in this command.

import { randomUUID } from "node:crypto";

import type { Command, HandlerResult } from "@pharmax/command-bus";
import {
  ControlledSubstanceSchedule,
  Prisma,
  ProductNdcKind,
  ProductUnitKind,
} from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

import { CATALOG_DUPLICATE_COMPOUND_PRODUCT, CATALOG_PRODUCT_CREATE_CONFLICT } from "../shared.js";
import { allocatePharmaxProductId } from "../pharmax-product-id.js";

// ---------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------

const inputSchema = z
  .object({
    /** Compound name, e.g. "Tirzepatide/Glycine". */
    name: z.string().min(1).max(300),
    /** Display strength, e.g. "10mg/20mg/3mL". */
    strength: z.string().min(1).max(100),
    /** Free-text dosage form, e.g. "Injectable solution". */
    form: z.string().min(1).max(100).optional(),
    /** Counting unit for batches ("how many VIALS in this batch"). */
    unitKind: z.enum(ProductUnitKind),
    /** Serial identity: first letter of the PRIMARY drug. Single
     *  A–Z letter — this prints inside every batch unit number. */
    serialDrugInitial: z
      .string()
      .length(1)
      .regex(/^[A-Za-z]$/, "must be a single letter")
      .transform((s) => s.toUpperCase()),
    /** Serial identity: total mg of the primary drug in ONE container
     *  (concentration × volume, e.g. Tirzepatide 10mg/mL × 3mL = 30). */
    serialDrugMg: z.int().positive().max(1_000_000),
    /** DEA schedule when the compound contains a controlled
     *  substance. Defaults to NON_CONTROLLED. */
    controlledSubstanceSchedule: z.enum(ControlledSubstanceSchedule).optional(),
  })
  .strict();

export type CreateCompoundProductInput = z.infer<typeof inputSchema>;

export interface CreateCompoundProductOutput {
  readonly productId: string;
  readonly pharmaxProductId: string;
  readonly name: string;
  readonly strength: string;
}

// ---------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------

export const CreateCompoundProduct: Command<
  CreateCompoundProductInput,
  CreateCompoundProductOutput
> = {
  name: "CreateCompoundProduct",
  inputSchema,
  permission: PERMISSIONS.CATALOG_COMPOUND_PRODUCT_CREATE,

  async handle({
    input,
    ctx,
    tx,
    commandLogId,
    clock,
  }): Promise<HandlerResult<CreateCompoundProductOutput>> {
    const now = clock.now();

    // Duplicate guard: the same compound entered twice would mint two
    // Pharmax Product IDs for one preparation, splitting its batch
    // history forever. Name is matched case-insensitively; strength
    // exactly — "Tirzepatide/Glycine 10mg/20mg/3mL" and the same
    // name at "5mg/10mg/3mL" are legitimately different products.
    const duplicate = await tx.product.findFirst({
      where: {
        organizationId: ctx.organizationId,
        ndcKind: ProductNdcKind.IN_HOUSE_COMPOUND,
        name: { equals: input.name, mode: "insensitive" },
        strength: input.strength,
      },
      select: { id: true, pharmaxProductId: true },
    });
    if (duplicate !== null) {
      throw new errors.ConflictError({
        code: CATALOG_DUPLICATE_COMPOUND_PRODUCT,
        message:
          "A compound with this name and strength already exists in the catalog; use its existing Pharmax Product ID instead of minting a second one.",
        metadata: {
          existingProductId: duplicate.id,
          existingPharmaxProductId: duplicate.pharmaxProductId,
        },
      });
    }

    // Mint the catalog id inside THIS transaction — the allocator's
    // row lock is the serialization point for concurrent creations,
    // and a rollback after this point simply consumes the number.
    const pharmaxProductId = await allocatePharmaxProductId({
      tx,
      organizationId: ctx.organizationId,
    });

    const productId = randomUUID();
    try {
      await tx.product.create({
        data: {
          id: productId,
          organizationId: ctx.organizationId,
          // The minted id IS the org-local identifier the `ndc`
          // column holds for compounds (see schema comment on
          // ProductNdcKind).
          ndc: pharmaxProductId,
          pharmaxProductId,
          name: input.name,
          strength: input.strength,
          ...(input.form === undefined ? {} : { form: input.form }),
          ndcKind: ProductNdcKind.IN_HOUSE_COMPOUND,
          unitKind: input.unitKind,
          serialDrugInitial: input.serialDrugInitial,
          serialDrugMg: input.serialDrugMg,
          ...(input.controlledSubstanceSchedule === undefined
            ? {}
            : { controlledSubstanceSchedule: input.controlledSubstanceSchedule }),
        },
      });
    } catch (err) {
      // The allocator makes an (org, ndc) / (org, pharmaxProductId)
      // collision unreachable in normal operation; reaching P2002
      // means the sequence was hand-reset below the live series.
      // Surface it as a typed retryable conflict, not a 500.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new errors.ConflictError({
          code: CATALOG_PRODUCT_CREATE_CONFLICT,
          cause: err,
          message: "The minted Pharmax Product ID collided with an existing product; retry.",
          metadata: { pharmaxProductId },
        });
      }
      throw err;
    }

    return {
      output: {
        productId,
        pharmaxProductId,
        name: input.name,
        strength: input.strength,
      },
      audit: {
        action: "catalog.compound_product.created",
        resourceType: "Product",
        resourceId: productId,
        metadata: {
          pharmaxProductId,
          name: input.name,
          strength: input.strength,
          form: input.form ?? null,
          unitKind: input.unitKind,
          serialDrugInitial: input.serialDrugInitial,
          serialDrugMg: input.serialDrugMg,
          controlledSubstanceSchedule:
            input.controlledSubstanceSchedule ?? ControlledSubstanceSchedule.NON_CONTROLLED,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "catalog.compound_product.created.v1",
          aggregateType: "Product",
          aggregateId: productId,
          payload: {
            organizationId: ctx.organizationId,
            productId,
            pharmaxProductId,
            name: input.name,
            strength: input.strength,
            unitKind: input.unitKind,
            serialDrugInitial: input.serialDrugInitial,
            serialDrugMg: input.serialDrugMg,
            createdByUserId: ctx.actor.userId,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
