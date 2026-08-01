// Contract tests for GET /api/v1/webhook-deliveries (ADR-0031
// amended commitment 7). The delivery ledger is the partner's
// self-diagnosis surface: status/subscription filters, cursor
// pagination, and NO payload snapshot in the list projection.

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
  WebhookDeliveryStatus: { PENDING: "PENDING", SENT: "SENT", FAILED: "FAILED", DEAD: "DEAD" },
}));

vi.mock("@pharmax/rbac", () => ({
  PERMISSIONS: { WEBHOOKS_MANAGE: "webhooks.manage" },
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

const RESOLVED_KEY = {
  apiKeyId: "key-1",
  organizationId: "org-1",
  name: "Acme prod",
  tokenPrefix: "pxk_abcd",
  scopes: ["webhooks.manage"],
  quotaTier: "STANDARD",
  createdByUserId: "user-1",
} as const;

function request(url: string, auth: string | null = "Bearer pxk_test-token"): Request {
  return new Request(url, {
    headers: auth === null ? {} : { authorization: auth },
  });
}

function stubDeliveries(rows: ReadonlyArray<Record<string, unknown>>) {
  const findMany = vi.fn().mockResolvedValue([...rows]);
  readInOrgScopeMock.mockImplementation(
    async (_org: string, fn: (tx: unknown) => Promise<unknown>) =>
      fn({ webhookDelivery: { findMany } })
  );
  return findMany;
}

beforeEach(() => {
  resolveApiKeyMock.mockReset().mockResolvedValue({ ok: true, key: RESOLVED_KEY });
  rateLimitHitMock.mockReset().mockResolvedValue({ allowed: true });
  readInOrgScopeMock.mockReset();
});

describe("GET /api/v1/webhook-deliveries", () => {
  it("401s without a bearer token", async () => {
    const res = await GET(request("http://localhost/api/v1/webhook-deliveries", null));
    expect(res.status).toBe(401);
  });

  it("403s a key without the webhooks.manage scope", async () => {
    resolveApiKeyMock.mockResolvedValue({
      ok: true,
      key: { ...RESOLVED_KEY, scopes: ["orders.read"] },
    });
    const res = await GET(request("http://localhost/api/v1/webhook-deliveries"));
    expect(res.status).toBe(403);
  });

  it("400s an unknown delivery status", async () => {
    const res = await GET(request("http://localhost/api/v1/webhook-deliveries?status=LOST"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_STATUS");
  });

  it("dead-letter view: DEAD + subscriptionId filters land in the org-scoped where clause", async () => {
    const findMany = stubDeliveries([]);
    const res = await GET(
      request("http://localhost/api/v1/webhook-deliveries?status=DEAD&subscriptionId=sub-9")
    );
    expect(res.status).toBe(200);

    const args = findMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
      select: Record<string, unknown>;
    };
    expect(args.where).toMatchObject({
      organizationId: "org-1",
      status: "DEAD",
      subscriptionId: "sub-9",
    });
    // The list never includes the event payload snapshot.
    expect(Object.keys(args.select)).not.toContain("payload");
  });

  it("paginates with hasMore + nextCursor", async () => {
    stubDeliveries([{ id: "d-1" }, { id: "d-2" }]);
    const res = await GET(request("http://localhost/api/v1/webhook-deliveries?limit=1"));
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.pagination).toEqual({ hasMore: true, nextCursor: "d-1" });
  });
});
