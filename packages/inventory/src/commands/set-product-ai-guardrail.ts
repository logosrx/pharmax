// SetProductAiGuardrail — author or revise the tenant's safety
// envelope for one catalog product (typing-assist phase 1).
//
// The guardrail is the pharmacy's own statement of what a plausible
// fill of this product looks like: ceilings on quantity per fill,
// days supply, and refills, plus a per-product kill switch for
// model-generated suggestions. Two consumers:
//
//   1. The deterministic typing validators read it to flag a typed
//      prescription that exceeds a ceiling — no model in the loop.
//   2. The (later-phase) model pipeline must operate inside it: a
//      suggestion that violates the guardrail is discarded before a
//      human sees it, and `aiSuggestionsEnabled = false` removes the
//      product from the suggestion surface entirely.
//
// Upsert semantics with a version bump on every revision, so
// downstream suggestion records can pin the exact guardrail revision
// they were screened against (the workflow_policy_id/version pinning
// pattern). "Removing" a guardrail is a revision that clears the
// ceilings — audited like any other change, never a vanished row
// (the table has no DELETE grant).
//
// Rides `inventory.products.manage`: the guardrail is part of the
// product's safety configuration, authored at product-creation time
// by the same pharmacist-level authority that manages the catalog.
//
// Non-order aggregate: plain `Command` shape. Product-level
// configuration only — no PHI anywhere in this command.

import { randomUUID } from "node:crypto";

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { Prisma } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

import { INVENTORY_GUARDRAIL_CONFLICT, INVENTORY_PRODUCT_NOT_FOUND } from "../shared.js";

// ---------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------

const inputSchema = z
  .object({
    productId: z.uuid(),
    /** Per-product kill switch for MODEL suggestions. Deterministic
     *  validation keeps running when false. */
    aiSuggestionsEnabled: z.boolean(),
    /** Ceilings. `null` clears a previously-set bound; the axis is
     *  then simply not validated. */
    maxQuantityPerFill: z.number().positive().finite().nullable(),
    maxDaysSupplyPerFill: z.int().positive().nullable(),
    maxRefillsAuthorized: z.int().min(0).nullable(),
  })
  .strict();

export type SetProductAiGuardrailInput = z.infer<typeof inputSchema>;

export interface SetProductAiGuardrailOutput {
  readonly guardrailId: string;
  readonly productId: string;
  readonly version: number;
  readonly created: boolean;
}

// ---------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------

export const SetProductAiGuardrail: Command<
  SetProductAiGuardrailInput,
  SetProductAiGuardrailOutput
> = {
  name: "SetProductAiGuardrail",
  inputSchema,
  permission: PERMISSIONS.INVENTORY_PRODUCTS_MANAGE,

  async handle({
    input,
    ctx,
    tx,
    commandLogId,
    clock,
  }): Promise<HandlerResult<SetProductAiGuardrailOutput>> {
    const now = clock.now();

    const product = await tx.product.findFirst({
      where: { id: input.productId, organizationId: ctx.organizationId },
      select: { id: true, ndc: true, controlledSubstanceSchedule: true },
    });
    if (product === null) {
      throw new errors.NotFoundError({
        code: INVENTORY_PRODUCT_NOT_FOUND,
        message: "Product not found in this organization's catalog.",
        metadata: { productId: input.productId },
      });
    }

    const existing = await tx.productAiGuardrail.findFirst({
      where: { organizationId: ctx.organizationId, productId: product.id },
      select: {
        id: true,
        version: true,
        aiSuggestionsEnabled: true,
        maxQuantityPerFill: true,
        maxDaysSupplyPerFill: true,
        maxRefillsAuthorized: true,
      },
    });

    const values = {
      aiSuggestionsEnabled: input.aiSuggestionsEnabled,
      maxQuantityPerFill:
        input.maxQuantityPerFill === null ? null : new Prisma.Decimal(input.maxQuantityPerFill),
      maxDaysSupplyPerFill: input.maxDaysSupplyPerFill,
      maxRefillsAuthorized: input.maxRefillsAuthorized,
    };

    let guardrailId: string;
    let version: number;
    let created: boolean;

    if (existing === null) {
      guardrailId = randomUUID();
      version = 1;
      created = true;
      try {
        await tx.productAiGuardrail.create({
          data: {
            id: guardrailId,
            organizationId: ctx.organizationId,
            productId: product.id,
            ...values,
          },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          throw new errors.ConflictError({
            code: INVENTORY_GUARDRAIL_CONFLICT,
            cause: err,
            message: "A concurrent revision created this product's guardrail; retry.",
            metadata: { productId: product.id },
          });
        }
        throw err;
      }
    } else {
      guardrailId = existing.id;
      version = existing.version + 1;
      created = false;
      // CAS on version: two concurrent revisions serialize instead of
      // both claiming the same version number.
      const updated = await tx.productAiGuardrail.updateMany({
        where: { id: existing.id, version: existing.version },
        data: { ...values, version },
      });
      if (updated.count !== 1) {
        throw new errors.ConflictError({
          code: INVENTORY_GUARDRAIL_CONFLICT,
          message: "The guardrail was revised concurrently; reload and retry.",
          metadata: { productId: product.id, expectedVersion: existing.version },
        });
      }
    }

    const auditBefore =
      existing === null
        ? null
        : {
            aiSuggestionsEnabled: existing.aiSuggestionsEnabled,
            maxQuantityPerFill: existing.maxQuantityPerFill?.toString() ?? null,
            maxDaysSupplyPerFill: existing.maxDaysSupplyPerFill,
            maxRefillsAuthorized: existing.maxRefillsAuthorized,
          };

    return {
      output: { guardrailId, productId: product.id, version, created },
      audit: {
        action: created
          ? "inventory.product_ai_guardrail.created"
          : "inventory.product_ai_guardrail.revised",
        resourceType: "ProductAiGuardrail",
        resourceId: guardrailId,
        metadata: {
          guardrailId,
          productId: product.id,
          ndc: product.ndc,
          version,
          before: auditBefore,
          after: {
            aiSuggestionsEnabled: input.aiSuggestionsEnabled,
            maxQuantityPerFill: input.maxQuantityPerFill,
            maxDaysSupplyPerFill: input.maxDaysSupplyPerFill,
            maxRefillsAuthorized: input.maxRefillsAuthorized,
          },
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "inventory.product_ai_guardrail.set.v1",
          aggregateType: "ProductAiGuardrail",
          aggregateId: guardrailId,
          payload: {
            guardrailId,
            organizationId: ctx.organizationId,
            productId: product.id,
            version,
            created,
            aiSuggestionsEnabled: input.aiSuggestionsEnabled,
            setByUserId: ctx.actor.userId,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
