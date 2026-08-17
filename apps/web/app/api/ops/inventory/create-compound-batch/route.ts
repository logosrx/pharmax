// POST /api/ops/inventory/create-compound-batch
//
// Compound batches tab action: record a finished production run.
// Dispatches `CreateCompoundBatch`, which mints the batch number
// (site code + frozen serial identity + batch-of-the-day counter +
// compounding date) and one serial per unit, all in one transaction,
// with the batch starting in COMPOUNDED.
//
// RBAC enforced by the command (`inventory.batch.create`).
// Catalog/inventory data only — no PHI in this route.

import { CreateCompoundBatch, type CreateCompoundBatchInput } from "@pharmax/inventory";

import { dispatchOpsCommand } from "../../../../../src/server/ops/dispatch-from-route.js";

function readString(body: FormData | Record<string, unknown>, key: string): string | null {
  const raw = body instanceof FormData ? body.get(key) : (body as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

export async function POST(request: Request): Promise<Response> {
  return await dispatchOpsCommand({
    request,
    command: CreateCompoundBatch,
    idempotencyKeyPrefix: "route:create-compound-batch",
    buildInput: ({ body }) => {
      const siteId = readString(body, "siteId");
      if (siteId === null) return { error: "siteId is required." };
      const productId = readString(body, "productId");
      if (productId === null) return { error: "productId is required." };
      const unitCount = readString(body, "unitCount");
      if (unitCount === null) return { error: "unitCount is required." };
      const compoundedOn = readString(body, "compoundedOn");
      if (compoundedOn === null) return { error: "compoundedOn is required." };
      const beyondUseDate = readString(body, "beyondUseDate");
      if (beyondUseDate === null) return { error: "beyondUseDate is required." };

      return {
        siteId,
        productId,
        unitCount: Number(unitCount),
        compoundedOn,
        beyondUseDate,
      } as CreateCompoundBatchInput;
    },
    successRedirect: (output) =>
      `/ops/admin/compound-batches/${output.batchId}?flash=${encodeURIComponent(
        `Batch ${output.batchNumber} recorded — ${output.unitCount} serials minted (${output.firstSerial} … ${output.lastSerial}).`
      )}`,
    failureRedirect: "/ops/admin/compound-batches/new",
    successLogEvent: "ops.inventory.create_compound_batch.applied",
    failureLogEvent: "ops.inventory.create_compound_batch.failed",
  });
}
