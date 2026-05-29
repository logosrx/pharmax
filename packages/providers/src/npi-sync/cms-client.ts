// NPI Registry sync — slice 2: the CMS NPPES HTTP client.
//
// Wraps the CMS National Plan and Provider Enumeration System
// (NPPES) public registry API (v2.1) — the "what does CMS know
// about this NPI" data source the worker (slice 4) feeds into the
// pure diff engine (slice 1).
//
// API reference: https://npiregistry.cms.hhs.gov/api-page
//   - Public dataset, no authentication.
//   - Recommended throttle: ~10 req/sec sustained. We target 8.
//   - GET /api/?number=<NPI>&version=2.1 → { result_count, results: [...] }
//   - No batch lookup; per-NPI query (the API supports rich search
//     filters but not multi-NPI lookups in one call).
//   - Response uses snake_case; empty strings instead of null for
//     missing fields; ZIP+4 unformatted (9 contiguous digits).
//
// What this module provides:
//   - `CmsNppesClient` class with constructor-injected `fetch`,
//     `userAgent`, rate-limiter spacing, and retry policy.
//   - `client.fetchByNpi(npi)` — single-NPI lookup; throws
//     `PharmaxError` subclasses on transport / parse failure;
//     returns `CmsNpiSnapshot` on hit; returns `null` when CMS
//     confirms "not found" (result_count: 0 with a 200 response).
//   - `client.fetchManyByNpi(npis)` — batched lookup with rate
//     limiting; returns `Map<npi, CmsFetchResult>` where each
//     entry is a tagged success / failure. Per-NPI failures do
//     NOT abort the whole batch — the worker decides how to
//     handle each one.
//
// What this module DELIBERATELY does NOT do:
//   - It does not cache. Cache invalidation is a worker concern
//     (slice 4): "skip NPIs we synced in the last N hours" lives
//     on the worker's `provider_sync_check` reads, not in the
//     HTTP transport layer.
//   - It does not log. The worker is responsible for observability;
//     the client emits typed errors with metadata so the worker
//     can decide what to ship to Datadog / Sentry.
//   - It does not normalize phone formats. NPPES sends bare digits
//     ("2175550142"); we store hyphenated ("217-555-0142"). For
//     slice 2, the client preserves what NPPES sent. If false-
//     positive UPDATEs surface in production from phone-format
//     drift, slice 4's worker (or a slice-1 follow-up) adds phone
//     normalization. The principle from slice 1 applies: noise an
//     operator filters beats silent drift the audit log can't
//     explain.
//   - It does not respect a global Clock injection. The rate
//     limiter chains promises with `setTimeout` — fake-timer
//     tests cover timing assertions without needing `now()` math.
//     Retry backoff jitter uses `Math.random()`, not the clock.
//
// PHI rule:
//   - NPPES data is PUBLIC by design (the registry exists so
//     payers and pharmacies can verify prescribers' enrollment).
//     Provider NPIs, names, practice addresses, and credentials
//     are not PHI. The client therefore has no redaction logic.
//   - Defensive: we still do not log full response bodies; if a
//     future slice adds logging, it should log at most NPI +
//     result_count + http_status, never the parsed result.

import type { CmsAddress, CmsNpiSnapshot } from "./diff-engine.js";
import { errors } from "@pharmax/platform-core";

// ---------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------

/**
 * Per-NPI result for the batched `fetchManyByNpi` call. A successful
 * lookup carries either a snapshot or `null` (CMS confirmed
 * not-found); a failed lookup carries the typed error the worker
 * should persist to `provider_sync_check`.
 *
 * Designed for partial-batch resilience: one NPI's transport failure
 * does not poison the whole batch.
 */
export type CmsFetchResult =
  | { readonly ok: true; readonly snapshot: CmsNpiSnapshot | null }
  | { readonly ok: false; readonly error: errors.PharmaxError };

