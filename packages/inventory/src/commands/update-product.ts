// UpdateProduct — edit a catalog product's descriptive fields and its
// two screening-relevant switches.
//
// The fields split into two tiers on blast radius:
//
//   Descriptive (name, strength, form): display/reporting metadata.
//     Wrong values mislabel reports, not safety checks.
//
//   Screening-relevant (ndcKind, controlledSubstanceSchedule):
//     - Flipping ndcKind NATIONAL → IN_HOUSE_COMPOUND converts the
//       acknowledge-tier "verify the NDC" PV1 prompt into an
//       informational gap on every order for this product — the exact
//       screening-suppression vector the schema comment on
//       `product.ndcKind` warns about. Gated + audited here.
//     - Changing controlledSubstanceSchedule changes which Part 1306
//       rules govern FUTURE prescriptions of the product (existing
//       prescriptions keep their issuance-time snapshot by design).
//
// Both tiers write before/after values into the audit metadata so
// "who silenced this screening prompt and when?" is a one-row answer.
//
// The NDC itself is immutable — an NDC "edit" is a different product
// (create the new row, deplete the old one), mirroring the provider
// roster's immutable-NPI rule.
//
// Non-order aggregate: plain `Command` shape. Catalog data only — no
// PHI anywhere in this command.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { ControlledSubstanceSchedule, ProductNdcKind } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

import { INVENTORY_PRODUCT_NOT_FOUND, INVENTORY_PRODUCT_NO_CHANGES } from "../shared.js";

// ---------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------

const inputSchema = z
  .object({
    productId: z.uuid(),
    name: z.string().min(1).max(300).optional(),
    strength: z.string().min(1).max(100).nullable().optional(),
    form: z.string().min(1).max(100).nullable().optional(),
    ndcKind: z.enum(ProductNdcKind).optional(),
    controlledSubstanceSchedule: z.enum(ControlledSubstanceSchedule).optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.name !== undefined ||
      v.strength !== undefined ||
      v.form !== undefined ||
      v.ndcKind !== undefined ||
      v.controlledSubstanceSchedule !== undefined,
    { message: "At least one field to update must be provided." }
  );

export type UpdateProductInput = z.infer<typeof inputSchema>;

export interface UpdateProductOutput {
  readonly productId: string;
  readonly ndcKind: ProductNdcKind;
  readonly controlledSubstanceSchedule: ControlledSubstanceSchedule;
}

// ---------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------

export const UpdateProduct: Command<UpdateProductInput, UpdateProductOutput> = {
  name: "UpdateProduct",
  inputSchema,
  permission: PERMISSIONS.INVENTORY_PRODUCTS_MANAGE,

  async handle({
    input,
    ctx,
    tx,
    commandLogId,
    clock,
  }): Promise<HandlerResult<UpdateProductOutput>> {
    const now = clock.now();

    const before = await tx.product.findFirst({
      where: { id: input.productId, organizationId: ctx.organizationId },
      select: {
        id: true,
        ndc: true,
        name: true,
        strength: true,
        form: true,
        ndcKind: true,
        controlledSubstanceSchedule: true,
      },
    });
    if (before === null) {
      throw new errors.NotFoundError({
        code: INVENTORY_PRODUCT_NOT_FOUND,
        message: "Product not found in this organization's catalog.",
        metadata: { productId: input.productId },
      });
    }

    const data: {
      name?: string;
      strength?: string | null;
      form?: string | null;
      ndcKind?: ProductNdcKind;
      controlledSubstanceSchedule?: ControlledSubstanceSchedule;
    } = {};
    if (input.name !== undefined && input.name !== before.name) data.name = input.name;
    if (input.strength !== undefined && input.strength !== before.strength)
      data.strength = input.strength;
    if (input.form !== undefined && input.form !== before.form) data.form = input.form;
    if (input.ndcKind !== undefined && input.ndcKind !== before.ndcKind)
      data.ndcKind = input.ndcKind;
    if (
      input.controlledSubstanceSchedule !== undefined &&
      input.controlledSubstanceSchedule !== before.controlledSubstanceSchedule
    )
      data.controlledSubstanceSchedule = input.controlledSubstanceSchedule;

    // A no-op "update" gets a typed refusal instead of a silent audit
    // row claiming a change happened. The caller sent stale data or a
    // double-submit; both deserve a visible signal.
    if (Object.keys(data).length === 0) {
      throw new errors.ValidationError({
        code: INVENTORY_PRODUCT_NO_CHANGES,
        message: "Every provided field already has the requested value; nothing to update.",
        metadata: { productId: input.productId },
      });
    }

    await tx.product.update({ where: { id: before.id }, data });

    const after = {
      ndcKind: data.ndcKind ?? before.ndcKind,
      controlledSubstanceSchedule:
        data.controlledSubstanceSchedule ?? before.controlledSubstanceSchedule,
    };

    return {
      output: {
        productId: before.id,
        ndcKind: after.ndcKind,
        controlledSubstanceSchedule: after.controlledSubstanceSchedule,
      },
      audit: {
        action: "inventory.product.updated",
        resourceType: "Product",
        resourceId: before.id,
        metadata: {
          productId: before.id,
          ndc: before.ndc,
          // Full before/after on the screening-relevant switches —
          // this is the row an auditor reads when a PV1 prompt
          // disappeared.
          ndcKindBefore: before.ndcKind,
          ndcKindAfter: after.ndcKind,
          controlledSubstanceScheduleBefore: before.controlledSubstanceSchedule,
          controlledSubstanceScheduleAfter: after.controlledSubstanceSchedule,
          changedFields: Object.keys(data),
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "inventory.product.updated.v1",
          aggregateType: "Product",
          aggregateId: before.id,
          payload: {
            productId: before.id,
            organizationId: ctx.organizationId,
            changedFields: Object.keys(data),
            ndcKind: after.ndcKind,
            controlledSubstanceSchedule: after.controlledSubstanceSchedule,
            updatedByUserId: ctx.actor.userId,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
