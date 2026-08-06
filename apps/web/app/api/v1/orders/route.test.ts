// Contract tests for /api/v1/orders (ADR-0031 amended commitment 7).
//
// GET pins auth/scope gates, the status-filter contract, cursor
// pagination, and — security-critical — the PHI-free projection: no
// patient demographics may ever be selected on v1 order reads.
//
// POST (intake) pins the orders.create scope gate, the
// Idempotency-Key requirement, the platform-owned `intakeSourceKind`
// (a client claim is REJECTED, not coerced), the caller-namespaced
// idempotency key, and the 201-vs-replay-200 contract.
//
// It also pins the error-status contract, which used to flatten every
// rejection to 422: the status now comes from the error CLASS, so a
// state race is a retryable 409 and one of our own misconfigurations
// is a 5xx that error-rate alerting can see.

import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveApiKeyMock = vi.hoisted(() => vi.fn());
const rateLimitHitMock = vi.hoisted(() => vi.fn());
const readInOrgScopeMock = vi.hoisted(() => vi.fn());

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

vi.mock("@pharmax/database", () => ({
  prisma: {},
  readInOrgScope: readInOrgScopeMock,
  OrderStatus: { RECEIVED: "RECEIVED", SHIPPED: "SHIPPED" },
  IntakeSourceKind: { API: "API" },
}));

vi.mock("@pharmax/rbac", () => ({
  PERMISSIONS: { ORDERS_READ: "orders.read", ORDERS_CREATE: "orders.create" },
}));