/** Function shape compatible with the global `fetch` API. */
export type FetchFunction = (
  input: string | URL,
  init?: { signal?: AbortSignal; headers?: Record<string, string> }
) => Promise<{
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

/** `(ms) => Promise<void>` — `setTimeout`-based by default; injectable for tests. */
export type Sleeper = (ms: number) => Promise<void>;

export interface CmsNppesClientOptions {
  /**
   * REQUIRED. CMS recommends identifying your application in
   * User-Agent so they can contact you about issues. Example:
   *   "pharmax-pharmacy-os/1.0 (contact: ops@example.com)"
   */
  readonly userAgent: string;
  /** Defaults to `https://npiregistry.cms.hhs.gov/api/`. Override for fixture servers. */
  readonly baseUrl?: string;
  /** Injected fetch (vitest / fixture servers). Defaults to global `fetch`. */
  readonly fetch?: FetchFunction;
  /** Injected sleep (vitest fake timers). Defaults to `setTimeout`-backed. */
  readonly sleep?: Sleeper;
  /**
   * Minimum ms between request START times. 125 = 8 req/s (well
   * under CMS' ~10/s ceiling). Setting to 0 disables rate limiting
   * — useful in tests.
   */
  readonly minRequestSpacingMs?: number;
  /** Default 3. Number of RETRIES after the initial attempt fails on a retryable status. */
  readonly maxRetries?: number;
  /** Default 250. Base ms for exponential backoff (attempt N = base * 2^(N-1) + jitter). */
  readonly retryBaseMs?: number;
  /** Default 5000. Upper bound for backoff (handles long Retry-After values). */
  readonly retryMaxMs?: number;
  /** Default 10000 (10s). Aborts the underlying fetch with `AbortController`. */
  readonly requestTimeoutMs?: number;
}

// ---------------------------------------------------------------------
// Internal: raw NPPES v2.1 JSON shape (snake_case)
// ---------------------------------------------------------------------

/** Minimal subset of the NPPES address record the parser reads. */
interface RawNppesAddress {
  readonly address_purpose?: string;
  readonly address_1?: string;
  readonly address_2?: string;
  readonly city?: string;
  readonly state?: string;
  readonly postal_code?: string;
  readonly telephone_number?: string;
}

interface RawNppesBasic {
  readonly first_name?: string;
  readonly last_name?: string;
  readonly credential?: string;
  /** "A" (active), "D" (deactivated), or absent/empty on legacy records (treated as active). */
  readonly status?: string;
  /** "YYYY-MM-DD". */
  readonly last_updated?: string;
}

interface RawNppesResult {
  readonly number?: string;
  readonly enumeration_type?: string;
  readonly basic?: RawNppesBasic;
  readonly addresses?: ReadonlyArray<RawNppesAddress>;
}

interface RawNppesResponse {
  readonly result_count?: number;
  readonly results?: ReadonlyArray<RawNppesResult>;
}

// ---------------------------------------------------------------------
// Error codes — exposed as constants so tests + workers can switch on them
// ---------------------------------------------------------------------

export const CMS_NPI_REGISTRY_ERRORS = Object.freeze({
  /** 4xx — bug in our request (malformed NPI, etc.). Not retryable. */
  BAD_REQUEST: "CMS_NPI_REGISTRY_BAD_REQUEST",
  /** 429 after retry exhaustion. */
  RATE_LIMITED: "CMS_NPI_REGISTRY_RATE_LIMITED",
  /** 5xx after retry exhaustion. */
  SERVER_ERROR: "CMS_NPI_REGISTRY_SERVER_ERROR",
  /** Network failure / DNS / connection reset after retry exhaustion. */
  NETWORK_ERROR: "CMS_NPI_REGISTRY_NETWORK_ERROR",
  /** AbortController timeout after retry exhaustion. */
  TIMEOUT: "CMS_NPI_REGISTRY_TIMEOUT",
  /** 2xx with body that isn't valid JSON. */
  MALFORMED_RESPONSE: "CMS_NPI_REGISTRY_MALFORMED_RESPONSE",
  /** Response JSON parsed but is missing required fields (CMS API version drift). */
  SCHEMA_MISMATCH: "CMS_NPI_REGISTRY_SCHEMA_MISMATCH",
  /** Response contains a result with `number` different from what we queried. */
  NPI_MISMATCH: "CMS_NPI_REGISTRY_NPI_MISMATCH",
  /** Some other non-2xx status we don't know how to retry. */
  UNEXPECTED_STATUS: "CMS_NPI_REGISTRY_UNEXPECTED_STATUS",
} as const);

// ---------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://npiregistry.cms.hhs.gov/api/";
const DEFAULT_MIN_REQUEST_SPACING_MS = 125; // 8 req/s
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_RETRY_MAX_MS = 5000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

const NPPES_API_VERSION = "2.1";

// ---------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------

export class CmsNppesClient {
  private readonly fetchFn: FetchFunction;
  private readonly sleepFn: Sleeper;
  private readonly userAgent: string;
  private readonly baseUrl: string;
  private readonly minRequestSpacingMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly requestTimeoutMs: number;

  /** Rate-limiter state: chained promise that fulfills when the next slot opens. */
  private nextRateSlot: Promise<void> = Promise.resolve();

  public constructor(options: CmsNppesClientOptions) {
    if (typeof options.userAgent !== "string" || options.userAgent.trim().length === 0) {
      throw new errors.InternalError({
        code: "CMS_NPI_REGISTRY_BAD_CONFIG",
        message:
          "CmsNppesClient requires a non-empty userAgent. CMS asks API consumers to identify themselves.",
      });
    }

    this.userAgent = options.userAgent;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchFn = options.fetch ?? defaultFetch;
    this.sleepFn = options.sleep ?? defaultSleep;
    this.minRequestSpacingMs = options.minRequestSpacingMs ?? DEFAULT_MIN_REQUEST_SPACING_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.retryMaxMs = options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /**
   * Look up a single NPI. Returns the parsed snapshot, or `null`
   * if CMS confirms the NPI does not exist (a 200 response with
   * `result_count: 0` — which slice 1's diff engine maps to
   * `NOT_FOUND_AT_CMS`).
   *
   * Throws `PharmaxError` subclasses (always `InternalError`)
   * for transport / parse failures.
   */
  public async fetchByNpi(npi: string): Promise<CmsNpiSnapshot | null> {
    if (!/^\d{10}$/.test(npi)) {
      throw new errors.InternalError({
        code: CMS_NPI_REGISTRY_ERRORS.BAD_REQUEST,
        message: "CmsNppesClient.fetchByNpi requires a 10-digit numeric NPI.",
        metadata: { npi },
      });
    }

    const responseText = await this.fetchWithRetry(npi);
    return parseSingleNpiResponse(npi, responseText);
  }

  /**
   * Batch lookup. Rate-limited internally; returns per-NPI results
   * so partial failures (one NPI's CMS timeout) don't poison the
   * whole batch — the worker persists failures to
   * `provider_sync_check` (slice 3) and retries on the next run.
   *
   * Result map ordering is not guaranteed; lookup by NPI key.
   */
  public async fetchManyByNpi(npis: ReadonlyArray<string>): Promise<Map<string, CmsFetchResult>> {
    const results = new Map<string, CmsFetchResult>();

    // We fire requests sequentially (not Promise.all) because the
    // rate gate already serializes their start times. Parallelism
    // would race the gate's chained-promise machinery; the rate cap
    // already implies "no useful parallelism".
    //
    // If a future slice wants higher throughput, the right shape is
    // a token-bucket + bounded-concurrency pool, not this simple gate.
    for (const npi of npis) {
      try {
        const snapshot = await this.fetchByNpi(npi);
        results.set(npi, { ok: true, snapshot });
      } catch (cause) {
        results.set(npi, { ok: false, error: toPharmaxError(cause) });
      }
    }

    return results;
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  private async fetchWithRetry(npi: string): Promise<string> {
    const url = `${this.baseUrl}?number=${encodeURIComponent(npi)}&version=${NPPES_API_VERSION}`;

    let lastError: errors.PharmaxError | null = null;
    const totalAttempts = 1 + this.maxRetries;

    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
      await this.acquireRateSlot();

      try {
        return await this.attemptFetch(url, npi);
      } catch (cause) {
        const err = toPharmaxError(cause);
        lastError = err;

        if (!isRetryable(err) || attempt === totalAttempts) {
          throw err;
        }

        const retryAfterMs = retryAfterFromError(err);
        const delayMs = retryAfterMs ?? this.computeBackoff(attempt);
        await this.sleepFn(delayMs);
      }
    }

    // Unreachable: the loop either returns or throws.
    /* c8 ignore next 5 */
    throw (
      lastError ??
      new errors.InternalError({
        code: CMS_NPI_REGISTRY_ERRORS.UNEXPECTED_STATUS,
        message: "Retry loop exited without a throw or return.",
        metadata: { npi },
      })
    );
  }

  private async attemptFetch(url: string, npi: string): Promise<string> {
    const controller = new AbortController();
    const timeoutHandle = setTimeoutCompatible(() => controller.abort(), this.requestTimeoutMs);

    try {
      const response = await this.fetchFn(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": this.userAgent,
          Accept: "application/json",
        },
      });

      if (response.status >= 200 && response.status < 300) {
        return await response.text();
      }

      if (response.status === 429) {
        throw new errors.InternalError({
          code: CMS_NPI_REGISTRY_ERRORS.RATE_LIMITED,
          message: "CMS NPPES rate-limited the request.",
          metadata: {
            npi,
            httpStatus: response.status,
            retryAfter: parseRetryAfterHeader(response.headers.get("retry-after")),
          },
        });
      }

      if (response.status >= 500 && response.status < 600) {
        throw new errors.InternalError({
          code: CMS_NPI_REGISTRY_ERRORS.SERVER_ERROR,
          message: `CMS NPPES returned a ${response.status} server error.`,
          metadata: { npi, httpStatus: response.status },
        });
      }

      if (response.status >= 400 && response.status < 500) {
        throw new errors.InternalError({
          code: CMS_NPI_REGISTRY_ERRORS.BAD_REQUEST,
          message: `CMS NPPES returned a ${response.status} client error.`,
          metadata: { npi, httpStatus: response.status },
        });
      }

      throw new errors.InternalError({
        code: CMS_NPI_REGISTRY_ERRORS.UNEXPECTED_STATUS,
        message: `CMS NPPES returned an unexpected status ${response.status}.`,
        metadata: { npi, httpStatus: response.status },
      });
    } catch (cause) {
      // Translate AbortController timeout / network errors into our
      // typed errors. Anything that's already a PharmaxError just
      // rethrows unchanged.
      if (cause instanceof errors.PharmaxError) {
        throw cause;
      }
      if (isAbortError(cause)) {
        throw new errors.InternalError({
          code: CMS_NPI_REGISTRY_ERRORS.TIMEOUT,
          message: `CMS NPPES request exceeded the ${this.requestTimeoutMs}ms timeout.`,
          metadata: { npi, requestTimeoutMs: this.requestTimeoutMs },
          cause,
        });
      }
      throw new errors.InternalError({
        code: CMS_NPI_REGISTRY_ERRORS.NETWORK_ERROR,
        message: `CMS NPPES request failed before a response was received.`,
        metadata: { npi },
        cause,
      });
    } finally {
      clearTimeoutCompatible(timeoutHandle);
    }
  }

  /**
   * Rate gate. Each call awaits the previous caller's "release"
   * before claiming its own slot; release fires after
   * `minRequestSpacingMs`. Serializes request START times without
   * forcing each request to also serialize its completion.
   *
   * If `minRequestSpacingMs <= 0` the gate degrades to a no-op
   * (useful for tests; the unit tests rely on this).
   */
  private async acquireRateSlot(): Promise<void> {
    if (this.minRequestSpacingMs <= 0) return;

    const previous = this.nextRateSlot;
    let release!: () => void;
    this.nextRateSlot = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    // Schedule the release WITHOUT awaiting it — that way our caller
    // proceeds immediately while the next caller in line waits the
    // required spacing.
    this.sleepFn(this.minRequestSpacingMs).then(() => {
      release();
    });
  }

  /**
   * Backoff with full jitter. attempt is 1-indexed (1 = first
   * retry after a failure). Capped at `retryMaxMs` to handle
   * pathological exponential growth.
   */
  private computeBackoff(attempt: number): number {
    const expDelay = this.retryBaseMs * 2 ** (attempt - 1);
    const cap = Math.min(expDelay, this.retryMaxMs);
    // Full jitter: random in [0, cap]. Avoids retry storms when
    // many workers retry the same outage simultaneously.
    return Math.random() * cap;
  }
}

