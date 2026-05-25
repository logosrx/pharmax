// Minimal typed HTTP client for the UPS REST API.
//
// Scope: OAuth2 token + the v2403 Shipping API:
//
//   - POST /security/v1/oauth/token  — OAuth2 client_credentials.
//                                      Tokens cached in memory.
//   - POST /api/shipments/v2403/ship — request a shipment (returns
//                                      the tracking number and the
//                                      base64-encoded label graphic).
//
// Auth model: same shape as FedEx — HTTP Basic for the token
// exchange, Bearer for everything after.
//
// PHI: addresses go in cleartext. Bodies are never logged.
//
// Account identifier: UPS calls it the **shipper number**. We store
// it in `carrier_credential.carrierAccountId` and require it on
// every ship call.

import { errors } from "@pharmax/platform-core";

export interface UpsClientOptions {
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly shipperNumber: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly tokenSafetyWindowMs?: number;
}

export class UpsApiError extends Error {
  public readonly code: string;
  public readonly httpStatus: number;
  public readonly providerErrorCode: string | null;

  public constructor(input: {
    code: string;
    message: string;
    httpStatus: number;
    providerErrorCode?: string | null;
  }) {
    super(input.message);
    this.name = "UpsApiError";
    this.code = input.code;
    this.httpStatus = input.httpStatus;
    this.providerErrorCode = input.providerErrorCode ?? null;
  }
}

export interface UpsAddressPayload {
  readonly AddressLine: ReadonlyArray<string>;
  readonly City: string;
  readonly StateProvinceCode: string;
  readonly PostalCode: string;
  readonly CountryCode: string;
}

export interface UpsShipper {
  readonly Name: string;
  readonly AttentionName?: string;
  readonly ShipperNumber: string;
  readonly Phone?: { readonly Number: string };
  readonly EMailAddress?: string;
  readonly Address: UpsAddressPayload;
}

export interface UpsShipTo {
  readonly Name: string;
  readonly AttentionName?: string;
  readonly Phone?: { readonly Number: string };
  readonly EMailAddress?: string;
  readonly Address: UpsAddressPayload;
}

export interface UpsPackage {
  readonly Packaging: { readonly Code: "02" };
  readonly Dimensions?: {
    readonly UnitOfMeasurement: { readonly Code: "IN" | "CM" };
    readonly Length: string;
    readonly Width: string;
    readonly Height: string;
  };
  readonly PackageWeight: {
    readonly UnitOfMeasurement: { readonly Code: "LBS" | "KGS" };
    readonly Weight: string;
  };
}

export interface UpsShipRequest {
  readonly ShipmentRequest: {
    readonly Request: { readonly RequestOption: "nonvalidate" | "validate" };
    readonly Shipment: {
      readonly Description: string;
      readonly Shipper: UpsShipper;
      readonly ShipTo: UpsShipTo;
      readonly ShipFrom?: UpsShipper;
      readonly PaymentInformation: {
        readonly ShipmentCharge: {
          readonly Type: "01";
          readonly BillShipper: { readonly AccountNumber: string };
        };
      };
      readonly Service: { readonly Code: string; readonly Description?: string };
      readonly Package: ReadonlyArray<UpsPackage>;
    };
    readonly LabelSpecification: {
      readonly LabelImageFormat: { readonly Code: "PNG" | "GIF" | "ZPL" };
      readonly LabelStockSize?: { readonly Height: string; readonly Width: string };
    };
  };
}

export interface UpsShipResponse {
  readonly ShipmentResponse: {
    readonly Response: {
      readonly ResponseStatus: { readonly Code: string; readonly Description: string };
    };
    readonly ShipmentResults: {
      readonly ShipmentIdentificationNumber: string;
      readonly ShipmentCharges?: {
        readonly TotalCharges?: { readonly MonetaryValue: string; readonly CurrencyCode?: string };
      };
      readonly PackageResults:
        | ReadonlyArray<{
            readonly TrackingNumber: string;
            readonly ShippingLabel?: {
              readonly GraphicImage?: string;
              readonly ImageFormat?: { readonly Code: string };
            };
          }>
        | {
            readonly TrackingNumber: string;
            readonly ShippingLabel?: { readonly GraphicImage?: string };
          };
    };
  };
}

/**
 * UPS Track API response shape. The Track API is per-tracking-number
 * (no batch endpoint in v1), so the typed batch wrapper below
 * iterates sequentially and merges results. `currentStatus.type` is
 * the most reliable enum field for status derivation — see
 * `normalizeUpsStatus` in `ups-status.ts`.
 */
