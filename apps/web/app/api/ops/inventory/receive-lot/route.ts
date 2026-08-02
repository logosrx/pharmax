// POST /api/ops/inventory/receive-lot
//
// Receiving-dock action: record an inbound lot shipment with its
// DSCSA Transaction Information + Transaction Statement attestation
// (ADR-0035 slice 3). Dispatches `ReceiveLot`, which atomically
// creates-or-extends the Lot, writes the LOT_RECEIVED ledger credit,
// and stores the dscsa_transaction row. The command refuses receipt
// without the seller's TS and refuses already-expired stock.
//
// RBAC enforced by the command (`inventory.receive`). Supply-chain
// data only — no PHI in this route.
//
// On success we land on the lot's chain-of-custody page, where the
// new receipt is the top row.

import { ReceiveLot, type ReceiveLotInput } from "@pharmax/inventory";

import { dispatchOpsCommand } from "../../../../../src/server/ops/dispatch-from-route.js";

function readString(body: FormData | Record<string, unknown>, key: string): string | null {
  const raw = body instanceof FormData ? body.get(key) : (body as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

export async function POST(request: Request): Promise<Response> {
  return await dispatchOpsCommand({
    request,
    command: ReceiveLot,
    idempotencyKeyPrefix: "route:receive-lot",
    buildInput: ({ body }) => {
      const siteId = readString(body, "siteId");
      if (siteId === null) return { error: "siteId is required." };
      const productId = readString(body, "productId");
      if (productId === null) return { error: "productId is required." };
      const lotNumber = readString(body, "lotNumber");
      if (lotNumber === null) return { error: "lotNumber is required." };
      const expirationDate = readString(body, "expirationDate");
      if (expirationDate === null) return { error: "expirationDate is required." };
      const quantity = readString(body, "quantity");
      if (quantity === null) return { error: "quantity is required." };

      const required = [
        "productName",
        "strength",
        "dosageForm",
        "containerSize",
        "containerCount",
        "transactionDate",
        "sellerName",
        "sellerAddress",
        "buyerName",
        "buyerAddress",
      ] as const;
      const dscsa: Record<string, unknown> = {};
      for (const key of required) {
        const value = readString(body, key);
        if (value === null) return { error: `${key} is required.` };
        dscsa[key] = key === "containerCount" ? Number(value) : value;
      }

      const shipmentDate = readString(body, "shipmentDate");
      if (shipmentDate !== null) dscsa["shipmentDate"] = shipmentDate;
      const sourceDocumentRef = readString(body, "sourceDocumentRef");
      if (sourceDocumentRef !== null) dscsa["sourceDocumentRef"] = sourceDocumentRef;

      // Checkbox: present ("on") only when the receiver attests the
      // seller's Transaction Statement accompanied the shipment. The
      // command hard-refuses `false`, so an unchecked box surfaces
      // the statutory error rather than silently passing.
      dscsa["transactionStatementReceived"] =
        readString(body, "transactionStatementReceived") !== null;

      return {
        siteId,
        productId,
        lotNumber,
        expirationDate,
        quantity: Number(quantity),
        dscsa,
      } as ReceiveLotInput;
    },
    successRedirect: (output) =>
      `/ops/admin/batches/${output.lotId}?flash=${encodeURIComponent(
        `Received ${output.quantity} × lot ${output.lotNumber}${output.lotCreated ? " (new lot created)" : ""}.`
      )}`,
    failureRedirect: "/ops/admin/batches/receive",
    successLogEvent: "ops.inventory.receive_lot.applied",
    failureLogEvent: "ops.inventory.receive_lot.failed",
  });
}
