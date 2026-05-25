// Minimal typed HTTP client for the FedEx REST API.
//
// Scope: the endpoints `PurchaseShipmentLabel` needs, expressed as
// FedEx's two-step "rate then create shipment" flow:
//
//   - POST /oauth/token             — OAuth2 client_credentials.
//                                     Caches the access token in
//                                     memory until ~30s before
//                                     expiry.
//   - POST /rate/v1/rates/quotes    — get rates for a shipment.
//   - POST /ship/v1/shipments       — create a shipment with the
//                                     selected service (returns
//                                     master tracking number,
//                                     label content URL).
//
// Auth model: FedEx returns a Bearer access token from
// `client_credentials`. The client owns the cache; consumers don't
// need to interact with it. Tokens are valid for ~1 hour in
// production; we treat anything <30s remaining as expired.
//
// PHI: addresses are sent to FedEx in cleartext (required to print
// the label). The client never logs request/response bodies.
//
// FedEx-account context: `accountNumber` is a per-credential value
// (`carrier_credential.carrierAccountId`) — FedEx requires it on
// every rate and ship call.

import { errors } from "@pharmax/platform-core";

export interface FedExClientOptions {
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly accountNumber: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly tokenSafetyWindowMs?: number;
}

export class FedExApiError extends Error {
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
    this.name = "FedExApiError";
    this.code = input.code;
    this.httpStatus = input.httpStatus;
    this.providerErrorCode = input.providerErrorCode ?? null;
  }
}

export interface FedExAddressPayload {
  readonly streetLines: ReadonlyArray<string>;
  readonly city: string;
  readonly stateOrProvinceCode: string;
  readonly postalCode: string;
  readonly countryCode: string;
}

export interface FedExContactPayload {
  readonly personName: string;
  readonly phoneNumber?: string;
  readonly emailAddress?: string;
}

export interface FedExShipperOrRecipient {
  readonly contact: FedExContactPayload;
  readonly address: FedExAddressPayload;
}

export interface FedExPackagePayload {
  readonly weight: { readonly units: "LB" | "KG"; readonly value: number };
  readonly dimensions?: {
    readonly length: number;
    readonly width: number;
    readonly height: number;
    readonly units: "IN" | "CM";
  };
}

export interface FedExRateQuoteRequest {
  readonly accountNumber: { readonly value: string };
  readonly requestedShipment: {
    readonly shipper: FedExShipperOrRecipient;
    readonly recipient: FedExShipperOrRecipient;
    readonly pickupType: "USE_SCHEDULED_PICKUP" | "DROPOFF_AT_FEDEX_LOCATION";
    readonly packagingType: "YOUR_PACKAGING";
    readonly rateRequestType: ReadonlyArray<"LIST" | "ACCOUNT">;
    readonly requestedPackageLineItems: ReadonlyArray<FedExPackagePayload>;
  };
}

export interface FedExRateReplyDetail {
  readonly serviceType: string;
  readonly serviceName: string;
  readonly ratedShipmentDetails: ReadonlyArray<{
    readonly totalNetCharge: number;
    readonly currency?: string;
  }>;
}

export interface FedExRateQuoteResponse {
  readonly output: {
    readonly rateReplyDetails: ReadonlyArray<FedExRateReplyDetail>;
  };
}

export interface FedExShipRequest {
  readonly accountNumber: { readonly value: string };
  readonly labelResponseOptions: "URL_ONLY" | "LABEL";
  readonly requestedShipment: {
    readonly shipper: FedExShipperOrRecipient;
    readonly recipients: ReadonlyArray<FedExShipperOrRecipient>;
    readonly serviceType: string;
    readonly packagingType: "YOUR_PACKAGING";
    readonly pickupType: "USE_SCHEDULED_PICKUP" | "DROPOFF_AT_FEDEX_LOCATION";
    readonly shippingChargesPayment: {
      readonly paymentType: "SENDER";
      readonly payor: {
        readonly responsibleParty: { readonly accountNumber: { readonly value: string } };
      };
    };
    readonly labelSpecification: {
      readonly imageType: "PDF" | "ZPLII";
      readonly labelStockType: "PAPER_4X6" | "STOCK_4X6" | "STOCK_4X8" | "STOCK_4X9";
    };
    readonly requestedPackageLineItems: ReadonlyArray<FedExPackagePayload>;
  };
}

export interface FedExShipResponse {
  readonly output: {
    readonly transactionShipments: ReadonlyArray<{
      readonly masterTrackingNumber: string;
      readonly serviceType: string;
      readonly serviceName?: string;
      readonly pieceResponses: ReadonlyArray<{
        readonly trackingNumber: string;
        readonly packageDocuments?: ReadonlyArray<{
          readonly url?: string;
          /**
           * Base64-encoded label payload. Present when the ship
           * request used `labelResponseOptions: "LABEL"` — FedEx
           * inlines the PDF/ZPL bytes here instead of returning a
           * URL the caller has to download.
           */
          readonly encodedLabel?: string;
          readonly contentType?: string;
        }>;
      }>;
      readonly shipmentDocuments?: ReadonlyArray<{
        readonly url?: string;
        readonly encodedLabel?: string;
        readonly contentType?: string;
      }>;
      readonly shipmentRating?: {
        readonly shipmentRateDetails: ReadonlyArray<{
          readonly totalNetCharge: number;
          readonly currency?: string;
        }>;
      };
    }>;
  };
}

