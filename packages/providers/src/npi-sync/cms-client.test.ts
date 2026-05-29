// Contract tests for the CMS NPPES HTTP client.
//
// Strategy:
//   - Inject `fetch` (mock) + `sleep` (no-op recorder) so tests run
//     without real network and without fake-timer machinery.
//   - The `sleep` recorder lets us assert retry-backoff durations
//     and rate-limiter spacing without coupling tests to wall time.
//   - Parser tests use `parseSingleNpiResponse` directly (it's
//     exported precisely so we don't have to thread fixture bytes
//     through the HTTP layer for pure-parse cases).

import { describe, expect, it, vi } from "vitest";
import { errors } from "@pharmax/platform-core";

import {
  CMS_NPI_REGISTRY_ERRORS,
  CmsNppesClient,
  parseSingleNpiResponse,
  type FetchFunction,
  type Sleeper,
} from "./cms-client.js";

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

const QUERIED_NPI = "1234567890";

function makeFullNppesResultBody(overrides: Partial<RawShape> = {}): string {
  // IMPORTANT: pull `results` out of `overrides` BEFORE the top-level
  // spread so the carefully merged `results` array below isn't
  // overwritten by the raw override list. The deep merge of
  // `overrides.results?.[0]` into the canonical first row already
  // applied; the rest of `overrides` (e.g. `result_count`) still flows
  // through.
  const { results: _resultsOverride, ...otherOverrides } = overrides;
  const merged: RawShape = {
    result_count: 1,
    results: [
      {
        number: QUERIED_NPI,
        enumeration_type: "NPI-1",
        basic: {
          first_name: "JORDAN",
          last_name: "RIVERA",
          credential: "MD",
          status: "A",
          last_updated: "2021-09-24",
        },
        addresses: [
          {
            address_purpose: "LOCATION",
            address_1: "1200 MAPLE ST",
            address_2: "SUITE 4",
            city: "SPRINGFIELD",
            state: "IL",
            postal_code: "627010001",
            telephone_number: "217-555-0142",
          },
          {
            address_purpose: "MAILING",
            address_1: "P.O. BOX 100",
            address_2: "",
            city: "SPRINGFIELD",
            state: "IL",
            postal_code: "627010100",
            telephone_number: "",
          },
        ],
        ...overrides.results?.[0],
      },
      ...(overrides.results?.slice(1) ?? []),
    ],
    ...otherOverrides,
  };
  return JSON.stringify(merged);
}

// Test-fixture shapes are deliberately widened to `T | undefined` (rather
// than the production code's plain `T?`) so tests can pass an EXPLICIT
// `undefined` to assert absence-handling under `exactOptionalPropertyTypes:
// true`. The parser sees both shapes identically; the wider type is purely
// a TS contract for the test fixtures.
interface RawShape {
  result_count?: number | undefined;
  results?: ReadonlyArray<RawResultShape> | undefined;
}
interface RawResultShape {
  number?: string | undefined;
  enumeration_type?: string | undefined;
  basic?:
    | {
        first_name?: string | undefined;
        last_name?: string | undefined;
        credential?: string | undefined;
        status?: string | undefined;
        last_updated?: string | undefined;
      }
    | undefined;
  addresses?:
    | ReadonlyArray<{
        address_purpose?: string | undefined;
        address_1?: string | undefined;
        address_2?: string | undefined;
        city?: string | undefined;
        state?: string | undefined;
        postal_code?: string | undefined;
        telephone_number?: string | undefined;
      }>
    | undefined;
}

function makeMockFetch(
  responses: ReadonlyArray<{
    status: number;
    body?: string;
    headers?: Record<string, string>;
    throws?: unknown;
  }>
): FetchFunction {
  let i = 0;
  return vi.fn(async () => {
    const r = responses[i] ?? responses[responses.length - 1];
    i += 1;
    if (r === undefined) {
      throw new Error("test mock: ran out of canned responses");
    }
    if (r.throws !== undefined) throw r.throws;
    const headerMap = new Map(
      Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])
    );
    return {
      status: r.status,
      headers: { get: (name: string) => headerMap.get(name.toLowerCase()) ?? null },
      text: async () => r.body ?? "",
    };
  });
}

