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

/**
 * Delivery signature requirement. Carrier-agnostic names; each
 * adapter maps to its provider's codes.
 *
 * Compliance note: prescription shipments — controlled substances
 * especially — often REQUIRE direct or adult signature. Adapters
 * that cannot honor a requested option MUST throw
 * (`SIGNATURE_OPTION_UNSUPPORTED`), never silently downgrade: a
 * package that ships without its required signature is a compliance
 * incident, not a fallback.
 */
export type SignatureOption = "NO_SIGNATURE_REQUIRED" | "INDIRECT" | "DIRECT" | "ADULT";

export interface PurchaseLabelInput {
  readonly fromAddress: ShippingAddress;
  readonly toAddress: ShippingAddress;
  readonly parcel: ShippingParcel;
  readonly carrier: ShipmentCarrier;
  readonly serviceLevel: string;
  /**
   * Omitted → the carrier's service default (no special service
   * requested on the label).
   */
  readonly signatureOption?: SignatureOption;
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

/**
 * Normalized deliverability verdict from a carrier address check.
 *
 *   - CONFIRMED   — carrier confirms the address as deliverable
 *                   (FedEx: DPV true).
 *   - UNCONFIRMED — the address resolved but the carrier could not
 *                   confirm the delivery point. Callers should
 *                   PROCEED (blocking here would false-positive on
 *                   new construction, rural routes, suites).
 *   - INVALID     — the carrier could not resolve the address at
 *                   all. Callers should block before spending money
 *                   on a label.
 */
export type AddressDeliverability = "CONFIRMED" | "UNCONFIRMED" | "INVALID";

export interface AddressValidationResult {
  readonly deliverability: AddressDeliverability;
  /** BUSINESS / RESIDENTIAL / MIXED / UNKNOWN (carrier-normalized). */
  readonly classification: string | null;
}

export interface GetRatesInput {
  readonly fromAddress: ShippingAddress;
  readonly toAddress: ShippingAddress;
  readonly parcel: ShippingParcel;
}

/**
 * One purchasable service option from a rate-shopping call.
 * `serviceLevel` is the carrier service code, directly usable as
 * `PurchaseLabelInput.serviceLevel` — quote → pick → buy round-trips
 * without translation.
 */
export interface RateQuoteOption {
  readonly carrier: ShipmentCarrier;
  readonly serviceLevel: string;
  /** Human-readable service name when the carrier provides one. */
  readonly serviceName: string | null;
  readonly rateCents: number;
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
  /**
   * Validate a destination address against the carrier's address
   * database BEFORE purchasing a label. Providers without a
   * validation API omit this; callers feature-check.
   *
   * Availability contract: implementations should throw only for
   * transport/API failures — the CALLER decides whether to fail
   * open (a validation-service outage must not block shipping).
   */
  validateAddress?(input: ShippingAddress): Promise<AddressValidationResult>;
  /**
   * Quote every purchasable service for a shipment (rate shopping)
   * WITHOUT buying anything. Providers without a rating API omit
   * this; callers feature-check. Returned options sort cheapest
   * first.
   */
  getRates?(input: GetRatesInput): Promise<ReadonlyArray<RateQuoteOption>>;
}