// ---------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------

/**
 * Parse a CMS NPPES v2.1 response body for a single-NPI query.
 * Exported for tests and for the slice-4 worker that may want to
 * feed fixture bytes through the parser directly.
 *
 * Returns:
 *   - `null` if `result_count: 0` (CMS confirms the NPI does not
 *     exist).
 *   - `CmsNpiSnapshot` if exactly one matching result exists.
 *
 * Throws:
 *   - `MALFORMED_RESPONSE` if the body is not valid JSON.
 *   - `SCHEMA_MISMATCH` if required fields are missing.
 *   - `NPI_MISMATCH` if the result's `number` does not match the
 *     queried NPI.
 */
export function parseSingleNpiResponse(
  queriedNpi: string,
  responseText: string
): CmsNpiSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch (cause) {
    throw new errors.InternalError({
      code: CMS_NPI_REGISTRY_ERRORS.MALFORMED_RESPONSE,
      message: "CMS NPPES response body is not valid JSON.",
      metadata: { queriedNpi },
      cause,
    });
  }

  if (parsed === null || typeof parsed !== "object") {
    throw new errors.InternalError({
      code: CMS_NPI_REGISTRY_ERRORS.SCHEMA_MISMATCH,
      message: "CMS NPPES response body is not a JSON object.",
      metadata: { queriedNpi },
    });
  }

  const raw = parsed as RawNppesResponse;

  if (raw.result_count === 0 || (raw.results?.length ?? 0) === 0) {
    return null;
  }

  // Defensive: if CMS returns multiple results for a single-NPI
  // query, pick the one whose `number` matches. NPI is globally
  // unique so this should never produce >1 match; if zero match,
  // throw NPI_MISMATCH (an API bug).
  const matching = raw.results?.find((r) => r.number === queriedNpi);
  if (matching === undefined) {
    throw new errors.InternalError({
      code: CMS_NPI_REGISTRY_ERRORS.NPI_MISMATCH,
      message: "CMS NPPES response contained results but none matched the queried NPI.",
      metadata: {
        queriedNpi,
        resultNumbers: raw.results?.map((r) => r.number ?? null) ?? [],
      },
    });
  }

  return parseSingleResult(queriedNpi, matching);
}