vi.mock("@pharmax/tenancy", () => ({
  buildTenancyContext: (input: unknown) => input,
  withTenancyContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

// The POST intake path dispatches CreateOrder through the command
// bus; mocking both keeps @pharmax/orders' heavy transitive graph
// (workflow policy, SLA interval recorder, …) out of this route-layer
// suite, same as the other v1 route tests.
const executeCommandDetailedMock = vi.hoisted(() => vi.fn());
vi.mock("@pharmax/command-bus", () => ({
  executeCommandDetailed: executeCommandDetailedMock,
}));
vi.mock("@pharmax/orders", () => ({
  CreateOrder: { name: "CreateOrder" },
}));

vi.mock("@/server/env", () => ({ env: { REDIS_URL: undefined } }));

vi.mock("@/server/logger", () => {
  const noop = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
  noop.child.mockReturnValue(noop);
  return { logger: noop };
});

import { errors } from "@pharmax/platform-core";

import { GET, POST } from "./route.js";

const RESOLVED_KEY = {
  apiKeyId: "key-1",
  organizationId: "org-1",
  name: "Acme prod",
  tokenPrefix: "pxk_abcd",
  scopes: ["orders.read"],
  quotaTier: "STANDARD",
  createdByUserId: "user-1",
} as const;

function request(url: string, auth: string | null = "Bearer pxk_test-token"): Request {
  return new Request(url, {
    headers: auth === null ? {} : { authorization: auth },
  });
}

function stubOrders(rows: ReadonlyArray<Record<string, unknown>>) {
  const findMany = vi.fn().mockResolvedValue([...rows]);
  readInOrgScopeMock.mockImplementation(
    async (_org: string, fn: (tx: unknown) => Promise<unknown>) => fn({ order: { findMany } })
  );
  return findMany;
}

beforeEach(() => {
  resolveApiKeyMock.mockReset().mockResolvedValue({ ok: true, key: RESOLVED_KEY });
  rateLimitHitMock.mockReset().mockResolvedValue({ allowed: true });
  readInOrgScopeMock.mockReset();
  executeCommandDetailedMock.mockReset();
});

describe("GET /api/v1/orders", () => {
  it("401s without a bearer token", async () => {
    const res = await GET(request("http://localhost/api/v1/orders", null));
    expect(res.status).toBe(401);
  });

  it("403s a key without the orders.read scope", async () => {
    resolveApiKeyMock.mockResolvedValue({
      ok: true,
      key: { ...RESOLVED_KEY, scopes: ["webhooks.manage"] },
    });
    const res = await GET(request("http://localhost/api/v1/orders"));
    expect(res.status).toBe(403);
  });

  it("400s an unknown status filter", async () => {
    const res = await GET(request("http://localhost/api/v1/orders?status=TELEPORTED"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_STATUS");
  });

  it("selects a PHI-free projection scoped to the key's org", async () => {
    const findMany = stubOrders([]);
    const res = await GET(request("http://localhost/api/v1/orders?status=RECEIVED"));
    expect(res.status).toBe(200);

    expect(readInOrgScopeMock.mock.calls[0]?.[0]).toBe("org-1");
    const args = findMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
      select: Record<string, unknown>;
    };
    expect(args.where["organizationId"]).toBe("org-1");
    expect(args.where["currentStatus"]).toBe("RECEIVED");
    // The projection exposes opaque references only. Selecting a
    // patient RELATION (vs the opaque patientId) or demographics
    // would be a PHI leak on the public surface.
    const selected = Object.keys(args.select);
    expect(selected).toContain("patientId");
    for (const forbidden of ["patient", "firstName", "lastName", "dateOfBirth", "phone"]) {
      expect(selected).not.toContain(forbidden);
    }
  });

  it("paginates: limit+1 fetch, hasMore + nextCursor from the last page row", async () => {
    const findMany = stubOrders([{ id: "o-1" }, { id: "o-2" }, { id: "o-3" }]);
    const res = await GET(request("http://localhost/api/v1/orders?limit=2"));
    const body = await res.json();

    const args = findMany.mock.calls[0]?.[0] as { take: number };
    expect(args.take).toBe(3);
    expect(body.data).toHaveLength(2);
    expect(body.pagination).toEqual({ hasMore: true, nextCursor: "o-2" });
  });

  it("last page: hasMore false, nextCursor null, cursor forwarded to the query", async () => {
    const findMany = stubOrders([{ id: "o-3" }]);
    const res = await GET(request("http://localhost/api/v1/orders?limit=2&cursor=o-2"));
    const body = await res.json();

    const args = findMany.mock.calls[0]?.[0] as { cursor?: { id: string }; skip?: number };
    expect(args.cursor).toEqual({ id: "o-2" });
    expect(args.skip).toBe(1);
    expect(body.pagination).toEqual({ hasMore: false, nextCursor: null });
  });

  it("clamps limit to the 1-100 contract bounds", async () => {
    const findMany = stubOrders([]);
    await GET(request("http://localhost/api/v1/orders?limit=9999"));
    expect((findMany.mock.calls[0]?.[0] as { take: number }).take).toBe(101);

    const findMany2 = stubOrders([]);
    await GET(request("http://localhost/api/v1/orders?limit=0"));
    expect((findMany2.mock.calls[0]?.[0] as { take: number }).take).toBe(2);
  });
});

const INTAKE_KEY = { ...RESOLVED_KEY, scopes: ["orders.create"] } as const;

const INTAKE_BODY = {
  clinicId: "aaaaaaaa-bbbb-4ccc-addd-eeeeeeee0001",
  siteId: "aaaaaaaa-bbbb-4ccc-addd-eeeeeeee0002",
  patientId: "aaaaaaaa-bbbb-4ccc-addd-eeeeeeee0003",
  lines: [
    {
      prescriptionId: "aaaaaaaa-bbbb-4ccc-addd-eeeeeeee0004",
      quantityToFill: 30,
      daysSupplyToFill: 30,
    },
  ],
} as const;

const CREATE_OUTPUT = {
  orderId: "aaaaaaaa-bbbb-4ccc-addd-eeeeeeee0009",
  orderLineIds: ["aaaaaaaa-bbbb-4ccc-addd-eeeeeeee000a"],
  currentStatus: "RECEIVED",
  version: 0,
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
  return new Request("http://localhost/api/v1/orders", {
    method: "POST",
    headers,
    body: input.rawBody ?? JSON.stringify(input.body ?? INTAKE_BODY),
  });
}

describe("POST /api/v1/orders (intake)", () => {
  beforeEach(() => {
    resolveApiKeyMock.mockResolvedValue({ ok: true, key: INTAKE_KEY });
  });

  it("401s without a bearer token", async () => {
    const res = await POST(postRequest({ auth: null, idempotencyKey: "intake-1" }));
    expect(res.status).toBe(401);
    expect(executeCommandDetailedMock).not.toHaveBeenCalled();
  });

  it("403s a key without the orders.create scope (orders.read is NOT enough)", async () => {
    resolveApiKeyMock.mockResolvedValue({
      ok: true,
      key: { ...RESOLVED_KEY, scopes: ["orders.read"] },
    });
    const res = await POST(postRequest({ idempotencyKey: "intake-1" }));
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
    const res = await POST(postRequest({ rawBody: "{nope", idempotencyKey: "intake-1" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_JSON");
  });

  it("rejects a client-supplied intakeSourceKind instead of coercing it", async () => {
    const res = await POST(
      postRequest({
        body: { ...INTAKE_BODY, intakeSourceKind: "MANUAL" },
        idempotencyKey: "intake-1",
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INTAKE_SOURCE_NOT_SETTABLE");
    expect(executeCommandDetailedMock).not.toHaveBeenCalled();
  });

  it("201s: forces intakeSourceKind=API and namespaces the idempotency key per API key", async () => {
    executeCommandDetailedMock.mockResolvedValue({ output: CREATE_OUTPUT, replayed: false });
    const res = await POST(postRequest({ idempotencyKey: "intake-1" }));
    expect(res.status).toBe(201);

    const [, input, options] = executeCommandDetailedMock.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
      { idempotencyKey: string },
    ];
    expect(input["intakeSourceKind"]).toBe("API");
    expect(input["clinicId"]).toBe(INTAKE_BODY.clinicId);
    expect(input["lines"]).toEqual(INTAKE_BODY.lines);
    expect(options.idempotencyKey).toBe("partner:key-1:intake-1");

    const body = await res.json();
    expect(body.data).toEqual(CREATE_OUTPUT);
    expect(body.meta).toBeUndefined();
  });

  it("passes optional fields through only when present", async () => {
    executeCommandDetailedMock.mockResolvedValue({ output: CREATE_OUTPUT, replayed: false });
    await POST(
      postRequest({
        body: { ...INTAKE_BODY, externalOrderNumber: "CL-1001", priority: "RUSH" },
        idempotencyKey: "intake-2",
      })
    );
    const [, input] = executeCommandDetailedMock.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
    ];
    expect(input["externalOrderNumber"]).toBe("CL-1001");
    expect(input["priority"]).toBe("RUSH");
    expect("intakeSourceRefId" in input).toBe(false);
  });

  it("replay: 200 with the ORIGINAL order and the replay flag — no duplicate order", async () => {
    executeCommandDetailedMock.mockResolvedValue({ output: CREATE_OUTPUT, replayed: true });
    const res = await POST(postRequest({ idempotencyKey: "intake-1" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual(CREATE_OUTPUT);
    expect(body.meta).toEqual({ idempotentReplay: true });
  });

  it("surfaces command-level rejections with their typed code, at the status of their class", async () => {
    executeCommandDetailedMock.mockRejectedValue(
      new errors.NotFoundError({
        code: "ORDER_PATIENT_NOT_FOUND",
        message: "Patient not found in this clinic.",
      })
    );
    const res = await POST(postRequest({ idempotencyKey: "intake-1" }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("ORDER_PATIENT_NOT_FOUND");
  });

  it("409s a state race so a partner client can retry it", async () => {
    executeCommandDetailedMock.mockRejectedValue(
      new errors.ConflictError({
        code: "ORDER_SITE_NOT_LINKED_TO_CLINIC",
        message: "Site is not linked to this clinic.",
      })
    );
    const res = await POST(postRequest({ idempotencyKey: "intake-1" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("ORDER_SITE_NOT_LINKED_TO_CLINIC");
  });

  it("500s a misconfiguration on OUR side instead of blaming the partner's payload", async () => {
    // `CreateOrder` raises both of these as InternalError. Reported as
    // 422 they told the partner their request was defective and stayed
    // invisible to error-rate alerting.
    executeCommandDetailedMock.mockRejectedValue(
      new errors.InternalError({
        code: "ORDER_INTAKE_BUCKET_NOT_CONFIGURED",
        message: "No INBOX bucket is provisioned for org org-1.",
      })
    );
    const res = await POST(postRequest({ idempotencyKey: "intake-1" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("ORDER_INTAKE_BUCKET_NOT_CONFIGURED");
    expect(body.error.message).not.toContain("org-1");
  });
});
