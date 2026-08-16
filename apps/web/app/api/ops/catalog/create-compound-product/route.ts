// POST /api/ops/catalog/create-compound-product
//
// Products/Compounds tab action: add an in-house compound to the
// catalog. Dispatches `CreateCompoundProduct`, which atomically mints
// the org's next Pharmax Product ID (row-locked allocator, dense
// monotonic PXP series) and creates the Product row with
// `ndcKind = IN_HOUSE_COMPOUND` and the frozen serial identity
// (primary-drug initial + mg) that every batch unit number of this
// product will carry.
//
// RBAC enforced by the command (`catalog.compound_product.create`).
// Catalog data only — no PHI in this route.

import { CreateCompoundProduct, type CreateCompoundProductInput } from "@pharmax/inventory";

import { dispatchOpsCommand } from "../../../../../src/server/ops/dispatch-from-route.js";

function readString(body: FormData | Record<string, unknown>, key: string): string | null {
  const raw = body instanceof FormData ? body.get(key) : (body as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

export async function POST(request: Request): Promise<Response> {
  return await dispatchOpsCommand({
    request,
    command: CreateCompoundProduct,
    idempotencyKeyPrefix: "route:create-compound-product",
    buildInput: ({ body }) => {
      const name = readString(body, "name");
      if (name === null) return { error: "name is required." };
      const strength = readString(body, "strength");
      if (strength === null) return { error: "strength is required." };
      const unitKind = readString(body, "unitKind");
      if (unitKind === null) return { error: "unitKind is required." };
      const serialDrugInitial = readString(body, "serialDrugInitial");
      if (serialDrugInitial === null) return { error: "serialDrugInitial is required." };
      const serialDrugMg = readString(body, "serialDrugMg");
      if (serialDrugMg === null) return { error: "serialDrugMg is required." };

      const form = readString(body, "form");
      const controlledSubstanceSchedule = readString(body, "controlledSubstanceSchedule");

      return {
        name,
        strength,
        unitKind,
        serialDrugInitial,
        serialDrugMg: Number(serialDrugMg),
        ...(form !== null ? { form } : {}),
        ...(controlledSubstanceSchedule !== null && controlledSubstanceSchedule !== "NON_CONTROLLED"
          ? { controlledSubstanceSchedule }
          : {}),
      } as CreateCompoundProductInput;
    },
    successRedirect: (output) =>
      `/ops/admin/products?flash=${encodeURIComponent(
        `Created ${output.name} ${output.strength} — Pharmax Product ID ${output.pharmaxProductId}.`
      )}`,
    failureRedirect: "/ops/admin/products/new",
    successLogEvent: "ops.catalog.create_compound_product.applied",
    failureLogEvent: "ops.catalog.create_compound_product.failed",
  });
}