export interface UpsTrackPackage {
  readonly trackingNumber: string;
  readonly currentStatus?: {
    readonly type?: string;
    readonly description?: string;
    readonly code?: string;
  };
  readonly deliveryDate?: ReadonlyArray<{ readonly type?: string; readonly date?: string }>;
  readonly activity?: ReadonlyArray<{
    readonly date?: string;
    readonly time?: string;
    readonly status?: {
      readonly type?: string;
      readonly description?: string;
      readonly code?: string;
    };
    readonly location?: {
      readonly address?: {
        readonly city?: string;
        readonly stateProvince?: string;
        readonly country?: string;
      };
    };
  }>;
}

export interface UpsTrackResponse {
  readonly trackResponse: {
    readonly shipment: ReadonlyArray<{
      readonly package: ReadonlyArray<UpsTrackPackage>;
    }>;
  };
}

/** Aggregated batch result: one entry per requested tracking number. */
export interface UpsTrackBatchEntry {
  readonly trackingNumber: string;
  readonly package: UpsTrackPackage | null;
  readonly error: UpsApiError | null;
}

export interface UpsTrackBatchResponse {
  readonly results: ReadonlyArray<UpsTrackBatchEntry>;
}

interface UpsTokenResponse {
  readonly access_token: string;
  readonly expires_in: string | number;
  readonly token_type: string;
}

interface CachedToken {
  readonly accessToken: string;
  readonly expiresAtMs: number;
}

const DEFAULT_BASE_URL = "https://onlinetools.ups.com";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_TOKEN_SAFETY_WINDOW_MS = 30_000;