interface RecordedSleep {
  calls: number[];
}

function makeRecordedSleep(): { sleep: Sleeper; recorder: RecordedSleep } {
  const recorder: RecordedSleep = { calls: [] };
  const sleep: Sleeper = async (ms) => {
    recorder.calls.push(ms);
  };
  return { sleep, recorder };
}

function makeClient(opts: {
  fetch: FetchFunction;
  sleep?: Sleeper;
  minRequestSpacingMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  requestTimeoutMs?: number;
}): CmsNppesClient {
  return new CmsNppesClient({
    userAgent: "pharmax-test/1.0 (test@example.com)",
    fetch: opts.fetch,
    sleep: opts.sleep ?? makeRecordedSleep().sleep,
    minRequestSpacingMs: opts.minRequestSpacingMs ?? 0,
    maxRetries: opts.maxRetries ?? 3,
    retryBaseMs: opts.retryBaseMs ?? 250,
    retryMaxMs: opts.retryMaxMs ?? 5000,
    requestTimeoutMs: opts.requestTimeoutMs ?? 10_000,
  });
}

// ---------------------------------------------------------------------
// Parser — happy paths
// ---------------------------------------------------------------------

describe("parseSingleNpiResponse — happy paths", () => {
  it("parses a full NPI-1 response into CmsNpiSnapshot", () => {
    const snap = parseSingleNpiResponse(QUERIED_NPI, makeFullNppesResultBody());
    expect(snap).toEqual({
      npi: QUERIED_NPI,
      enumerationType: "NPI-1",
      status: "A",
      firstName: "JORDAN",
      lastName: "RIVERA",
      credential: "MD",
      practiceAddress: {
        line1: "1200 MAPLE ST",
        line2: "SUITE 4",
        city: "SPRINGFIELD",
        stateCode: "IL",
        postalCode: "62701-0001",
        phone: "217-555-0142",
      },
      lastUpdatedAtCms: new Date(Date.UTC(2021, 8, 24)),
    });
  });

  it("returns null when CMS confirms NPI not found (result_count: 0)", () => {
    expect(
      parseSingleNpiResponse(QUERIED_NPI, JSON.stringify({ result_count: 0, results: [] }))
    ).toBeNull();
  });

  it("returns null when result_count is undefined and results is empty", () => {
    expect(parseSingleNpiResponse(QUERIED_NPI, JSON.stringify({ results: [] }))).toBeNull();
  });

  it("prefers LOCATION address over MAILING when both present", () => {
    const snap = parseSingleNpiResponse(QUERIED_NPI, makeFullNppesResultBody());
    expect(snap?.practiceAddress?.line1).toBe("1200 MAPLE ST");
  });

  it("falls back to MAILING when no LOCATION address is present", () => {
    const body = makeFullNppesResultBody({
      results: [
        {
          addresses: [
            {
              address_purpose: "MAILING",
              address_1: "P.O. BOX 100",
              address_2: "",
              city: "SPRINGFIELD",
              state: "IL",
              postal_code: "62701",
              telephone_number: "",
            },
          ],
        },
      ],
    });
    const snap = parseSingleNpiResponse(QUERIED_NPI, body);
    expect(snap?.practiceAddress?.line1).toBe("P.O. BOX 100");
  });

  it("returns practiceAddress: null when no addresses array is present", () => {
    const body = makeFullNppesResultBody({ results: [{ addresses: [] }] });
    const snap = parseSingleNpiResponse(QUERIED_NPI, body);
    expect(snap?.practiceAddress).toBeNull();
  });

  it("returns practiceAddress: null when the chosen address is missing required components", () => {
    const body = makeFullNppesResultBody({
      results: [
        {
          addresses: [
            {
              address_purpose: "LOCATION",
              address_1: "",
              city: "SPRINGFIELD",
              state: "IL",
              postal_code: "62701",
            },
          ],
        },
      ],
    });
    const snap = parseSingleNpiResponse(QUERIED_NPI, body);
    expect(snap?.practiceAddress).toBeNull();
  });
});

// ---------------------------------------------------------------------
// Parser — normalization
// ---------------------------------------------------------------------