export interface FedExCancelShipmentRequest {
  readonly accountNumber: { readonly value: string };
  readonly trackingNumber: string;
}

export interface FedExCancelShipmentResponse {
  readonly output?: {
    readonly cancelledShipment?: boolean;
    readonly message?: string;
  };
}

/**
 * Track API request body. We send a single tracking number per call
 * here; batching is a thin wrapper at the client level.
 */
export interface FedExTrackRequest {
  readonly includeDetailedScans: boolean;
  readonly trackingInfo: ReadonlyArray<{
    readonly trackingNumberInfo: { readonly trackingNumber: string };
  }>;
}

export interface FedExScanEvent {
  readonly date?: string;
  readonly eventType?: string;
  readonly eventDescription?: string;
  readonly derivedStatusCode?: string;
  readonly derivedStatus?: string;
  readonly scanLocation?: {
    readonly city?: string;
    readonly stateOrProvinceCode?: string;
    readonly countryCode?: string;
  };
}

export interface FedExTrackResult {
  readonly trackingNumber?: string;
  readonly latestStatusDetail?: {
    readonly code?: string;
    readonly statusByLocale?: string;
    readonly description?: string;
    readonly derivedCode?: string;
    readonly scanLocation?: {
      readonly city?: string;
      readonly stateOrProvinceCode?: string;
      readonly countryCode?: string;
    };
  };
  readonly dateAndTimes?: ReadonlyArray<{
    readonly type?: string;
    readonly dateTime?: string;
  }>;
  readonly deliveryDetails?: {
    readonly receivedByName?: string;
  };
  readonly scanEvents?: ReadonlyArray<FedExScanEvent>;
  readonly error?: { readonly code?: string; readonly message?: string };
}

export interface FedExTrackResponse {
  readonly output: {
    readonly completeTrackResults: ReadonlyArray<{
      readonly trackingNumber?: string;
      readonly trackResults: ReadonlyArray<FedExTrackResult>;
    }>;
  };
}

const DEFAULT_BASE_URL = "https://apis.fedex.com";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_TOKEN_SAFETY_WINDOW_MS = 30_000;

interface CachedToken {
  readonly accessToken: string;
  readonly expiresAtMs: number;
}

interface FedExTokenResponse {
  readonly access_token: string;
  readonly expires_in: number;
  readonly token_type: string;
}

