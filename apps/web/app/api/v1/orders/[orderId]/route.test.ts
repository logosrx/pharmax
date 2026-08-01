// Contract tests for GET /api/v1/orders/{orderId} (ADR-0031 amended
// commitment 7). Pins the UUID gate, org-scoped 404, and the
// PHI-free detail projection (order lines + shipments, no patient
// demographics).

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
}));

vi.mock("@pharmax/rbac", () => ({
  PERMISSIONS: { ORDERS_READ: "orders.read" },
}));

vi.mock("@pharmax/tenancy", () => ({
  buildTenancyContext: (input: unknown) => input,
}));

vi.mock("@/server/env", () => ({ env: { REDIS_URL: undefined } }));

vi.mock("@/server/logger", () => {
  const noop = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
  noop.child.mockReturnValue(noop);
  return { logger: noop };
});

import { GET } from "./route.js";

const ORDER_ID = "11111111-2222-4333-a444-555555555555";

const RESOLVED_KEY = {
  apiKeyId: "key-1",
  organizationId: "org-1",
  name: "Acme prod",
  tokenPrefix: "pxk_abcd",
  scopes: ["orders.read"],
  quotaTier: "STANDARD",
  createdByUserId: "user-1",
} as const;

function call(orderId: string, auth: string | null = "Bearer pxk_test-token") {
  const req = new Request(`http://localhost/api/v1/orders/${orderId}`, {
    headers: auth === null ? {} : { authorization: auth },
  });
  return GET(req, { params: Promise.resolve({ orderId }) });
}

function stubOrder(row: Record<string, unknown> | null) {
  const findFirst = vi.fn().mockResolvedValue(row);
  readInOrgScopeMock.mockImplementation(
    async (_org: string, fn: (tx: unknown) => Promise<unknown>) => fn({ order: { findFirst } })
  );
  return findFirst;
}

beforeEach(() => {
  resolveApiKeyMock.mockReset().mockResolvedValue({ ok: true, key: RESOLVED_KEY });
  rateLimitHitMock.mockReset().mockResolvedValue({ allowed: true });
  readInOrgScopeMock.mockReset();
});

describe("GET /api/v1/orders/{orderId}", () => {
  it("401s without a bearer token", async () => {
    const res = await call(ORDER_ID, null);
    expect(res.status).toBe(401);
  });

  it("400s a non-UUID id before touching the database", async () => {
    const res = await call("not-a-uuid");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_ORDER_ID");
    expect(readInOrgScopeMock).not.toHaveBeenCalled();
  });

  it("404s when no order matches inside the key's org scope", async () => {
    stubOrder(null);
    const res = await call(ORDER_ID);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("ORDER_NOT_FOUND");
  });

  it("200s with the detail projection, query double-scoped by id AND organizationId", async () => {
    const row = { id: ORDER_ID, currentStatus: "SHIPPED", orderLines: [], shipments: [] };
    const findFirst = stubOrder(row);
    const res = await call(ORDER_ID);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual(row);

    const args = findFirst.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
      select: Record<string, unknown>;
    };
    expect(args.where).toEqual({ id: ORDER_ID, organizationId: "org-1" });
    // PHI-free contract: opaque patientId reference only, never a
    // patient relation or demographics.
    const selected = Object.keys(args.select);
    expect(selected).toContain("patientId");
    expect(selected).toContain("orderLines");
    expect(selected).toContain("shipments");
    expect(selected).not.toContain("patient");
  });
});