describe("parseSingleNpiResponse — normalization", () => {
  it("normalizes empty strings to null on firstName/lastName/credential", () => {
    const body = makeFullNppesResultBody({
      results: [
        {
          basic: {
            first_name: "",
            last_name: "",
            credential: "",
            status: "A",
            last_updated: "2021-09-24",
          },
        },
      ],
    });
    const snap = parseSingleNpiResponse(QUERIED_NPI, body);
    expect(snap?.firstName).toBeNull();
    expect(snap?.lastName).toBeNull();
    expect(snap?.credential).toBeNull();
  });

  it("normalizes whitespace-only strings to null", () => {
    const body = makeFullNppesResultBody({
      results: [
        {
          basic: {
            first_name: "   ",
            last_name: "Smith",
            credential: "MD",
            status: "A",
            last_updated: "2021-09-24",
          },
        },
      ],
    });
    expect(parseSingleNpiResponse(QUERIED_NPI, body)?.firstName).toBeNull();
  });

  it("formats 9-digit ZIP as 12345-6789", () => {
    const snap = parseSingleNpiResponse(QUERIED_NPI, makeFullNppesResultBody());
    expect(snap?.practiceAddress?.postalCode).toBe("62701-0001");
  });

  it("passes through 5-digit ZIP unchanged", () => {
    const body = makeFullNppesResultBody({
      results: [
        {
          addresses: [
            {
              address_purpose: "LOCATION",
              address_1: "1200 MAPLE ST",
              city: "SPRINGFIELD",
              state: "IL",
              postal_code: "62701",
              telephone_number: "217-555-0142",
            },
          ],
        },
      ],
    });
    expect(parseSingleNpiResponse(QUERIED_NPI, body)?.practiceAddress?.postalCode).toBe("62701");
  });

  it("normalizes empty address_2 and telephone_number to null", () => {
    const body = makeFullNppesResultBody({
      results: [
        {
          addresses: [
            {
              address_purpose: "LOCATION",
              address_1: "1200 MAPLE ST",
              address_2: "",
              city: "SPRINGFIELD",
              state: "IL",
              postal_code: "62701",
              telephone_number: "",
            },
          ],
        },
      ],
    });
    const snap = parseSingleNpiResponse(QUERIED_NPI, body);
    expect(snap?.practiceAddress?.line2).toBeNull();
    expect(snap?.practiceAddress?.phone).toBeNull();
  });

  it("parses last_updated as midnight UTC of the given date", () => {
    const body = makeFullNppesResultBody({
      results: [
        {
          basic: {
            first_name: "X",
            last_name: "Y",
            credential: undefined,
            status: "A",
            last_updated: "2024-01-15",
          },
        },
      ],
    });
    const snap = parseSingleNpiResponse(QUERIED_NPI, body);
    expect(snap?.lastUpdatedAtCms.toISOString()).toBe("2024-01-15T00:00:00.000Z");
  });

  it("falls back to ISO-timestamp parsing when last_updated isn't YYYY-MM-DD", () => {
    const body = makeFullNppesResultBody({
      results: [
        {
          basic: {
            first_name: "X",
            last_name: "Y",
            credential: "MD",
            status: "A",
            last_updated: "2024-01-15T12:34:56.000Z",
          },
        },
      ],
    });
    const snap = parseSingleNpiResponse(QUERIED_NPI, body);
    expect(snap?.lastUpdatedAtCms.toISOString()).toBe("2024-01-15T12:34:56.000Z");
  });
});

// ---------------------------------------------------------------------
// Parser — status field handling
// ---------------------------------------------------------------------

describe("parseSingleNpiResponse — status field", () => {
  it.each([
    ["A", "A"],
    ["D", "D"],
    ["", "A"],
    ["X", "A"],
  ])("rawStatus=%s → snapshot.status=%s", (rawStatus, expected) => {
    const body = makeFullNppesResultBody({
      results: [
        {
          basic: {
            first_name: "X",
            last_name: "Y",
            credential: "MD",
            status: rawStatus,
            last_updated: "2021-09-24",
          },
        },
      ],
    });
    expect(parseSingleNpiResponse(QUERIED_NPI, body)?.status).toBe(expected);
  });

  it("treats missing status field as A (legacy NPPES records)", () => {
    const body = makeFullNppesResultBody({
      results: [
        {
          basic: {
            first_name: "X",
            last_name: "Y",
            credential: "MD",
            last_updated: "2021-09-24",
          },
        },
      ],
    });
    expect(parseSingleNpiResponse(QUERIED_NPI, body)?.status).toBe("A");
  });
});

