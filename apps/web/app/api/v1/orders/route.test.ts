// Contract tests for GET /api/v1/orders (ADR-0031 amended
// commitment 7). Pins auth/scope gates, the status-filter contract,
// cursor pagination, and — security-critical — the PHI-free
// projection: no patient demographics may ever be selected on v1
// order reads.

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

import { GET } from "./route.js";

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