function parseSingleResult(queriedNpi: string, raw: RawNppesResult): CmsNpiSnapshot {
  const enumerationType = raw.enumeration_type;
  if (enumerationType !== "NPI-1" && enumerationType !== "NPI-2") {
    throw new errors.InternalError({
      code: CMS_NPI_REGISTRY_ERRORS.SCHEMA_MISMATCH,
      message: "CMS NPPES result has unknown enumeration_type.",
      metadata: { queriedNpi, enumerationType: enumerationType ?? null },
    });
  }

  const basic = raw.basic ?? {};
  const rawStatus = basic.status;
  // NPPES treats absent / empty status as active on legacy records.
  // Only an explicit "D" means deactivated; anything else (including
  // empty string and undefined) is treated as "A".
  const status: "A" | "D" = rawStatus === "D" ? "D" : "A";

  const lastUpdated = basic.last_updated;
  if (typeof lastUpdated !== "string" || lastUpdated.length === 0) {
    throw new errors.InternalError({
      code: CMS_NPI_REGISTRY_ERRORS.SCHEMA_MISMATCH,
      message: "CMS NPPES result is missing basic.last_updated.",
      metadata: { queriedNpi },
    });
  }
  const lastUpdatedAtCms = parseNppesDate(lastUpdated, queriedNpi);

  return {
    npi: queriedNpi,
    enumerationType,
    status,
    firstName: emptyToNull(basic.first_name),
    lastName: emptyToNull(basic.last_name),
    credential: emptyToNull(basic.credential),
    practiceAddress: pickPracticeAddress(raw.addresses ?? []),
    lastUpdatedAtCms,
  };
}