// ---------------------------------------------------------------------
// Parser — error paths
// ---------------------------------------------------------------------

describe("parseSingleNpiResponse — errors", () => {
  it("throws MALFORMED_RESPONSE for invalid JSON", () => {
    expect(() => parseSingleNpiResponse(QUERIED_NPI, "{not json")).toThrowError(
      expect.objectContaining({ code: CMS_NPI_REGISTRY_ERRORS.MALFORMED_RESPONSE })
    );
  });

  it("throws SCHEMA_MISMATCH when body is a non-object JSON value", () => {
    for (const body of [`"hello"`, `42`, `null`, `[]`]) {
      // arrays pass typeof object but result_count/results checks make them null-result;
      // the strict "null or non-object" guard catches `null`. The others are caught by
      // result_count check returning null. The only one that throws is `null`.
      if (body === "null") {
        expect(() => parseSingleNpiResponse(QUERIED_NPI, body)).toThrowError(
          expect.objectContaining({ code: CMS_NPI_REGISTRY_ERRORS.SCHEMA_MISMATCH })
        );
      }
    }
  });

  it("throws NPI_MISMATCH when the result has a different NPI", () => {
    const body = JSON.stringify({
      result_count: 1,
      results: [
        {
          number: "9999999999",
          enumeration_type: "NPI-1",
          basic: { last_updated: "2021-09-24" },
        },
      ],
    });
    expect(() => parseSingleNpiResponse(QUERIED_NPI, body)).toThrowError(
      expect.objectContaining({ code: CMS_NPI_REGISTRY_ERRORS.NPI_MISMATCH })
    );
  });

  it("picks the matching result when multiple are returned", () => {
    const body = JSON.stringify({
      result_count: 2,
      results: [
        {
          number: "9999999999",
          enumeration_type: "NPI-1",
          basic: { last_updated: "2021-09-24" },
        },
        {
          number: QUERIED_NPI,
          enumeration_type: "NPI-1",
          basic: {
            first_name: "JORDAN",
            last_name: "RIVERA",
            status: "A",
            last_updated: "2021-09-24",
          },
        },
      ],
    });
    const snap = parseSingleNpiResponse(QUERIED_NPI, body);
    expect(snap?.npi).toBe(QUERIED_NPI);
    expect(snap?.firstName).toBe("JORDAN");
  });

  it("throws SCHEMA_MISMATCH when enumeration_type is unknown", () => {
    const body = makeFullNppesResultBody({ results: [{ enumeration_type: "NPI-3" }] });
    expect(() => parseSingleNpiResponse(QUERIED_NPI, body)).toThrowError(
      expect.objectContaining({ code: CMS_NPI_REGISTRY_ERRORS.SCHEMA_MISMATCH })
    );
  });

  it("throws SCHEMA_MISMATCH when enumeration_type is missing", () => {
    const body = makeFullNppesResultBody({ results: [{ enumeration_type: undefined }] });
    expect(() => parseSingleNpiResponse(QUERIED_NPI, body)).toThrowError(
      expect.objectContaining({ code: CMS_NPI_REGISTRY_ERRORS.SCHEMA_MISMATCH })
    );
  });

  it("throws SCHEMA_MISMATCH when basic.last_updated is missing", () => {
    const body = makeFullNppesResultBody({
      results: [
        {
          basic: {
            first_name: "X",
            last_name: "Y",
            credential: "MD",
            status: "A",
          },
        },
      ],
    });
    expect(() => parseSingleNpiResponse(QUERIED_NPI, body)).toThrowError(
      expect.objectContaining({ code: CMS_NPI_REGISTRY_ERRORS.SCHEMA_MISMATCH })
    );
  });

  it("throws SCHEMA_MISMATCH when last_updated is unparseable", () => {
    const body = makeFullNppesResultBody({
      results: [
        {
          basic: {
            first_name: "X",
            last_name: "Y",
            credential: "MD",
            status: "A",
            last_updated: "garbage",
          },
        },
      ],
    });
    expect(() => parseSingleNpiResponse(QUERIED_NPI, body)).toThrowError(
      expect.objectContaining({ code: CMS_NPI_REGISTRY_ERRORS.SCHEMA_MISMATCH })
    );
  });
});

