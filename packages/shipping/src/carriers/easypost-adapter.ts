// EasyPost implementation of `ShippingAdapter`.
//
// Two-step purchase flow:
//   1. POST /v2/shipments       → create a shipment, get rates back.
//   2. POST /v2/shipments/:id/buy → buy the rate that matches the
//      requested (carrier, serviceLevel) pair.
//
// Carrier mapping: EasyPost reports carriers as free-form strings
// ("USPS", "UPS", "FedEx", "DHLExpress", etc.). The domain enum
// `ShipmentCarrier` has a fixed set; this module translates the two
// directions and refuses ambiguous matches (e.g. asking for `UPS`
// when EasyPost only offered USPS rates).

import { ShipmentCarrier } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";

import {
  EasyPostApiError,
  type EasyPostAddressPayload,
  type EasyPostClient,
  type EasyPostRate,
  type EasyPostShipment,
} from "./easypost-client.js";
import type {
  PurchaseLabelInput,
  PurchasedLabel,
  ShippingAdapter,
  ShippingAddress,
} from "./shipping-adapter.js";

const DOMAIN_TO_EASYPOST_CARRIER: Readonly<Record<ShipmentCarrier, ReadonlyArray<string>>> =
  Object.freeze({
    [ShipmentCarrier.USPS]: ["USPS"],
    [ShipmentCarrier.UPS]: ["UPS", "UPSDAP"],
    [ShipmentCarrier.FEDEX]: ["FedEx", "FedExSmartPost"],
    [ShipmentCarrier.DHL]: ["DHLExpress", "DHLECommerce"],
    [ShipmentCarrier.OTHER]: [],
  });

function mapAddress(address: ShippingAddress): EasyPostAddressPayload {
  return {
    name: address.name,
    street1: address.street1,
    ...(address.street2 !== undefined ? { street2: address.street2 } : {}),
    city: address.city,
    state: address.state,
    zip: address.postalCode,
    country: address.country,
    ...(address.phone !== undefined ? { phone: address.phone } : {}),
    ...(address.email !== undefined ? { email: address.email } : {}),
  };
}

function pickRate(
  rates: ReadonlyArray<EasyPostRate>,
  desired: { carrier: ShipmentCarrier; serviceLevel: string }
): EasyPostRate {
  const acceptedCarriers = DOMAIN_TO_EASYPOST_CARRIER[desired.carrier];

  const matchingService = rates.filter(
    (rate) => rate.service.toLowerCase() === desired.serviceLevel.toLowerCase()
  );

  // For OTHER, accept any carrier as long as the service matches —
  // the caller is opting into "we don't care which carrier prints it".
  const candidates =
    desired.carrier === ShipmentCarrier.OTHER
      ? matchingService
      : matchingService.filter((rate) =>
          acceptedCarriers.some((c) => c.toLowerCase() === rate.carrier.toLowerCase())
        );

  if (candidates.length === 0) {
    throw new errors.NotFoundError({
      code: "EASYPOST_NO_MATCHING_RATE",
      message: `EasyPost returned no rates matching carrier=${desired.carrier} service=${desired.serviceLevel}.`,
      metadata: {
        requestedCarrier: desired.carrier,
        requestedServiceLevel: desired.serviceLevel,
        offeredRates: rates.map((r) => ({ carrier: r.carrier, service: r.service })),
      },
    });
  }

  // Cheapest matching rate wins when multiple are available.
  return [...candidates].sort((a, b) => Number(a.rate) - Number(b.rate))[0]!;
}

function priceToCents(rate: string): number | null {
  const parsed = Number(rate);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.round(parsed * 100);
}

function reverseCarrier(provider: string): ShipmentCarrier {
  const lower = provider.toLowerCase();
  for (const [domain, providers] of Object.entries(DOMAIN_TO_EASYPOST_CARRIER) as Array<
    [ShipmentCarrier, ReadonlyArray<string>]
  >) {
    if (providers.some((p) => p.toLowerCase() === lower)) {
      return domain;
    }
  }
  return ShipmentCarrier.OTHER;
}

export interface EasyPostShippingAdapterOptions {
  readonly client: EasyPostClient;
}

export class EasyPostShippingAdapter implements ShippingAdapter {
  public readonly providerName = "easypost" as const;

  public constructor(private readonly options: EasyPostShippingAdapterOptions) {}

  public async purchaseLabel(input: PurchaseLabelInput): Promise<PurchasedLabel> {
    let created: EasyPostShipment;
    try {
      created = await this.options.client.createShipment({
        shipment: {
          from_address: mapAddress(input.fromAddress),
          to_address: mapAddress(input.toAddress),
          parcel: {
            length: input.parcel.lengthInches,
            width: input.parcel.widthInches,
            height: input.parcel.heightInches,
            weight: input.parcel.weightOunces,
          },
        },
      });
    } catch (cause) {
      throw wrapEasyPostError("EASYPOST_CREATE_SHIPMENT_FAILED", cause);
    }

    const rate = pickRate(created.rates, {
      carrier: input.carrier,
      serviceLevel: input.serviceLevel,
    });

    let bought: EasyPostShipment;
    try {
      bought = await this.options.client.buyShipment(created.id, { rate: { id: rate.id } });
    } catch (cause) {
      throw wrapEasyPostError("EASYPOST_BUY_SHIPMENT_FAILED", cause);
    }

    const trackingNumber = bought.tracking_code ?? null;
    if (trackingNumber === null || trackingNumber.length === 0) {
      throw new errors.InternalError({
        code: "EASYPOST_NO_TRACKING_CODE",
        message: "EasyPost buy-shipment response did not include a tracking_code.",
        metadata: { shipmentId: bought.id },
      });
    }

    return {
      carrier: reverseCarrier(rate.carrier),
      serviceLevel: rate.service,
      trackingNumber,
      externalShipmentId: bought.id,
      externalTrackerId: bought.tracker?.id ?? null,
      labelUrl: bought.postage_label?.label_url ?? null,
      labelPdfBase64: null,
      postageRateCents: priceToCents(rate.rate),
    };
  }
}

function wrapEasyPostError(code: string, cause: unknown): Error {
  if (cause instanceof EasyPostApiError) {
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
  return new errors.InternalError({ code, message: "Unknown EasyPost error." });
}
