// POST /api/ops/orders/:orderId/create-shipment
//
// Shipping clerk records a shipment for an order in READY_TO_SHIP.
// This is the "I printed the label outside our system" path —
// the operator types carrier + service level + tracking number.
// The auto-purchase path (PurchaseShipmentLabel) lives on the
// same route surface but is deferred until the ship-from address
// admin slice lands; today both paths converge here through
// CreateShipment.
//
// SHIPMENT_ALREADY_EXISTS surfaces as a typed flash error if the
// operator double-submits or a worker has already created the
// shipment via another path.
//
// RBAC enforced by the command (`ship.create` permission).

import { ShipmentCarrier, type ShipmentCarrier as ShipmentCarrierType } from "@pharmax/database";
import { CreateShipment } from "@pharmax/shipping";

import { dispatchOpsCommand } from "../../../../../../src/server/ops/dispatch-from-route.js";

interface RouteParams {
  readonly params: Promise<{ readonly orderId: string }>;
}

const CARRIER_VALUES: ReadonlySet<ShipmentCarrierType> = new Set([
  ShipmentCarrier.USPS,
  ShipmentCarrier.UPS,
  ShipmentCarrier.FEDEX,
  ShipmentCarrier.DHL,
  ShipmentCarrier.OTHER,
]);

function readString(body: FormData | Record<string, unknown>, key: string): string | null {
  const raw = body instanceof FormData ? body.get(key) : (body as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.length > 0 ? raw.trim() : null;
}

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { orderId } = await context.params;
  return await dispatchOpsCommand({
    request,
    command: CreateShipment,
    idempotencyKeyPrefix: `route:create-shipment:${orderId}`,
    buildInput: ({ body }) => {
      const carrier = readString(body, "carrier");
      const serviceLevel = readString(body, "serviceLevel");
      const trackingNumber = readString(body, "trackingNumber");
      if (carrier === null || !CARRIER_VALUES.has(carrier as ShipmentCarrierType)) {
        return {
          error: `carrier must be one of: ${Array.from(CARRIER_VALUES).join(", ")}.`,
        };
      }
      if (serviceLevel === null) return { error: "serviceLevel is required." };
      if (trackingNumber === null) return { error: "trackingNumber is required." };
      return {
        orderId,
        carrier: carrier as ShipmentCarrierType,
        serviceLevel,
        trackingNumber,
      };
    },
    successRedirect: () => `/ops/shipping?flash=shipment_created&orderId=${orderId}`,
    failureRedirect: `/ops/shipping`,
    successLogEvent: "ops.shipping.create.applied",
    failureLogEvent: "ops.shipping.create.failed",
  });
}