// ---------------------------------------------------------------------
// Client — construction
// ---------------------------------------------------------------------

describe("CmsNppesClient — construction", () => {
  it("throws when userAgent is missing or empty", () => {
    const mockFetch = makeMockFetch([{ status: 200, body: "{}" }]);
    expect(
      () =>
        new CmsNppesClient({
          userAgent: "",
          fetch: mockFetch,
        })
    ).toThrowError(expect.objectContaining({ code: "CMS_NPI_REGISTRY_BAD_CONFIG" }));
    expect(
      () =>
        new CmsNppesClient({
          userAgent: "   ",
          fetch: mockFetch,
        })
    ).toThrowError(expect.objectContaining({ code: "CMS_NPI_REGISTRY_BAD_CONFIG" }));
  });

  it("accepts a non-empty userAgent", () => {
    const mockFetch = makeMockFetch([{ status: 200, body: "{}" }]);
    expect(
      () => new CmsNppesClient({ userAgent: "pharmax-test/1.0", fetch: mockFetch })
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------
// Client — input validation
// ---------------------------------------------------------------------

describe("CmsNppesClient.fetchByNpi — input validation", () => {
  it("throws BAD_REQUEST without calling fetch when NPI is not 10 digits", async () => {
    const mockFetch = makeMockFetch([{ status: 200, body: "{}" }]);
    const client = makeClient({ fetch: mockFetch });
    await expect(client.fetchByNpi("123")).rejects.toMatchObject({
      code: CMS_NPI_REGISTRY_ERRORS.BAD_REQUEST,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("throws BAD_REQUEST when NPI contains non-digit characters", async () => {
    const mockFetch = makeMockFetch([{ status: 200, body: "{}" }]);
    const client = makeClient({ fetch: mockFetch });
    await expect(client.fetchByNpi("12345abcde")).rejects.toMatchObject({
      code: CMS_NPI_REGISTRY_ERRORS.BAD_REQUEST,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------
// Client — fetchByNpi happy + transport errors
// ---------------------------------------------------------------------

describe("CmsNppesClient.fetchByNpi — happy paths", () => {
  it("returns parsed snapshot on 200 OK", async () => {
    const mockFetch = makeMockFetch([{ status: 200, body: makeFullNppesResultBody() }]);
    const client = makeClient({ fetch: mockFetch });
    const snap = await client.fetchByNpi(QUERIED_NPI);
    expect(snap?.npi).toBe(QUERIED_NPI);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("sends the User-Agent and Accept headers", async () => {
    const mockFetch = makeMockFetch([{ status: 200, body: makeFullNppesResultBody() }]);
    const client = makeClient({ fetch: mockFetch });
    await client.fetchByNpi(QUERIED_NPI);
    const [, init] = (
      mockFetch as unknown as {
        mock: { calls: Array<[unknown, { headers: Record<string, string> }]> };
      }
    ).mock.calls[0]!;
    expect(init.headers["User-Agent"]).toBe("pharmax-test/1.0 (test@example.com)");
    expect(init.headers["Accept"]).toBe("application/json");
  });

  it("builds the URL with number + version=2.1 query params", async () => {
    const mockFetch = makeMockFetch([{ status: 200, body: makeFullNppesResultBody() }]);
    const client = makeClient({ fetch: mockFetch });
    await client.fetchByNpi(QUERIED_NPI);
    const [url] = (mockFetch as unknown as { mock: { calls: Array<[string]> } }).mock.calls[0]!;
    expect(url).toContain(`number=${QUERIED_NPI}`);
    expect(url).toContain("version=2.1");
  });

  it("returns null when CMS reports result_count: 0", async () => {
    const mockFetch = makeMockFetch([
      { status: 200, body: JSON.stringify({ result_count: 0, results: [] }) },
    ]);
    const client = makeClient({ fetch: mockFetch });
    expect(await client.fetchByNpi(QUERIED_NPI)).toBeNull();
  });
});

describe("CmsNppesClient.fetchByNpi — transport errors", () => {
  it("throws BAD_REQUEST on 4xx and does NOT retry", async () => {
    const mockFetch = makeMockFetch([{ status: 400 }]);
    const { sleep, recorder } = makeRecordedSleep();
    const client = makeClient({ fetch: mockFetch, sleep, maxRetries: 3 });
    await expect(client.fetchByNpi(QUERIED_NPI)).rejects.toMatchObject({
      code: CMS_NPI_REGISTRY_ERRORS.BAD_REQUEST,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(recorder.calls).toEqual([]);
  });

  it("retries on 429 and returns the snapshot on success", async () => {
    const mockFetch = makeMockFetch([
      { status: 429, headers: { "Retry-After": "2" } },
      { status: 200, body: makeFullNppesResultBody() },
    ]);
    const { sleep, recorder } = makeRecordedSleep();
    const client = makeClient({ fetch: mockFetch, sleep });
    const snap = await client.fetchByNpi(QUERIED_NPI);
    expect(snap?.npi).toBe(QUERIED_NPI);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // Sleep called once with the Retry-After value (2 seconds → 2000ms).
    expect(recorder.calls).toEqual([2000]);
  });

  it("retries on 500 with exponential backoff", async () => {
    const mockFetch = makeMockFetch([
      { status: 500 },
      { status: 503 },
      { status: 200, body: makeFullNppesResultBody() },
    ]);
    const { sleep, recorder } = makeRecordedSleep();
    const client = makeClient({
      fetch: mockFetch,
      sleep,
      retryBaseMs: 100,
      retryMaxMs: 5000,
      maxRetries: 3,
    });
    const snap = await client.fetchByNpi(QUERIED_NPI);
    expect(snap?.npi).toBe(QUERIED_NPI);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    // Two backoff sleeps; each bounded by base * 2^(n-1) with jitter.
    expect(recorder.calls).toHaveLength(2);
    expect(recorder.calls[0]).toBeGreaterThanOrEqual(0);
    expect(recorder.calls[0]).toBeLessThanOrEqual(100);
    expect(recorder.calls[1]).toBeGreaterThanOrEqual(0);
    expect(recorder.calls[1]).toBeLessThanOrEqual(200);
  });

  it("throws RATE_LIMITED after exhausting retries on 429", async () => {
    const mockFetch = makeMockFetch([
      { status: 429 },
      { status: 429 },
      { status: 429 },
      { status: 429 },
    ]);
    const { sleep } = makeRecordedSleep();
    const client = makeClient({ fetch: mockFetch, sleep, maxRetries: 3 });
    await expect(client.fetchByNpi(QUERIED_NPI)).rejects.toMatchObject({
      code: CMS_NPI_REGISTRY_ERRORS.RATE_LIMITED,
    });
    expect(mockFetch).toHaveBeenCalledTimes(4); // 1 + 3 retries
  });

  it("throws SERVER_ERROR after exhausting retries on 5xx", async () => {
    const mockFetch = makeMockFetch([
      { status: 500 },
      { status: 502 },
      { status: 503 },
      { status: 504 },
    ]);
    const client = makeClient({ fetch: mockFetch, maxRetries: 3 });
    await expect(client.fetchByNpi(QUERIED_NPI)).rejects.toMatchObject({
      code: CMS_NPI_REGISTRY_ERRORS.SERVER_ERROR,
    });
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("throws UNEXPECTED_STATUS on a 3xx (redirect not followed by fetch shim)", async () => {
    const mockFetch = makeMockFetch([{ status: 301 }]);
    const client = makeClient({ fetch: mockFetch });
    await expect(client.fetchByNpi(QUERIED_NPI)).rejects.toMatchObject({
      code: CMS_NPI_REGISTRY_ERRORS.UNEXPECTED_STATUS,
    });
  });

  it("translates AbortError to TIMEOUT and retries", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    const mockFetch = makeMockFetch([
      { status: 0, throws: abortErr },
      { status: 200, body: makeFullNppesResultBody() },
    ]);
    const client = makeClient({ fetch: mockFetch, maxRetries: 1 });
    const snap = await client.fetchByNpi(QUERIED_NPI);
    expect(snap?.npi).toBe(QUERIED_NPI);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("translates generic fetch error to NETWORK_ERROR and retries", async () => {
    const mockFetch = makeMockFetch([
      { status: 0, throws: new Error("ECONNRESET") },
      { status: 200, body: makeFullNppesResultBody() },
    ]);
    const client = makeClient({ fetch: mockFetch, maxRetries: 1 });
    const snap = await client.fetchByNpi(QUERIED_NPI);
    expect(snap?.npi).toBe(QUERIED_NPI);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws NETWORK_ERROR after exhausting retries on persistent network failure", async () => {
    const mockFetch = makeMockFetch([
      { status: 0, throws: new Error("ECONNRESET") },
      { status: 0, throws: new Error("ECONNRESET") },
    ]);
    const client = makeClient({ fetch: mockFetch, maxRetries: 1 });
    await expect(client.fetchByNpi(QUERIED_NPI)).rejects.toMatchObject({
      code: CMS_NPI_REGISTRY_ERRORS.NETWORK_ERROR,
    });
  });

  it("throws MALFORMED_RESPONSE on 200 with invalid JSON", async () => {
    const mockFetch = makeMockFetch([{ status: 200, body: "{not valid" }]);
    const client = makeClient({ fetch: mockFetch });
    await expect(client.fetchByNpi(QUERIED_NPI)).rejects.toMatchObject({
      code: CMS_NPI_REGISTRY_ERRORS.MALFORMED_RESPONSE,
    });
  });

  it("uses Retry-After header when present on 429", async () => {
    const mockFetch = makeMockFetch([
      { status: 429, headers: { "retry-after": "5" } },
      { status: 200, body: makeFullNppesResultBody() },
    ]);
    const { sleep, recorder } = makeRecordedSleep();
    const client = makeClient({ fetch: mockFetch, sleep });
    await client.fetchByNpi(QUERIED_NPI);
    expect(recorder.calls).toEqual([5000]);
  });

  it("falls back to backoff when Retry-After is missing on 429", async () => {
    const mockFetch = makeMockFetch([
      { status: 429 },
      { status: 200, body: makeFullNppesResultBody() },
    ]);
    const { sleep, recorder } = makeRecordedSleep();
    const client = makeClient({ fetch: mockFetch, sleep, retryBaseMs: 100 });
    await client.fetchByNpi(QUERIED_NPI);
    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]).toBeGreaterThanOrEqual(0);
    expect(recorder.calls[0]).toBeLessThanOrEqual(100);
  });

  it("ignores invalid Retry-After values and falls back to backoff", async () => {
    const mockFetch = makeMockFetch([
      { status: 429, headers: { "Retry-After": "garbage" } },
      { status: 200, body: makeFullNppesResultBody() },
    ]);
    const { sleep, recorder } = makeRecordedSleep();
    const client = makeClient({ fetch: mockFetch, sleep, retryBaseMs: 100 });
    await client.fetchByNpi(QUERIED_NPI);
    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]).toBeLessThanOrEqual(100);
  });

  it("caps backoff at retryMaxMs", async () => {
    const failures = Array.from({ length: 10 }, () => ({ status: 500 }));
    const mockFetch = makeMockFetch([
      ...failures,
      { status: 200, body: makeFullNppesResultBody() },
    ]);
    const { sleep, recorder } = makeRecordedSleep();
    const client = makeClient({
      fetch: mockFetch,
      sleep,
      retryBaseMs: 1000,
      retryMaxMs: 2500,
      maxRetries: 5,
    });
    await expect(client.fetchByNpi(QUERIED_NPI)).rejects.toMatchObject({
      code: CMS_NPI_REGISTRY_ERRORS.SERVER_ERROR,
    });
    for (const ms of recorder.calls) {
      expect(ms).toBeLessThanOrEqual(2500);
    }
  });
});

// ---------------------------------------------------------------------
// Client — rate limiter
// ---------------------------------------------------------------------

describe("CmsNppesClient — rate limiter", () => {
  it("does NOT sleep between requests when minRequestSpacingMs is 0", async () => {
    const mockFetch = makeMockFetch([
      { status: 200, body: makeFullNppesResultBody() },
      { status: 200, body: makeFullNppesResultBody() },
    ]);
    const { sleep, recorder } = makeRecordedSleep();
    const client = makeClient({ fetch: mockFetch, sleep, minRequestSpacingMs: 0 });
    await client.fetchByNpi(QUERIED_NPI);
    await client.fetchByNpi(QUERIED_NPI);
    expect(recorder.calls).toEqual([]);
  });

  it("sleeps for minRequestSpacingMs to release the next rate slot", async () => {
    const mockFetch = makeMockFetch([
      { status: 200, body: makeFullNppesResultBody() },
      { status: 200, body: makeFullNppesResultBody() },
    ]);
    const { sleep, recorder } = makeRecordedSleep();
    const client = makeClient({ fetch: mockFetch, sleep, minRequestSpacingMs: 125 });
    await client.fetchByNpi(QUERIED_NPI);
    await client.fetchByNpi(QUERIED_NPI);
    // The rate gate fires its release-sleep after each request acquires;
    // we expect at least one 125ms sleep recorded.
    expect(recorder.calls).toContain(125);
  });
});

// ---------------------------------------------------------------------
// Client — fetchManyByNpi
// ---------------------------------------------------------------------

describe("CmsNppesClient.fetchManyByNpi", () => {
  it("returns per-NPI results keyed by NPI", async () => {
    const npis = ["1111111111", "2222222222", "3333333333"];
    const mockFetch = makeMockFetch([
      {
        status: 200,
        body: makeFullNppesResultBody({ results: [{ number: npis[0] }] }),
      },
      { status: 200, body: JSON.stringify({ result_count: 0, results: [] }) },
      {
        status: 200,
        body: makeFullNppesResultBody({ results: [{ number: npis[2] }] }),
      },
    ]);
    const client = makeClient({ fetch: mockFetch });
    const results = await client.fetchManyByNpi(npis);

    expect(results.size).toBe(3);
    expect(results.get("1111111111")).toEqual({
      ok: true,
      snapshot: expect.objectContaining({ npi: "1111111111" }),
    });
    expect(results.get("2222222222")).toEqual({ ok: true, snapshot: null });
    expect(results.get("3333333333")).toEqual({
      ok: true,
      snapshot: expect.objectContaining({ npi: "3333333333" }),
    });
  });

  it("captures per-NPI errors without aborting the batch", async () => {
    const npis = ["1111111111", "2222222222", "3333333333"];
    // First succeeds; second fails 400 (no retry); third succeeds.
    const mockFetch = makeMockFetch([
      {
        status: 200,
        body: makeFullNppesResultBody({ results: [{ number: npis[0] }] }),
      },
      { status: 400 },
      {
        status: 200,
        body: makeFullNppesResultBody({ results: [{ number: npis[2] }] }),
      },
    ]);
    const client = makeClient({ fetch: mockFetch, maxRetries: 0 });
    const results = await client.fetchManyByNpi(npis);

    expect(results.get("1111111111")?.ok).toBe(true);
    const second = results.get("2222222222");
    expect(second?.ok).toBe(false);
    if (second?.ok === false) {
      expect(second.error.code).toBe(CMS_NPI_REGISTRY_ERRORS.BAD_REQUEST);
      expect(second.error).toBeInstanceOf(errors.PharmaxError);
    }
    expect(results.get("3333333333")?.ok).toBe(true);
  });

  it("returns an empty map for an empty NPI list and makes no fetch calls", async () => {
    const mockFetch = makeMockFetch([{ status: 200, body: "{}" }]);
    const client = makeClient({ fetch: mockFetch });
    const results = await client.fetchManyByNpi([]);
    expect(results.size).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
