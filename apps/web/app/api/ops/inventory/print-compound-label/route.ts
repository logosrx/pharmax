// POST /api/ops/inventory/print-compound-label
//
// Queues a compound stock label: the batch record label, or a run of
// per-unit vial labels, selected by the `kind` field.
//
// Both commands declare `requiresWorkstation: true` — the workstation
// is part of the print-job audit trail and pairs the job with the
// physical printer the agent polls for.
//
// SECURITY: the operator can post any UUID for `workstationId` and
// `printerId`. This route validates that the workstation belongs to the
// operator's organization, sits at the BATCH's site, and is ACTIVE.
// The printer's site is validated by the command itself against the
// same batch. A failure surfaces as a flash error rather than silently
// downgrading to "no workstation".
//
// RBAC enforced by the commands (`inventory.batch.label_print`).
// No PHI: a compound batch has no patient.

import { prisma } from "@pharmax/database";
import {
  PrintCompoundBatchLabel,
  type PrintCompoundBatchLabelInput,
  PrintCompoundUnitLabels,
  type PrintCompoundUnitLabelsInput,
} from "@pharmax/inventory";

import { dispatchOpsCommand } from "../../../../../src/server/ops/dispatch-from-route.js";
import { assertWorkstationBelongsToSite } from "../../../../../src/server/ops/get-fill-workbench.js";

function readString(body: FormData | Record<string, unknown>, key: string): string | null {
  const raw = body instanceof FormData ? body.get(key) : (body as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

function readInt(body: FormData | Record<string, unknown>, key: string): number | undefined {
  const raw = readString(body, key);
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) ? n : undefined;
}

/** Read `kind` + `batchId` without consuming the request body. */
async function peek(request: Request): Promise<{ kind: string; batchId: string }> {
  try {
    const form = await request.clone().formData();
    const kind = form.get("kind");
    const batchId = form.get("batchId");
    return {
      kind: typeof kind === "string" ? kind : "",
      batchId: typeof batchId === "string" ? batchId : "",
    };
  } catch {
    try {
      const json = (await request.clone().json()) as Record<string, unknown>;
      return {
        kind: typeof json["kind"] === "string" ? json["kind"] : "",
        batchId: typeof json["batchId"] === "string" ? json["batchId"] : "",
      };
    } catch {
      return { kind: "", batchId: "" };
    }
  }
}

/**
 * Validate the workstation against the BATCH's site, not the actor's.
 * Labels for stock compounded at one site must not print at another.
 */
function resolveWorkstationForBatch(batchId: string) {
  return async ({
    body,
    organizationId,
  }: {
    readonly body: FormData | Record<string, unknown>;
    readonly organizationId: string;
  }) => {
    const workstationId = readString(body, "workstationId");
    if (workstationId === null) {
      return { error: "A workstation is required for printing. Select one above." };
    }
    const batch = await prisma.compoundBatch.findFirst({
      where: { id: batchId, organizationId },
      select: { siteId: true },
    });
    if (batch === null) return { error: "Compound batch not found." };

    const ok = await assertWorkstationBelongsToSite({
      organizationId,
      siteId: batch.siteId,
      workstationId,
    });
    if (!ok) {
      return {
        error:
          "That workstation is not active at the site that compounded this batch. Pick another.",
      };
    }
    return { workstationId, siteId: batch.siteId };
  };
}

export async function POST(request: Request): Promise<Response> {
  const { kind, batchId } = await peek(request);
  const detailPath = `/ops/admin/compound-batches/${batchId}`;

  if (kind !== "batch" && kind !== "units") {
    const url = new URL(detailPath, request.url);
    url.searchParams.set("error", "Unknown label kind.");
    return Response.redirect(url.toString(), 303);
  }

  if (kind === "batch") {
    return await dispatchOpsCommand({
      request,
      command: PrintCompoundBatchLabel,
      idempotencyKeyPrefix: `route:print-compound-batch-label:${batchId}`,
      buildInput: ({ body }) => {
        const id = readString(body, "batchId");
        const printerId = readString(body, "printerId");
        if (id === null) return { error: "batchId is required." };
        if (printerId === null) return { error: "A printer is required." };
        const reprintReasonCode = readString(body, "reprintReasonCode");
        return {
          batchId: id,
          printerId,
          ...(reprintReasonCode !== null ? { reprintReasonCode } : {}),
        } as PrintCompoundBatchLabelInput;
      },
      resolveTenancyExtras: resolveWorkstationForBatch(batchId),
      successRedirect: (output) =>
        `${detailPath}?flash=${encodeURIComponent(
          `${output.isReprint ? "Reprint" : "Batch label"} for ${output.batchNumber} sent to the printer.`
        )}`,
      failureRedirect: detailPath,
      successLogEvent: "ops.inventory.print_compound_batch_label.applied",
      failureLogEvent: "ops.inventory.print_compound_batch_label.failed",
    });
  }

  return await dispatchOpsCommand({
    request,
    command: PrintCompoundUnitLabels,
    idempotencyKeyPrefix: `route:print-compound-unit-labels:${batchId}`,
    buildInput: ({ body }) => {
      const id = readString(body, "batchId");
      const printerId = readString(body, "printerId");
      if (id === null) return { error: "batchId is required." };
      if (printerId === null) return { error: "A printer is required." };
      const fromUnitNumber = readInt(body, "fromUnitNumber");
      const toUnitNumber = readInt(body, "toUnitNumber");
      const reprintReasonCode = readString(body, "reprintReasonCode");
      return {
        batchId: id,
        printerId,
        ...(fromUnitNumber !== undefined ? { fromUnitNumber } : {}),
        ...(toUnitNumber !== undefined ? { toUnitNumber } : {}),
        ...(reprintReasonCode !== null ? { reprintReasonCode } : {}),
      } as PrintCompoundUnitLabelsInput;
    },
    resolveTenancyExtras: resolveWorkstationForBatch(batchId),
    successRedirect: (output) =>
      `${detailPath}?flash=${encodeURIComponent(
        `${output.printJobIds.length} unit label(s) for ${output.batchNumber} sent to the printer (units ${output.fromUnitNumber}–${output.toUnitNumber}).`
      )}`,
    failureRedirect: detailPath,
    successLogEvent: "ops.inventory.print_compound_unit_labels.applied",
    failureLogEvent: "ops.inventory.print_compound_unit_labels.failed",
  });
}
