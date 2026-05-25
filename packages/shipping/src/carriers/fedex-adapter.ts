// FedEx implementation of `ShippingAdapter`.
//
// Production tuning informed by the EONPRO reference implementation
// (FedEx integration battle-tested against real labels):
//   - `labelResponseOptions: "LABEL"` returns the PDF inline as
//     base64 — surfaced to callers via `PurchasedLabel.labelPdfBase64`
//     so the print path doesn't need a second HTTP fetch.
//   - Full label spec (`PAPER_4X6`, `COMMON2D`, orientation, rotation)
//     matches what FedEx thermal printers expect out of the box.
//   - `pickupType: "DROPOFF_AT_FEDEX_LOCATION"` is the safe default
//     for outbound pharmacy shipments; ops controls per-account
//     pickup via the FedEx dashboard.
//   - Phone numbers are stripped of non-digits per FedEx's contact
//     schema (otherwise FedEx rejects formatted "+1 (212) 555-..."
//     strings with a confusing error).
//   - `shipDatestamp` defaults to today in America/New_York (FedEx
//     uses this as the carrier's pickup date, not when the label was
//     printed).
//   - Ship goes directly without a rate-quote round-trip — FedEx
//     bills based on the served service type and surfaces total net
//     charge in the ship response, so the extra hop only adds
//     latency. Use `client.rateQuote()` separately for explicit
//     rate-shopping flows.
//
// Service-type mapping: callers pass a Pharmax-friendly serviceLevel
// like `"ground"`, `"priority_overnight"`. The adapter looks the
// label up against `FEDEX_SERVICE_TYPES`; if no match, it passes the
// upper-cased value straight through so unknown future codes still
// work without a code change.

import { ShipmentCarrier } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";

import {
  FedExApiError,
  type FedExClient,
  type FedExShipRequest,
  type FedExShipperOrRecipient,
} from "./fedex-client.js";
import type {
  CancelLabelResult,
  PurchaseLabelInput,
  PurchasedLabel,
  ShippingAdapter,
  ShippingAddress,
} from "./shipping-adapter.js";

const SERVICE_LEVEL_TO_FEDEX_CODE: Readonly<Record<string, string>> = Object.freeze({
  ground: "FEDEX_GROUND",
  home_delivery: "GROUND_HOME_DELIVERY",
  "2day": "FEDEX_2_DAY",
  "2_day": "FEDEX_2_DAY",
  "2_day_am": "FEDEX_2_DAY_AM",
  express_saver: "FEDEX_EXPRESS_SAVER",
  standard_overnight: "STANDARD_OVERNIGHT",
  priority_overnight: "PRIORITY_OVERNIGHT",
  first_overnight: "FIRST_OVERNIGHT",
  international_priority: "INTERNATIONAL_PRIORITY",
  international_economy: "INTERNATIONAL_ECONOMY",
});

function toFedExServiceType(serviceLevel: string): string {
  const normalized = serviceLevel.toLowerCase().replace(/[\s-]+/g, "_");
  return SERVICE_LEVEL_TO_FEDEX_CODE[normalized] ?? serviceLevel.toUpperCase();
}

function normalizePhone(phone: string | undefined): string | undefined {
  if (phone === undefined) return undefined;
  const digits = phone.replace(/\D/g, "");
  return digits.length > 0 ? digits : undefined;
}

function todayInTimezone(tz = "America/New_York"): string {
  // ICU's "en-CA" locale returns YYYY-MM-DD — the format FedEx
  // expects for shipDatestamp.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function mapShipperOrRecipient(address: ShippingAddress): FedExShipperOrRecipient {
  const phone = normalizePhone(address.phone);
  return {
    contact: {
      personName: address.name,
      ...(phone !== undefined ? { phoneNumber: phone } : {}),
      ...(address.email !== undefined ? { emailAddress: address.email } : {}),
    },
    address: {
      streetLines:
        address.street2 !== undefined ? [address.street1, address.street2] : [address.street1],
      city: address.city,
      stateOrProvinceCode: address.state,
      postalCode: address.postalCode,
      countryCode: address.country,
    },
  };
}

export interface FedExShippingAdapterOptions {
  readonly client: FedExClient;
  /**
   * Default pickup type. EONPRO defaults to `DROPOFF_AT_FEDEX_LOCATION`
   * which is the safe choice for pharmacies that walk packages to a
   * counter. Override per-deployment when a scheduled pickup is in
   * place at the org's account.
   */
  readonly pickupType?: "USE_SCHEDULED_PICKUP" | "DROPOFF_AT_FEDEX_LOCATION";
  /**
   * Label timezone for `shipDatestamp` resolution. Defaults to
   * America/New_York; override when the org is on a different coast.
   */
  readonly shipDatestampTimezone?: string;
}

export class FedExShippingAdapter implements ShippingAdapter {
  public readonly providerName = "fedex" as const;
  private readonly pickupType: "USE_SCHEDULED_PICKUP" | "DROPOFF_AT_FEDEX_LOCATION";
  private readonly shipDatestampTimezone: string;

  public constructor(private readonly options: FedExShippingAdapterOptions) {
    this.pickupType = options.pickupType ?? "DROPOFF_AT_FEDEX_LOCATION";
    this.shipDatestampTimezone = options.shipDatestampTimezone ?? "America/New_York";
  }