/**
 * NPPES sends multiple addresses per provider; we want the
 * LOCATION-purpose row (the practice address), falling back to
 * MAILING if no LOCATION exists, and `null` if neither is present
 * (rare — but slice 1's diff engine handles `practiceAddress: null`
 * by preserving local).
 */
function pickPracticeAddress(addresses: ReadonlyArray<RawNppesAddress>): CmsAddress | null {
  const location = addresses.find((a) => a.address_purpose === "LOCATION");
  const fallback = location ?? addresses.find((a) => a.address_purpose === "MAILING");
  if (fallback === undefined) return null;

  const line1 = emptyToNull(fallback.address_1);
  const city = emptyToNull(fallback.city);
  const state = emptyToNull(fallback.state);
  const postal = emptyToNull(fallback.postal_code);

  // Without line1/city/state/postal the address is unusable for
  // anything. Surface as null (preserve local) rather than emit a
  // partially-populated CmsAddress.
  if (line1 === null || city === null || state === null || postal === null) {
    return null;
  }

  return {
    line1,
    line2: emptyToNull(fallback.address_2),
    city,
    stateCode: state,
    postalCode: formatNppesZip(postal),
    phone: emptyToNull(fallback.telephone_number),
  };
}

/**
 * NPPES sends ZIP+4 as a 9-digit string with no dash ("627010001").
 * Format as `12345-6789` when 9 digits; pass through as-is otherwise
 * (ZIP-5, or anything non-numeric the API might surface — the diff
 * engine just compares strings).
 */
