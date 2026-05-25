// Carrier-agnostic shipping adapter contract.
//
// The adapter is the only outbound HTTP surface in the shipping
// pipeline. Domain commands (PurchaseShipmentLabel and friends) call
// into this interface; carrier-specific code lives behind it
// (EasyPost today, others later) so the command surface stays free
// of provider-specific shapes.
//
// PHI: addresses go through the adapter unencrypted because the
// carrier needs them in cleartext to print the label. Callers MUST
// pass already-resolved shipping addresses that have been decrypted
// at the command-handler boundary; the adapter itself never reaches
// into PHI columns. Audit metadata + outbox payloads must NOT echo
// addresses — only tracking number, carrier id, postage cost.

import type { ShipmentCarrier } from "@pharmax/database";

export interface ShippingAddress {
  readonly name: string;
  readonly street1: string;
  readonly street2?: string;
  readonly city: string;
  readonly state: string;
  readonly postalCode: string;
  readonly country: string;
  readonly phone?: string;
  readonly email?: string;
}

export interface ShippingParcel {
  readonly lengthInches: number;
  readonly widthInches: number;
  readonly heightInches: number;
  readonly weightOunces: number;
}

export interface PurchaseLabelInput {
  readonly fromAddress: ShippingAddress;
  readonly toAddress: ShippingAddress;
  readonly parcel: ShippingParcel;
  readonly carrier: ShipmentCarrier;
  readonly serviceLevel: string;
}

export interface PurchasedLabel {
  readonly carrier: ShipmentCarrier;
  readonly serviceLevel: string;
  readonly trackingNumber: string;
  readonly externalShipmentId: string;
  readonly externalTrackerId: string | null;
  /** Carrier-hosted URL for the rendered label, if the provider returns one. */
  readonly labelUrl: string | null;
  /**
   * Base64-encoded label payload returned inline by the carrier (FedEx
   * does this by default with `labelResponseOptions: "LABEL"`). When
   * present, the caller can persist or stream the PDF directly without
   * a follow-up HTTP fetch — useful for thermal printers and for
   * archival to S3.
   */
  readonly labelPdfBase64: string | null;
  readonly postageRateCents: number | null;
}

export interface CancelLabelResult {
  readonly cancelled: boolean;
  /**
   * Carrier-supplied confirmation id, when available. EasyPost
   * returns the refund id; FedEx returns the cancellation message
   * id; UPS returns the void confirmation number. Stored on the
   * shipment record for audit.
   */
  readonly providerConfirmationId: string | null;
}

/**
 * Outbound carrier API. Implementations are registered per-provider
 * via `configureShipping({ factories: { EASYPOST: (ctx) => ... } })`.
 * Each factory invocation receives a `CarrierCredentialContext` with
 * the decrypted per-org API key and returns a configured adapter.
 *
 * Optional methods (`cancelLabel`, `trackShipment` — added later)
 * MAY be omitted by providers that don't support them; the caller
 * should feature-check before invoking.
 */
export interface ShippingAdapter {
  readonly providerName: "easypost" | "fedex" | "ups" | "stub";
  purchaseLabel(input: PurchaseLabelInput): Promise<PurchasedLabel>;
  /**
   * Cancel / void a previously purchased label by tracking number.
   * Implementations should be idempotent — calling `cancelLabel`
   * twice on the same tracking number should not throw on the
   * second call if the provider already considers it cancelled.
   */
  cancelLabel?(input: { trackingNumber: string }): Promise<CancelLabelResult>;
}
