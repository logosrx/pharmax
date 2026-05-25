// UPS implementation of `ShippingAdapter`.
//
// Service code mapping: UPS uses 2-character codes (`03` Ground,
// `02` 2nd Day Air, `01` Next Day Air, etc.). The domain
// `serviceLevel` value is translated case-insensitively to those
// codes; the caller can also pass the raw code directly.

import { ShipmentCarrier } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";

import type {
  PurchaseLabelInput,
  PurchasedLabel,
  ShippingAdapter,
  ShippingAddress,
} from "./shipping-adapter.js";
import {
  UpsApiError,
  type UpsAddressPayload,
  type UpsClient,
  type UpsPackage,
  type UpsShipRequest,
} from "./ups-client.js";

const SERVICE_LEVEL_TO_UPS_CODE: Readonly<Record<string, string>> = Object.freeze({
  ground: "03",
  "3day": "12",
  "3-day": "12",
  "3_day_select": "12",
  "2day": "02",
  "2-day": "02",
  "2nd_day_air": "02",
  next_day_air: "01",
  next_day_air_saver: "13",
  next_day_air_early: "14",
  worldwide_express: "07",
  worldwide_expedited: "08",
  standard: "11",
  worldwide_saver: "65",
});

function toUpsServiceCode(serviceLevel: string): string {
  const normalized = serviceLevel.toLowerCase().replace(/[\s-]+/g, "_");
  return SERVICE_LEVEL_TO_UPS_CODE[normalized] ?? serviceLevel;
}

function mapAddress(address: ShippingAddress): UpsAddressPayload {
  return {
    AddressLine:
      address.street2 !== undefined ? [address.street1, address.street2] : [address.street1],
    City: address.city,
    StateProvinceCode: address.state,
    PostalCode: address.postalCode,
    CountryCode: address.country,
  };
}

export interface UpsShippingAdapterOptions {
  readonly client: UpsClient;
}

export class UpsShippingAdapter implements ShippingAdapter {
  public readonly providerName = "ups" as const;

  public constructor(private readonly options: UpsShippingAdapterOptions) {}

  public async purchaseLabel(input: PurchaseLabelInput): Promise<PurchasedLabel> {
    if (input.carrier !== ShipmentCarrier.UPS && input.carrier !== ShipmentCarrier.OTHER) {
      throw new errors.ValidationError({
        code: "UPS_CARRIER_MISMATCH",
        message: `UpsShippingAdapter cannot fulfill carrier=${input.carrier}.`,
      });
    }

    const serviceCode = toUpsServiceCode(input.serviceLevel);

    const pkg: UpsPackage = {
      Packaging: { Code: "02" },
      Dimensions: {
        UnitOfMeasurement: { Code: "IN" },
        Length: String(input.parcel.lengthInches),
        Width: String(input.parcel.widthInches),
        Height: String(input.parcel.heightInches),
      },
      PackageWeight: {
        UnitOfMeasurement: { Code: "LBS" },
        Weight: (input.parcel.weightOunces / 16).toFixed(2),
      },
    };

    const shipRequest: UpsShipRequest = {
      ShipmentRequest: {
        Request: { RequestOption: "nonvalidate" },
        Shipment: {
          Description: "Pharmax shipment",
          Shipper: {
            Name: input.fromAddress.name,
            ShipperNumber: this.options.client.shipperNumber,
            ...(input.fromAddress.phone !== undefined
              ? { Phone: { Number: input.fromAddress.phone } }
              : {}),
            ...(input.fromAddress.email !== undefined
              ? { EMailAddress: input.fromAddress.email }
              : {}),
            Address: mapAddress(input.fromAddress),
          },
          ShipTo: {
            Name: input.toAddress.name,
            ...(input.toAddress.phone !== undefined
              ? { Phone: { Number: input.toAddress.phone } }
              : {}),
            ...(input.toAddress.email !== undefined ? { EMailAddress: input.toAddress.email } : {}),
            Address: mapAddress(input.toAddress),
          },
          PaymentInformation: {
            ShipmentCharge: {
              Type: "01",
              BillShipper: { AccountNumber: this.options.client.shipperNumber },
            },
          },
          Service: { Code: serviceCode },
          Package: [pkg],
        },
        LabelSpecification: {
          LabelImageFormat: { Code: "PNG" },
        },
      },
    };

    let bought;
    try {
      bought = await this.options.client.createShipment(shipRequest);
    } catch (cause) {
      throw wrapUpsError("UPS_SHIP_FAILED", cause);
    }

    const results = bought.ShipmentResponse.ShipmentResults;
    const externalShipmentId = results.ShipmentIdentificationNumber;
    const pkgResults = results.PackageResults;
    const firstPackage = Array.isArray(pkgResults) ? pkgResults[0] : pkgResults;
    if (firstPackage === undefined) {
      throw new errors.InternalError({
        code: "UPS_SHIP_NO_PACKAGE_RESULT",
        message: "UPS ship response had no PackageResults entry.",
      });
    }
    const trackingNumber = firstPackage.TrackingNumber;
    if (typeof trackingNumber !== "string" || trackingNumber.length === 0) {
      throw new errors.InternalError({
        code: "UPS_NO_TRACKING_NUMBER",
        message: "UPS ship response did not include a tracking number.",
      });
    }

    const totalCharges = results.ShipmentCharges?.TotalCharges?.MonetaryValue;
    const postageRateCents =
      typeof totalCharges === "string" && Number.isFinite(Number.parseFloat(totalCharges))
        ? Math.round(Number.parseFloat(totalCharges) * 100)
        : null;

    const graphicImage = firstPackage.ShippingLabel?.GraphicImage;
    return {
      carrier: ShipmentCarrier.UPS,
      serviceLevel: serviceCode,
      trackingNumber,
      externalShipmentId,
      externalTrackerId: null,
      // UPS returns the label as base64-encoded image data (PNG by
      // default for our request). Surface it on `labelPdfBase64`
      // even though the bytes are PNG, not PDF — the field is the
      // standardized "inline label payload" slot; format hints are
      // outside this slice's scope.
      labelUrl: null,
      labelPdfBase64:
        typeof graphicImage === "string" && graphicImage.length > 0 ? graphicImage : null,
      postageRateCents,
    };
  }
}

function wrapUpsError(code: string, cause: unknown): Error {
  if (cause instanceof UpsApiError) {
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
  return new errors.InternalError({ code, message: "Unknown UPS error." });
}
