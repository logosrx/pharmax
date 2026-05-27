// POST /api/ops/orders/:orderId/purchase-shipment-label
//
// Carrier auto-purchase: ties together every prerequisite the
// shipping clerk needs in one click. Flow:
//
//   1. Resolve operator session → TenancyContext (dispatchOpsCommand).
//   2. Inside buildInput:
//      a. Read operator-submitted form: { provider, carrier, serviceLevel }.
//      b. Validate provider × carrier compatibility against
//         ALLOWED_CARRIERS_BY_PROVIDER (so e.g. FEDEX provider +
//         UPS carrier is caught before the bus).
//      c. Resolve the heavy address pieces server-side via
//         resolvePurchaseContext — fromAddress from PharmacySite,
//         toAddress from decrypted patient PHI, parcel from the
//         conservative default. Returns typed error codes
//         (SITE_ADDRESS_INCOMPLETE, NO_ACTIVE_CARRIER_CREDENTIAL,
//         etc.) which the helper surfaces as `?error=` redirects.
//   3. Dispatch PurchaseShipmentLabel — the command bus carries
//      the addresses through, the carrier adapter purchases the
//      label, a Shipment row is created with tracking number.
//   4. Redirect back to /ops/shipping with success flash.
//
// PHI: the recipient address is plaintext in memory only between
// resolvePurchaseContext and the carrier API call (which must
// transmit it in clear bytes). The command itself declares
// `redactFields: ["fromAddress", "toAddress"]` so command_log
// stores only metadata, not the address values. The route logs
// only the success/failure event name + operator id.
//
// RBAC enforced by the command (`ship.purchase_label`).

import { ShipmentCarrier, ShippingProvider } from "@pharmax/database";
import { PurchaseShipmentLabel } from "@pharmax/shipping";

import { dispatchOpsCommand } from "../../../../../../src/server/ops/dispatch-from-route.js";
import {
  ALLOWED_CARRIERS_BY_PROVIDER,
  resolvePurchaseContext,
} from "../../../../../../src/server/ops/resolve-purchase-context.js";

interface RouteParams {
  readonly params: Promise<{ readonly orderId: string }>;
}

const PROVIDERS: ReadonlySet<ShippingProvider> = new Set([
  ShippingProvider.EASYPOST,
  ShippingProvider.FEDEX,
  ShippingProvider.UPS,
]);

const CARRIERS: ReadonlySet<ShipmentCarrier> = new Set([
  ShipmentCarrier.USPS,
  ShipmentCarrier.UPS,
  ShipmentCarrier.FEDEX,
  ShipmentCarrier.DHL,
  ShipmentCarrier.OTHER,
]);

function readString(body: FormData | Record<string, unknown>, key: string): string | null {
  const raw = body instanceof FormData ? body.get(key) : (body as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { orderId } = await context.params;
  return await dispatchOpsCommand({
    request,
    command: PurchaseShipmentLabel,
    idempotencyKeyPrefix: `route:purchase-label:${orderId}`,
    buildInput: async ({ body, organizationId }) => {
      const provider = readString(body, "provider");
      const carrier = readString(body, "carrier");
      const serviceLevel = readString(body, "serviceLevel");
      if (provider === null || !PROVIDERS.has(provider as ShippingProvider)) {
        return {
          error: `provider must be one of: ${Array.from(PROVIDERS).join(", ")}.`,
        };
      }
      if (carrier === null || !CARRIERS.has(carrier as ShipmentCarrier)) {
        return {
          error: `carrier must be one of: ${Array.from(CARRIERS).join(", ")}.`,
        };
      }
      const allowedForProvider = ALLOWED_CARRIERS_BY_PROVIDER[provider as ShippingProvider];
      if (!allowedForProvider.includes(carrier as ShipmentCarrier)) {
        return {
          error: `${provider} cannot ship via ${carrier}. Allowed: ${allowedForProvider.join(", ")}.`,
        };
      }
      if (serviceLevel === null) return { error: "serviceLevel is required." };

      const resolved = await resolvePurchaseContext({ organizationId, orderId });
      if (!resolved.ok) {
        return { error: `${resolved.code}: ${resolved.message}` };
      }

      return {
        orderId,
        provider: provider as ShippingProvider,
        carrier: carrier as ShipmentCarrier,
        serviceLevel,
        fromAddress: resolved.context.fromAddress,
        toAddress: resolved.context.toAddress,
        parcel: resolved.context.parcel,
      };
    },
    successRedirect: () => `/ops/shipping?flash=shipment_created&orderId=${orderId}`,
    failureRedirect: `/ops/shipping`,
    successLogEvent: "ops.shipping.purchase_label.applied",
    failureLogEvent: "ops.shipping.purchase_label.failed",
  });
}
