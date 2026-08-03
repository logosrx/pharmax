// Contract tests for POST /api/v1/prescriptions.
//
// Pins the auth/scope gates, the Idempotency-Key requirement, the
// caller-namespaced idempotency key, and the 201-vs-replay-200
// contract — the same commitments the /api/v1/orders intake surface
// carries.
//
// The load-bearing one here is PASS-THROUGH: the route hands the
// parsed body to `CreatePrescription` unchanged, so the command's
// strict schema is what rejects an unknown or misspelled field. A
// route that projected named fields would silently drop them.
//
// The other is the error-status contract. `RX_NUMBER_COLLISION` is a
// transient conflict the operator console tells people to retry, and
// `RX_NUMBER_ALLOCATION_FAILED` is a database failure of ours; a
// blanket 422 called the first one un-retryable and the second one
// the partner's fault. Both statuses are pinned below.
//
// PHI: every fixture is synthetic. `sig` must reach the command (it is
// the prescription) and must appear in NOTHING else — not the
// response, not the logger.

import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveApiKeyMock = vi.hoisted(() => vi.fn());
const rateLimitHitMock = vi.hoisted(() => vi.fn());
const loggerMock = vi.hoisted(() => {
  const noop = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
  noop.child.mockReturnValue(noop);
  return noop;
});

vi.mock("@pharmax/partner-api", () => ({
  resolveApiKey: resolveApiKeyMock,
  getApiKeyQuota: () => ({
    tier: "STANDARD",
    burst: { limit: 120, windowMs: 60_000 },
    daily: { limit: 50_000, windowMs: 86_400_000 },
  }),
}));

vi.mock("@pharmax/composition", () => ({
  createRateLimiterFromEnv: () => ({ rateLimiter: { hit: rateLimitHitMock } }),
}));

vi.mock("@pharmax/database", () => ({ prisma: {} }));

vi.mock("@pharmax/rbac", () => ({
  PERMISSIONS: { PRESCRIPTIONS_CREATE: "prescriptions.create" },
}));