  public async purchaseLabel(input: PurchaseLabelInput): Promise<PurchasedLabel> {
    if (input.carrier !== ShipmentCarrier.FEDEX && input.carrier !== ShipmentCarrier.OTHER) {
      throw new errors.ValidationError({
        code: "FEDEX_CARRIER_MISMATCH",
        message: `FedExShippingAdapter cannot fulfill carrier=${input.carrier}.`,
      });
    }

    const fedexService = toFedExServiceType(input.serviceLevel);
    const shipper = mapShipperOrRecipient(input.fromAddress);
    const recipient = mapShipperOrRecipient(input.toAddress);
    const shipDatestamp = todayInTimezone(this.shipDatestampTimezone);

    const packageLineItem = {
      weight: { units: "LB" as const, value: input.parcel.weightOunces / 16 },
      dimensions: {
        length: input.parcel.lengthInches,
        width: input.parcel.widthInches,
        height: input.parcel.heightInches,
        units: "IN" as const,
      },
    };

    const shipRequest: FedExShipRequest = {
      accountNumber: { value: this.options.client.accountNumber },
      // EONPRO uses LABEL → FedEx returns the PDF bytes inline as
      // `encodedLabel` (base64). We surface those directly on
      // `PurchasedLabel.labelPdfBase64` so the print path can stream
      // to the workstation agent without a second HTTP fetch from a
      // short-lived FedEx CDN URL.
      labelResponseOptions: "LABEL",
      requestedShipment: {
        shipper,
        recipients: [recipient],
        serviceType: fedexService,
        packagingType: "YOUR_PACKAGING",
        pickupType: this.pickupType,
        shippingChargesPayment: {
          paymentType: "SENDER",
          payor: {
            responsibleParty: {
              accountNumber: { value: this.options.client.accountNumber },
            },
          },
        },
        labelSpecification: {
          imageType: "PDF",
          labelStockType: "PAPER_4X6",
        },
        requestedPackageLineItems: [packageLineItem],
      },
    };

    // FedEx's ship payload also accepts these label-tuning fields,
    // but they're typed as freeform in the SDK. Attaching them via
    // structural assignment keeps the FedExShipRequest interface
    // tight while still emitting the EONPRO-validated full spec.
    (
      shipRequest.requestedShipment.labelSpecification as unknown as Record<string, unknown>
    ).labelFormatType = "COMMON2D";
    (
      shipRequest.requestedShipment.labelSpecification as unknown as Record<string, unknown>
    ).labelPrintingOrientation = "TOP_EDGE_OF_TEXT_FIRST";
    (
      shipRequest.requestedShipment.labelSpecification as unknown as Record<string, unknown>
    ).labelRotation = "NONE";
    (shipRequest.requestedShipment as unknown as Record<string, unknown>).shipDatestamp =
      shipDatestamp;
    (shipRequest.requestedShipment as unknown as Record<string, unknown>).blockInsightVisibility =
      false;

    let bought;
    try {
      bought = await this.options.client.createShipment(shipRequest);
    } catch (cause) {
      throw wrapFedExError("FEDEX_SHIP_FAILED", cause);
    }

    const transaction = bought.output.transactionShipments[0];
    if (transaction === undefined) {
      throw new errors.InternalError({
        code: "FEDEX_SHIP_NO_TRANSACTION",
        message: "FedEx ship response had no transactionShipments entry.",
      });
    }

    const trackingNumber =
      transaction.masterTrackingNumber || transaction.pieceResponses[0]?.trackingNumber || "";
    if (trackingNumber.length === 0) {
      throw new errors.InternalError({
        code: "FEDEX_NO_TRACKING_NUMBER",
        message: "FedEx ship response did not include a tracking number.",
      });
    }

    const labelPdfBase64 =
      transaction.pieceResponses[0]?.packageDocuments?.[0]?.encodedLabel ??
      transaction.shipmentDocuments?.[0]?.encodedLabel ??
      null;
    const labelUrl =
      transaction.pieceResponses[0]?.packageDocuments?.[0]?.url ??
      transaction.shipmentDocuments?.[0]?.url ??
      null;
    const netCharge = transaction.shipmentRating?.shipmentRateDetails[0]?.totalNetCharge;
    const postageRateCents =
      typeof netCharge === "number" && Number.isFinite(netCharge)
        ? Math.round(netCharge * 100)
        : null;

    return {
      carrier: ShipmentCarrier.FEDEX,
      serviceLevel: transaction.serviceName ?? transaction.serviceType,
      trackingNumber,
      externalShipmentId: transaction.masterTrackingNumber || trackingNumber,
      externalTrackerId: null,
      labelUrl,
      labelPdfBase64,
      postageRateCents,
    };
  }

  public async cancelLabel(input: { trackingNumber: string }): Promise<CancelLabelResult> {
    let response;
    try {
      response = await this.options.client.cancelShipment({
        accountNumber: { value: this.options.client.accountNumber },
        trackingNumber: input.trackingNumber,
      });
    } catch (cause) {
      // FedEx returns a 4xx with an "INVALID.SHIPMENT.NOT_FOUND"-ish
      // code when the tracking number is already cancelled or never
      // existed. We treat those as idempotent success so retries
      // don't pollute the audit log with spurious failures.
      if (cause instanceof FedExApiError && cause.httpStatus >= 400 && cause.httpStatus < 500) {
        return Object.freeze({ cancelled: true, providerConfirmationId: null });
      }
      throw wrapFedExError("FEDEX_CANCEL_FAILED", cause);
    }
    return Object.freeze({
      cancelled: response.output?.cancelledShipment !== false,
      providerConfirmationId: response.output?.message ?? null,
    });
  }
}

function wrapFedExError(code: string, cause: unknown): Error {
  if (cause instanceof FedExApiError) {
    return new errors.InternalError({
      code,
      message: cause.message,
      metadata: {
        providerErrorCode: cause.providerErrorCode,
        httpStatus: cause.httpStatus,
      },
      cause,
    });
  }
  if (cause instanceof Error) {
    return new errors.InternalError({ code, message: cause.message, cause });
  }
  return new errors.InternalError({ code, message: "Unknown FedEx error." });
}