function formatNppesZip(zip: string): string {
  if (/^\d{9}$/.test(zip)) {
    return `${zip.slice(0, 5)}-${zip.slice(5)}`;
  }
  return zip;
}

function parseNppesDate(value: string, queriedNpi: string): Date {
  // NPPES sends "YYYY-MM-DD" (no time). Treat as midnight UTC.
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    // Some responses include a full ISO timestamp; fall back to Date
    // parsing. If THAT fails, schema mismatch.
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new errors.InternalError({
        code: CMS_NPI_REGISTRY_ERRORS.SCHEMA_MISMATCH,
        message: "CMS NPPES last_updated is not a recognizable date.",
        metadata: { queriedNpi, lastUpdated: value },
      });
    }
    return parsed;
  }
  const [, year, month, day] = match;
  // year/month/day are non-null because the regex matched.
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
}

// Accepts `null` defensively — real NPPES JSON occasionally returns
// `null` for optional string fields (e.g. `credential: null`) even
// though the schema documents them as `string?`. Crashing on that
// would make the whole sync brittle, so we coalesce null → null
// alongside the empty-string normalization.
function emptyToNull(s: string | null | undefined): string | null {
  if (s === undefined || s === null) return null;
  const trimmed = s.trim();
  return trimmed.length === 0 ? null : trimmed;
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function isRetryable(err: errors.PharmaxError): boolean {
  return (
    err.code === CMS_NPI_REGISTRY_ERRORS.RATE_LIMITED ||
    err.code === CMS_NPI_REGISTRY_ERRORS.SERVER_ERROR ||
    err.code === CMS_NPI_REGISTRY_ERRORS.NETWORK_ERROR ||
    err.code === CMS_NPI_REGISTRY_ERRORS.TIMEOUT
  );
}

function retryAfterFromError(err: errors.PharmaxError): number | null {
  if (err.code !== CMS_NPI_REGISTRY_ERRORS.RATE_LIMITED) return null;
  const value = (err.metadata as { retryAfter?: number | null }).retryAfter;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  return null;
}

/**
 * Parse the `Retry-After` HTTP header. Per RFC 7231 the value is
 * either delta-seconds (an integer) or an HTTP-date. We support
 * delta-seconds (the common form for 429s); HTTP-dates would need
 * `Date.parse` and a `now()` source.
 */
function parseRetryAfterHeader(headerValue: string | null): number | null {
  if (headerValue === null) return null;
  const seconds = Number.parseInt(headerValue, 10);
  if (Number.isNaN(seconds) || seconds <= 0) return null;
  return seconds * 1000;
}

function isAbortError(e: unknown): boolean {
  return (
    e !== null &&
    typeof e === "object" &&
    "name" in e &&
    (e as { name: unknown }).name === "AbortError"
  );
}

function toPharmaxError(cause: unknown): errors.PharmaxError {
  if (cause instanceof errors.PharmaxError) return cause;
  if (isAbortError(cause)) {
    return new errors.InternalError({
      code: CMS_NPI_REGISTRY_ERRORS.TIMEOUT,
      message: "CMS NPPES request timed out.",
      cause,
    });
  }
  return new errors.InternalError({
    code: CMS_NPI_REGISTRY_ERRORS.NETWORK_ERROR,
    message: cause instanceof Error ? cause.message : "Unknown network error.",
    cause,
  });
}

// ---------------------------------------------------------------------
// Default implementations
// ---------------------------------------------------------------------

const defaultFetch: FetchFunction = async (input, init) => {
  // Node 18+ has a global fetch; Node 22 (our runtime) definitely does.
  // `FetchFunction` accepts `string | URL`, which the global `fetch`
  // also accepts — no cast needed. We DO cast `init` because our
  // type only models the subset we care about (`headers` + `signal`),
  // not the full `RequestInit`.
  const response = await fetch(input, init as RequestInit);
  return {
    status: response.status,
    headers: { get: (name) => response.headers.get(name) },
    text: () => response.text(),
  };
};

const defaultSleep: Sleeper = (ms) =>
  new Promise<void>((resolve) => setTimeoutCompatible(resolve, ms));

// `setTimeout` returns a `number` in browsers and a `Timeout` object
// in Node. Wrap with `any` only for the return type — the function
// itself is fully typed.
function setTimeoutCompatible(fn: () => void, ms: number): unknown {
  return setTimeout(fn, ms);
}
function clearTimeoutCompatible(handle: unknown): void {
  clearTimeout(handle as Parameters<typeof clearTimeout>[0]);
}