vi.mock("@pharmax/tenancy", () => ({
  buildTenancyContext: (input: unknown) => input,
  withTenancyContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

// Mocking the bus + the command keeps @pharmax/orders' transitive
// graph (crypto, controlled-substances, Rx-number allocator, …) out of
// this route-layer suite, same as the other v1 route tests.
const executeCommandDetailedMock = vi.hoisted(() => vi.fn());
vi.mock("@pharmax/command-bus", () => ({
  executeCommandDetailed: executeCommandDetailedMock,
}));
vi.mock("@pharmax/orders", () => ({
  CreatePrescription: { name: "CreatePrescription" },
}));

vi.mock("@/server/env", () => ({ env: { REDIS_URL: undefined } }));
vi.mock("@/server/logger", () => ({ logger: loggerMock }));

import { errors } from "@pharmax/platform-core";

import { POST } from "./route.js";

const RESOLVED_KEY = {
  apiKeyId: "key-1",
  organizationId: "org-1",
  name: "Acme prod",
  tokenPrefix: "pxk_abcd",
  scopes: ["prescriptions.create"],
  quotaTier: "STANDARD",
  createdByUserId: "user-1",
} as const;

const SYNTHETIC_SIG = "Take 1 tablet by mouth every 8 hours as needed";

const RX_BODY = {
  clinicId: "aaaaaaaa-bbbb-4ccc-addd-eeeeeeee0001",
  patientId: "aaaaaaaa-bbbb-4ccc-addd-eeeeeeee0002",
  providerId: "aaaaaaaa-bbbb-4ccc-addd-eeeeeeee0003",
  drugNdc: "00093-0058-01",
  drugName: "Synthetic Test Tablet",
  quantityAuthorized: "30",
  daysSupply: 30,
  refillsAuthorized: 0,
  originalDateWritten: "2026-07-01",
  sig: SYNTHETIC_SIG,
} as const;

const RX_OUTPUT = {
  prescriptionId: "aaaaaaaa-bbbb-4ccc-addd-eeeeeeee0009",
  rxNumber: "RX-0000001",
  controlledSubstanceSchedule: "NON_CONTROLLED",
  expiresAt: "2027-07-01",
} as const;

function postRequest(input: {
  readonly body?: unknown;
  readonly rawBody?: string;
  readonly idempotencyKey?: string;
  readonly auth?: string | null;
}): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (input.auth !== null) headers["authorization"] = input.auth ?? "Bearer pxk_test-token";
  if (input.idempotencyKey !== undefined) headers["idempotency-key"] = input.idempotencyKey;
  return new Request("http://localhost/api/v1/prescriptions", {
    method: "POST",
    headers,
    body: input.rawBody ?? JSON.stringify(input.body ?? RX_BODY),
  });
}

function dispatchedInput(): Record<string, unknown> {
  const [, input] = executeCommandDetailedMock.mock.calls[0] as [unknown, Record<string, unknown>];
  return input;
}

beforeEach(() => {
  resolveApiKeyMock.mockReset().mockResolvedValue({ ok: true, key: RESOLVED_KEY });
  rateLimitHitMock.mockReset().mockResolvedValue({ allowed: true });
  executeCommandDetailedMock.mockReset();
  loggerMock.info.mockReset();
  loggerMock.warn.mockReset();
  loggerMock.error.mockReset();
});

describe("POST /api/v1/prescriptions", () => {
  it("401s without a bearer token", async () => {
    const res = await POST(postRequest({ auth: null, idempotencyKey: "rx-intake-1" }));
    expect(res.status).toBe(401);
    expect(executeCommandDetailedMock).not.toHaveBeenCalled();
  });

  it("403s a key without the prescriptions.create scope", async () => {
    resolveApiKeyMock.mockResolvedValue({
      ok: true,
      key: { ...RESOLVED_KEY, scopes: ["orders.create"] },
    });
    const res = await POST(postRequest({ idempotencyKey: "rx-intake-1" }));
    expect(res.status).toBe(403);
    expect(executeCommandDetailedMock).not.toHaveBeenCalled();
  });

  it("400s without an Idempotency-Key header", async () => {
    const res = await POST(postRequest({}));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(executeCommandDetailedMock).not.toHaveBeenCalled();
  });

  it("400s malformed JSON", async () => {
    const res = await POST(postRequest({ rawBody: "{nope", idempotencyKey: "rx-intake-1" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_JSON");
    expect(executeCommandDetailedMock).not.toHaveBeenCalled();
  });

  it("201s: forwards the body unchanged and namespaces the idempotency key per API key", async () => {
    executeCommandDetailedMock.mockResolvedValue({ output: RX_OUTPUT, replayed: false });
    const res = await POST(postRequest({ idempotencyKey: "rx-intake-1" }));
    expect(res.status).toBe(201);

    const [, input, options] = executeCommandDetailedMock.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
      { idempotencyKey: string },
    ];
    expect(input).toEqual(RX_BODY);
    expect(options.idempotencyKey).toBe("partner:key-1:rx-intake-1");

    const body = await res.json();
    expect(body.data).toEqual(RX_OUTPUT);
    expect(body.meta).toBeUndefined();
  });

  it("passes the controlled-substance fields through rather than defaulting them", async () => {
    executeCommandDetailedMock.mockResolvedValue({ output: RX_OUTPUT, replayed: false });
    await POST(
      postRequest({
        body: {
          ...RX_BODY,
          controlledSubstanceSchedule: "CII",
          expiresAt: "2026-12-01",
          earliestFillDate: "2026-07-05",
          daw: 1,
        },
        idempotencyKey: "rx-intake-2",
      })
    );
    const input = dispatchedInput();
    expect(input["controlledSubstanceSchedule"]).toBe("CII");
    expect(input["expiresAt"]).toBe("2026-12-01");
    expect(input["earliestFillDate"]).toBe("2026-07-05");
    expect(input["daw"]).toBe(1);
  });

  it("does not strip unknown fields — the command's strict schema rejects them", async () => {
    executeCommandDetailedMock.mockResolvedValue({ output: RX_OUTPUT, replayed: false });
    await POST(
      postRequest({
        body: { ...RX_BODY, refilsAuthorized: 3 },
        idempotencyKey: "rx-intake-3",
      })
    );
    expect(dispatchedInput()["refilsAuthorized"]).toBe(3);
  });

  it("replay: 200 with the ORIGINAL prescription and the replay flag — no duplicate Rx", async () => {
    executeCommandDetailedMock.mockResolvedValue({ output: RX_OUTPUT, replayed: true });
    const res = await POST(postRequest({ idempotencyKey: "rx-intake-1" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual(RX_OUTPUT);
    expect(body.meta).toEqual({ idempotentReplay: true });
  });

  it("400s a defective request with its typed code", async () => {
    executeCommandDetailedMock.mockRejectedValue(
      new errors.ValidationError({
        code: "RX_PATIENT_CLINIC_MISMATCH",
        message: "Patient does not belong to the specified clinic.",
      })
    );
    const res = await POST(postRequest({ idempotencyKey: "rx-intake-1" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("RX_PATIENT_CLINIC_MISMATCH");
  });

  it("422s a workflow-invariant refusal", async () => {
    executeCommandDetailedMock.mockRejectedValue(
      new errors.InvariantViolationError({
        code: "RX_CONTROLLED_AUTHORIZATION_INVALID",
        message: "A Schedule II prescription may not authorize refills.",
      })
    );
    const res = await POST(postRequest({ idempotencyKey: "rx-intake-1" }));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("RX_CONTROLLED_AUTHORIZATION_INVALID");
  });

  it("409s RX_NUMBER_COLLISION — the operator wording says retry, and 422 would forbid it", async () => {
    // The same condition must not read as "retry" on the console and
    // "your payload is defective" on the API. No client library
    // retries a 422.
    executeCommandDetailedMock.mockRejectedValue(
      new errors.ConflictError({
        code: "RX_NUMBER_COLLISION",
        message: "The allocated prescription number is already in use. Retry the transcription.",
      })
    );
    const res = await POST(postRequest({ idempotencyKey: "rx-intake-1" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("RX_NUMBER_COLLISION");
  });

  it("500s an allocator failure — our outage, not their request", async () => {
    // `allocateRxNumber` raises this as an InternalError on a database
    // failure. As a 422 it misattributed our fault to the caller AND
    // hid from the error-rate alarms on-call pages against.
    executeCommandDetailedMock.mockRejectedValue(
      new errors.InternalError({
        code: "RX_NUMBER_ALLOCATION_FAILED",
        message: "Rx number allocation failed for clinic clinic-1: deadlock detected.",
      })
    );
    const res = await POST(postRequest({ idempotencyKey: "rx-intake-1" }));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.error.code).toBe("RX_NUMBER_ALLOCATION_FAILED");
    // The class contract forbids echoing an InternalError message: it
    // carries driver text and internal identifiers.
    expect(body.error.message).not.toContain("deadlock");
    expect(body.error.message).not.toContain("clinic-1");

    // A 5xx that never reaches the logger never reaches Sentry, and
    // an internal failure nobody is paged for is the whole problem.
    expect(loggerMock.error).toHaveBeenCalledTimes(1);
  });

  it("keeps the sig out of the response and out of the logs on both paths", async () => {
    executeCommandDetailedMock.mockResolvedValue({ output: RX_OUTPUT, replayed: false });
    const ok = await POST(postRequest({ idempotencyKey: "rx-intake-1" }));
    expect(JSON.stringify(await ok.json())).not.toContain(SYNTHETIC_SIG);

    executeCommandDetailedMock.mockRejectedValue(
      new errors.ValidationError({
        code: "RX_NDC_INVALID",
        message: "Drug NDC is not a valid 10- or 11-digit National Drug Code.",
      })
    );
    const failed = await POST(postRequest({ idempotencyKey: "rx-intake-4" }));
    expect(JSON.stringify(await failed.json())).not.toContain(SYNTHETIC_SIG);

    const logged = JSON.stringify([
      loggerMock.info.mock.calls,
      loggerMock.warn.mock.calls,
      loggerMock.error.mock.calls,
    ]);
    expect(logged).not.toContain(SYNTHETIC_SIG);
  });
});