export class UpsClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly shipperNumberValue: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly tokenSafetyWindowMs: number;
  private cachedToken: CachedToken | null = null;

  public constructor(options: UpsClientOptions) {
    if (options.apiKey.length === 0 || options.apiSecret.length === 0) {
      throw new errors.InternalError({
        code: "UPS_CLIENT_NO_CREDENTIALS",
        message: "UpsClient requires non-empty apiKey and apiSecret.",
      });
    }
    if (options.shipperNumber.length === 0) {
      throw new errors.InternalError({
        code: "UPS_CLIENT_NO_SHIPPER_NUMBER",
        message: "UpsClient requires a non-empty shipperNumber.",
      });
    }
    this.apiKey = options.apiKey;
    this.apiSecret = options.apiSecret;
    this.shipperNumberValue = options.shipperNumber;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.tokenSafetyWindowMs = options.tokenSafetyWindowMs ?? DEFAULT_TOKEN_SAFETY_WINDOW_MS;
  }

  public get shipperNumber(): string {
    return this.shipperNumberValue;
  }

  public async getAccessToken(now: Date = new Date()): Promise<string> {
    const safetyHorizon = now.getTime() + this.tokenSafetyWindowMs;
    if (this.cachedToken !== null && this.cachedToken.expiresAtMs > safetyHorizon) {
      return this.cachedToken.accessToken;
    }

    const basic = Buffer.from(`${this.apiKey}:${this.apiSecret}`, "utf8").toString("base64");
    const body = new URLSearchParams({ grant_type: "client_credentials" });

    const response = await this.rawRequest("/security/v1/oauth/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "x-merchant-id": this.shipperNumberValue,
      },
      body: body.toString(),
    });
    const parsed = (await this.parseJsonBody(
      response,
      "POST /security/v1/oauth/token"
    )) as UpsTokenResponse;

    if (typeof parsed.access_token !== "string") {
      throw new UpsApiError({
        code: "UPS_OAUTH_INVALID_RESPONSE",
        message: "UPS OAuth response missing access_token.",
        httpStatus: response.status,
      });
    }
    const expiresInSec =
      typeof parsed.expires_in === "string"
        ? Number.parseInt(parsed.expires_in, 10)
        : parsed.expires_in;
    const expiresInSafe = Number.isFinite(expiresInSec) && expiresInSec > 0 ? expiresInSec : 14_400;

    this.cachedToken = {
      accessToken: parsed.access_token,
      expiresAtMs: now.getTime() + expiresInSafe * 1000,
    };
    return this.cachedToken.accessToken;
  }

  public async createShipment(body: UpsShipRequest): Promise<UpsShipResponse> {
    const token = await this.getAccessToken();
    const response = await this.rawRequest("/api/shipments/v2403/ship", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        transId: cryptoRandomId(),
        transactionSrc: "pharmax",
      },
      body: JSON.stringify(body),
    });
    return (await this.parseJsonBody(
      response,
      "POST /api/shipments/v2403/ship"
    )) as UpsShipResponse;
  }

  /**
   * Track a single shipment. UPS's Track API v1 is one tracking
   * number per call (GET `/api/track/v1/details/{inquiryNumber}`);
   * use `trackShipmentBatch` to round up many at once.
   */
  public async trackShipment(trackingNumber: string): Promise<UpsTrackResponse> {
    if (trackingNumber.length === 0) {
      throw new errors.InternalError({
        code: "UPS_CLIENT_NO_TRACKING_NUMBER",
        message: "trackShipment requires a non-empty trackingNumber.",
      });
    }
    const token = await this.getAccessToken();
    const path = `/api/track/v1/details/${encodeURIComponent(trackingNumber)}`;
    const response = await this.rawRequest(path, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        transId: cryptoRandomId(),
        transactionSrc: "pharmax",
      },
    });
    return (await this.parseJsonBody(response, `GET ${path}`)) as UpsTrackResponse;
  }

  /**
   * Sequentially track a batch of UPS shipments. UPS does not
   * publish a batch endpoint in v1, so this iterates one call per
   * tracking number with per-tracking-number error isolation —
   * a 4xx for one tracking number does not abort the rest.
   */
  public async trackShipmentBatch(
    trackingNumbers: ReadonlyArray<string>
  ): Promise<UpsTrackBatchResponse> {
    const results: UpsTrackBatchEntry[] = [];
    for (const trackingNumber of trackingNumbers) {
      try {
        const response = await this.trackShipment(trackingNumber);
        const pkg = response.trackResponse.shipment[0]?.package[0] ?? null;
        results.push(Object.freeze({ trackingNumber, package: pkg, error: null }));
      } catch (cause) {
        const wrapped =
          cause instanceof UpsApiError
            ? cause
            : new UpsApiError({
                code: "UPS_TRACK_FAILED",
                message: cause instanceof Error ? cause.message : "unknown",
                httpStatus: 0,
              });
        results.push(Object.freeze({ trackingNumber, package: null, error: wrapped }));
      }
    }
    return Object.freeze({ results });
  }

  private async rawRequest(path: string, init: RequestInit): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (cause) {
      if (cause instanceof Error && cause.name === "AbortError") {
        throw new UpsApiError({
          code: "UPS_REQUEST_TIMEOUT",
          message: `UPS ${init.method ?? "GET"} ${path} timed out after ${this.timeoutMs}ms.`,
          httpStatus: 0,
        });
      }
      throw new UpsApiError({
        code: "UPS_REQUEST_FAILED",
        message: `UPS ${init.method ?? "GET"} ${path} failed: ${cause instanceof Error ? cause.message : "unknown"}`,
        httpStatus: 0,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async parseJsonBody(response: Response, label: string): Promise<unknown> {
    const text = await response.text();
    let json: unknown;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new UpsApiError({
          code: "UPS_RESPONSE_INVALID_JSON",
          message: `UPS ${label} returned non-JSON body (status ${response.status}).`,
          httpStatus: response.status,
        });
      }
    }
    if (!response.ok) {
      const providerError = extractUpsError(json);
      throw new UpsApiError({
        code: providerError.code ?? `UPS_HTTP_${response.status}`,
        message: providerError.message ?? `UPS ${label} failed with HTTP ${response.status}.`,
        httpStatus: response.status,
        providerErrorCode: providerError.code,
      });
    }
    return json;
  }
}

function extractUpsError(json: unknown): { code: string | null; message: string | null } {
  if (typeof json !== "object" || json === null) {
    return { code: null, message: null };
  }
  const response = (json as { response?: { errors?: unknown } }).response;
  const errsArr = response?.errors;
  if (Array.isArray(errsArr) && errsArr.length > 0) {
    const first = errsArr[0] as { code?: unknown; message?: unknown };
    return {
      code: typeof first.code === "string" ? first.code : null,
      message: typeof first.message === "string" ? first.message : null,
    };
  }
  return { code: null, message: null };
}

function cryptoRandomId(): string {
  // UPS requires a per-request unique transId. crypto.randomUUID is
  // Node-native and avoids pulling in ulid for this single use.
  return globalThis.crypto.randomUUID();
}