export class FedExClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly accountNumberValue: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly tokenSafetyWindowMs: number;
  private cachedToken: CachedToken | null = null;

  public constructor(options: FedExClientOptions) {
    if (options.apiKey.length === 0 || options.apiSecret.length === 0) {
      throw new errors.InternalError({
        code: "FEDEX_CLIENT_NO_CREDENTIALS",
        message: "FedExClient requires non-empty apiKey and apiSecret.",
      });
    }
    if (options.accountNumber.length === 0) {
      throw new errors.InternalError({
        code: "FEDEX_CLIENT_NO_ACCOUNT_NUMBER",
        message: "FedExClient requires a non-empty accountNumber.",
      });
    }
    this.apiKey = options.apiKey;
    this.apiSecret = options.apiSecret;
    this.accountNumberValue = options.accountNumber;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.tokenSafetyWindowMs = options.tokenSafetyWindowMs ?? DEFAULT_TOKEN_SAFETY_WINDOW_MS;
  }

  public get accountNumber(): string {
    return this.accountNumberValue;
  }

  public async getAccessToken(now: Date = new Date()): Promise<string> {
    const safetyHorizon = now.getTime() + this.tokenSafetyWindowMs;
    if (this.cachedToken !== null && this.cachedToken.expiresAtMs > safetyHorizon) {
      return this.cachedToken.accessToken;
    }

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.apiKey,
      client_secret: this.apiSecret,
    });

    const response = await this.rawRequest("/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const parsed = (await this.parseJsonBody(response, "POST /oauth/token")) as FedExTokenResponse;

    if (typeof parsed.access_token !== "string" || typeof parsed.expires_in !== "number") {
      throw new FedExApiError({
        code: "FEDEX_OAUTH_INVALID_RESPONSE",
        message: "FedEx OAuth response missing access_token / expires_in.",
        httpStatus: response.status,
      });
    }

    this.cachedToken = {
      accessToken: parsed.access_token,
      expiresAtMs: now.getTime() + parsed.expires_in * 1000,
    };
    return this.cachedToken.accessToken;
  }

  public async rateQuote(body: FedExRateQuoteRequest): Promise<FedExRateQuoteResponse> {
    return this.bearerRequest<FedExRateQuoteResponse>("POST", "/rate/v1/rates/quotes", body);
  }

  public async createShipment(body: FedExShipRequest): Promise<FedExShipResponse> {
    return this.bearerRequest<FedExShipResponse>("POST", "/ship/v1/shipments", body);
  }

  /**
   * Cancel / void a label by tracking number. FedEx accepts PUT
   * `/ship/v1/shipments/cancel` and returns a void confirmation.
   * Cancelling an already-cancelled label is treated as success by
   * FedEx (the response payload still indicates `cancelledShipment:
   * true` or a "no cancellable shipment" message that we surface as
   * idempotent success at the adapter layer).
   */
  public async cancelShipment(
    body: FedExCancelShipmentRequest
  ): Promise<FedExCancelShipmentResponse> {
    return this.bearerRequest<FedExCancelShipmentResponse>(
      "PUT",
      "/ship/v1/shipments/cancel",
      body
    );
  }

  /**
   * Track a single shipment. FedEx's Track API accepts up to 30
   * tracking numbers per request; `trackShipmentBatch` below wraps
   * that for callers that already have a batch.
   */
  public async trackShipment(trackingNumber: string): Promise<FedExTrackResponse> {
    if (trackingNumber.length === 0) {
      throw new errors.InternalError({
        code: "FEDEX_CLIENT_NO_TRACKING_NUMBER",
        message: "trackShipment requires a non-empty trackingNumber.",
      });
    }
    const body: FedExTrackRequest = {
      includeDetailedScans: true,
      trackingInfo: [{ trackingNumberInfo: { trackingNumber } }],
    };
    return this.bearerRequest<FedExTrackResponse>("POST", "/track/v1/trackingnumbers", body);
  }

  /**
   * Batch-track shipments. FedEx allows up to 30 tracking numbers
   * per call; we split larger inputs into chunks and merge the
   * results. Callers handling thousands of shipments should rate-
   * limit themselves (FedEx's Track API has a per-account QPS cap).
   */
  public async trackShipmentBatch(
    trackingNumbers: ReadonlyArray<string>
  ): Promise<FedExTrackResponse> {
    const BATCH_SIZE = 30;
    if (trackingNumbers.length === 0) {
      return { output: { completeTrackResults: [] } };
    }
    if (trackingNumbers.length <= BATCH_SIZE) {
      const body: FedExTrackRequest = {
        includeDetailedScans: true,
        trackingInfo: trackingNumbers.map((trackingNumber) => ({
          trackingNumberInfo: { trackingNumber },
        })),
      };
      return this.bearerRequest<FedExTrackResponse>("POST", "/track/v1/trackingnumbers", body);
    }

    const merged: Array<FedExTrackResponse["output"]["completeTrackResults"][number]> = [];
    for (let i = 0; i < trackingNumbers.length; i += BATCH_SIZE) {
      const slice = trackingNumbers.slice(i, i + BATCH_SIZE);
      const body: FedExTrackRequest = {
        includeDetailedScans: true,
        trackingInfo: slice.map((trackingNumber) => ({
          trackingNumberInfo: { trackingNumber },
        })),
      };
      const response = await this.bearerRequest<FedExTrackResponse>(
        "POST",
        "/track/v1/trackingnumbers",
        body
      );
      merged.push(...response.output.completeTrackResults);
    }
    return { output: { completeTrackResults: merged } };
  }

  private async bearerRequest<T>(method: "POST" | "PUT", path: string, body: unknown): Promise<T> {
    const token = await this.getAccessToken();
    const response = await this.rawRequest(path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    return (await this.parseJsonBody(response, `${method} ${path}`)) as T;
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
        throw new FedExApiError({
          code: "FEDEX_REQUEST_TIMEOUT",
          message: `FedEx ${init.method ?? "GET"} ${path} timed out after ${this.timeoutMs}ms.`,
          httpStatus: 0,
        });
      }
      throw new FedExApiError({
        code: "FEDEX_REQUEST_FAILED",
        message: `FedEx ${init.method ?? "GET"} ${path} failed: ${
          cause instanceof Error ? cause.message : "unknown"
        }`,
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
        throw new FedExApiError({
          code: "FEDEX_RESPONSE_INVALID_JSON",
          message: `FedEx ${label} returned non-JSON body (status ${response.status}).`,
          httpStatus: response.status,
        });
      }
    }
    if (!response.ok) {
      const providerError = extractFedExError(json);
      throw new FedExApiError({
        code: providerError.code ?? `FEDEX_HTTP_${response.status}`,
        message: providerError.message ?? `FedEx ${label} failed with HTTP ${response.status}.`,
        httpStatus: response.status,
        providerErrorCode: providerError.code,
      });
    }
    return json;
  }
}

function extractFedExError(json: unknown): { code: string | null; message: string | null } {
  if (typeof json !== "object" || json === null) {
    return { code: null, message: null };
  }
  const errorsArr = (json as { errors?: unknown }).errors;
  if (Array.isArray(errorsArr) && errorsArr.length > 0) {
    const first = errorsArr[0] as { code?: unknown; message?: unknown };
    return {
      code: typeof first.code === "string" ? first.code : null,
      message: typeof first.message === "string" ? first.message : null,
    };
  }
  return { code: null, message: null };
}
