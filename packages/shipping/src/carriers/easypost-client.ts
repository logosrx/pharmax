// Minimal typed HTTP client for the EasyPost REST API.
//
// Scope: only the endpoints `PurchaseShipmentLabel` needs:
//   - POST /v2/shipments           — create a shipment with rates
//   - POST /v2/shipments/:id/buy   — buy a chosen rate (returns label,
//                                     tracking_code, tracker)
//
// Why a hand-rolled client instead of the official `easypost-node` SDK:
//   1. The SDK pulls in additional transitive deps we don't need.
//   2. Constructor injection of `fetch` lets the adapter+command
//      tests use a stub without monkey-patching globals.
//   3. The wire shapes are stable and small enough to type by hand.
//
// Auth: EasyPost uses HTTP Basic with the API key as the username and
// an empty password (`Authorization: Basic <base64(api_key:)>`).
//
// PHI: addresses are sent to EasyPost in cleartext because the
// carrier needs them to print the label. The client never logs
// request/response bodies — only status codes + the EasyPost-supplied
// `error.code` from failures.

import { errors } from "@pharmax/platform-core";

export interface EasyPostAddressPayload {
  readonly name: string;
  readonly street1: string;
  readonly street2?: string;
  readonly city: string;
  readonly state: string;
  readonly zip: string;
  readonly country: string;
  readonly phone?: string;
  readonly email?: string;
}

export interface EasyPostParcelPayload {
  readonly length: number;
  readonly width: number;
  readonly height: number;
  readonly weight: number;
}

export interface EasyPostCreateShipmentRequest {
  readonly shipment: {
    readonly from_address: EasyPostAddressPayload;
    readonly to_address: EasyPostAddressPayload;
    readonly parcel: EasyPostParcelPayload;
  };
}

export interface EasyPostRate {
  readonly id: string;
  readonly carrier: string;
  readonly service: string;
  readonly rate: string;
  readonly currency: string;
}

export interface EasyPostShipment {
  readonly id: string;
  readonly rates: ReadonlyArray<EasyPostRate>;
  readonly tracking_code?: string | null;
  readonly tracker?: { readonly id: string } | null;
  readonly postage_label?: { readonly label_url?: string | null } | null;
  readonly selected_rate?: EasyPostRate | null;
}

export interface EasyPostBuyShipmentRequest {
  readonly rate: { readonly id: string };
}

export interface EasyPostClientOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export class EasyPostApiError extends Error {
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
    this.name = "EasyPostApiError";
    this.code = input.code;
    this.httpStatus = input.httpStatus;
    this.providerErrorCode = input.providerErrorCode ?? null;
  }
}

const DEFAULT_BASE_URL = "https://api.easypost.com";
const DEFAULT_TIMEOUT_MS = 15_000;

export class EasyPostClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  public constructor(options: EasyPostClientOptions) {
    if (options.apiKey.length === 0) {
      throw new errors.InternalError({
        code: "EASYPOST_CLIENT_NO_API_KEY",
        message: "EasyPostClient requires a non-empty apiKey.",
      });
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  public async createShipment(body: EasyPostCreateShipmentRequest): Promise<EasyPostShipment> {
    return this.request<EasyPostShipment>("POST", "/v2/shipments", body);
  }

  public async buyShipment(
    shipmentId: string,
    body: EasyPostBuyShipmentRequest
  ): Promise<EasyPostShipment> {
    if (shipmentId.length === 0) {
      throw new errors.InternalError({
        code: "EASYPOST_CLIENT_NO_SHIPMENT_ID",
        message: "buyShipment requires a non-empty shipmentId.",
      });
    }
    return this.request<EasyPostShipment>(
      "POST",
      `/v2/shipments/${encodeURIComponent(shipmentId)}/buy`,
      body
    );
  }

  private async request<T>(method: "POST" | "GET", path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const authHeader = `Basic ${Buffer.from(`${this.apiKey}:`, "utf8").toString("base64")}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        signal: controller.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      if (cause instanceof Error && cause.name === "AbortError") {
        throw new EasyPostApiError({
          code: "EASYPOST_REQUEST_TIMEOUT",
          message: `EasyPost ${method} ${path} timed out after ${this.timeoutMs}ms.`,
          httpStatus: 0,
        });
      }
      throw new EasyPostApiError({
        code: "EASYPOST_REQUEST_FAILED",
        message: `EasyPost ${method} ${path} failed: ${cause instanceof Error ? cause.message : "unknown"}`,
        httpStatus: 0,
      });
    } finally {
      clearTimeout(timeout);
    }

    const text = await response.text();
    let json: unknown;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new EasyPostApiError({
          code: "EASYPOST_RESPONSE_INVALID_JSON",
          message: `EasyPost ${method} ${path} returned non-JSON body (status ${response.status}).`,
          httpStatus: response.status,
        });
      }
    }

    if (!response.ok) {
      const providerError = extractProviderError(json);
      throw new EasyPostApiError({
        code: providerError.code ?? `EASYPOST_HTTP_${response.status}`,
        message:
          providerError.message ??
          `EasyPost ${method} ${path} failed with HTTP ${response.status}.`,
        httpStatus: response.status,
        providerErrorCode: providerError.code,
      });
    }

    return json as T;
  }
}

function extractProviderError(json: unknown): { code: string | null; message: string | null } {
  if (typeof json !== "object" || json === null) {
    return { code: null, message: null };
  }
  const error = (json as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) {
    return { code: null, message: null };
  }
  const codeRaw = (error as { code?: unknown }).code;
  const messageRaw = (error as { message?: unknown }).message;
  return {
    code: typeof codeRaw === "string" ? codeRaw : null,
    message: typeof messageRaw === "string" ? messageRaw : null,
  };
}
