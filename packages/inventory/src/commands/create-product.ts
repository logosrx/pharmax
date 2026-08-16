// CreateProduct — add a drug product to the org's catalog.
//
// This is the write path the schema comment on `product.ndcKind` has
// been demanding since the catalog was seeded/ops-managed: "whoever
// builds product CRUD must make ndcKind changes permission-gated and
// audit-logged, or that surface becomes a channel for silencing a
// screening prompt." Both `ndcKind` and `controlledSubstanceSchedule`
// alter downstream screening/dispensing behavior, so creation is
// gated on `inventory.products.manage` (pharmacist-level) and every
// field lands in the audit metadata.
//
// NDC normalization is the caller's job (the same 11-digit normalized
// form the rest of the catalog uses); this command validates shape
// only. Uniqueness is enforced by the (organizationId, ndc) unique —
// a concurrent duplicate create surfaces as a typed conflict, same
// P2002 pattern as ReceiveLot.
//
// Non-order aggregate: plain `Command` shape (no order lock), like
// ReceiveLot. Catalog data only — no PHI anywhere in this command.

import { randomUUID } from "node:crypto";

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { ControlledSubstanceSchedule, Prisma, ProductNdcKind } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

import { INVENTORY_PRODUCT_NDC_CONFLICT } from "../shared.js";

// ---------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------

const inputSchema = z
  .object({
    /** Normalized 11-digit NDC, or the org-local compound identifier
     *  when `ndcKind` is IN_HOUSE_COMPOUND. */
    ndc: z.string().min(1).max(60),
    name: z.string().min(1).max(300),
    strength: z.string().min(1).max(100).optional(),
    form: z.string().min(1).max(100).optional(),
    ndcKind: z.enum(ProductNdcKind).default(ProductNdcKind.NATIONAL),
    controlledSubstanceSchedule: z
      .enum(ControlledSubstanceSchedule)
      .default(ControlledSubstanceSchedule.NON_CONTROLLED),
  })
  .strict();

export type CreateProductInput = z.infer<typeof inputSchema>;

export interface CreateProductOutput {
  readonly productId: string;
  readonly ndc: string;
  readonly ndcKind: ProductNdcKind;
  readonly controlledSubstanceSchedule: ControlledSubstanceSchedule;
}

// ---------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------

export const CreateProduct: Command<CreateProductInput, CreateProductOutput> = {
  name: "CreateProduct",
  inputSchema,
  permission: PERMISSIONS.INVENTORY_PRODUCTS_MANAGE,

  async handle({
    input,
    ctx,
    tx,
    commandLogId,
    clock,
  }): Promise<HandlerResult<CreateProductOutput>> {
    const now = clock.now();
    const productId = randomUUID();

    try {
      await tx.product.create({
        data: {
          id: productId,
          organizationId: ctx.organizationId,
          ndc: input.ndc,
          name: input.name,
          ...(input.strength === undefined ? {} : { strength: input.strength }),
          ...(input.form === undefined ? {} : { form: input.form }),
          ndcKind: input.ndcKind,
          controlledSubstanceSchedule: input.controlledSubstanceSchedule,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new errors.ConflictError({
          code: INVENTORY_PRODUCT_NDC_CONFLICT,
          cause: err,
          message: "A product with this NDC already exists in this organization's catalog.",
          metadata: { ndc: input.ndc },
        });
      }
      throw err;
    }

    return {
      output: {
        productId,
        ndc: input.ndc,
        ndcKind: input.ndcKind,
        controlledSubstanceSchedule: input.controlledSubstanceSchedule,
      },
      audit: {
        action: "inventory.product.created",
        resourceType: "Product",
        resourceId: productId,
        metadata: {
          productId,
          ndc: input.ndc,
          name: input.name,
          strength: input.strength ?? null,
          form: input.form ?? null,
          ndcKind: input.ndcKind,
          controlledSubstanceSchedule: input.controlledSubstanceSchedule,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "inventory.product.created.v1",
          aggregateType: "Product",
          aggregateId: productId,
          payload: {
            productId,
            organizationId: ctx.organizationId,
            ndc: input.ndc,
            ndcKind: input.ndcKind,
            controlledSubstanceSchedule: input.controlledSubstanceSchedule,
            createdByUserId: ctx.actor.userId,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
