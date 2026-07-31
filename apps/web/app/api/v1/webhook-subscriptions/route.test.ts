// Contract tests for /api/v1/webhook-subscriptions (ADR-0031
// amended commitment 7: every partner capability is contract-tested
// at the HTTP layer).
//
// The command bus, partner-api package, and Prisma are mocked; what
// runs REAL is the route control flow plus the partner context
// resolver (auth, rate limit, scope, Idempotency-Key header gates).
//
// The POST replay tests pin the ADR-0032 one-time-secret contract:
// a retried request must observe the stored subscription and MUST
// NOT receive the fresh (unstored) signing secret.

import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveApiKeyMock = vi.hoisted(() => vi.fn());
const rateLimitHitMock = vi.hoisted(() => vi.fn());
const executeCommandDetailedMock = vi.hoisted(() => vi.fn());
const readInOrgScopeMock = vi.hoisted(() => vi.fn());
const FRESH_SECRET = vi.hoisted(() => `pxw_${"s".repeat(43)}`);

vi.mock("@pharmax/partner-api", () => ({
  resolveApiKey: resolveApiKeyMock,
  CreateWebhookSubscription: { name: "CreateWebhookSubscription" },
  generateWebhookSecret: () => FRESH_SECRET,
  listWebhookEligibleEventTypes: () => [
    "order.shipped.v1",
    "platform.webhook_subscription.created.v1",
  ],
}));

vi.mock("@pharmax/command-bus", () => ({
  executeCommandDetailed: executeCommandDetailedMock,
}));

vi.mock("@pharmax/composition", () => ({
  createRateLimiterFromEnv: () => ({ rateLimiter: { hit: rateLimitHitMock } }),
}));

vi.mock("@pharmax/database", () => ({
  prisma: {},
  readInOrgScope: readInOrgScopeMock,
}));

vi.mock("@pharmax/rbac", () => ({
  PERMISSIONS: { WEBHOOKS_MANAGE: "webhooks.manage" },
}));

vi.mock("@pharmax/tenancy", () => ({
  buildTenancyContext: (input: unknown) => input,
  withTenancyContext: (_ctx: unknown, fn: () => Promise<unknown>) => fn(),
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
  scopes: ["webhooks.manage"],
  createdByUserId: "user-1",
} as const;

function request(input: {
  readonly method?: string;
  readonly auth?: string | null;
  readonly idempotencyKey?: string | null;
  readonly body?: unknown;
}): Request {
  const headers: Record<string, string> = {};
  if (input.auth !== null) headers["authorization"] = input.auth ?? "Bearer pxk_test-token";
  if (input.idempotencyKey !== undefined && input.idempotencyKey !== null) {
    headers["idempotency-key"] = input.idempotencyKey;
  }
  return new Request("http://localhost/api/v1/webhook-subscriptions", {
    method: input.method ?? "POST",
    headers,
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
}

const VALID_BODY = {
  url: "https://partner.example.com/hooks",
  eventTypes: ["order.shipped.v1"],
};

beforeEach(() => {
  resolveApiKeyMock.mockReset().mockResolvedValue({ ok: true, key: RESOLVED_KEY });
  rateLimitHitMock.mockReset().mockResolvedValue({ allowed: true });
  executeCommandDetailedMock.mockReset();
  readInOrgScopeMock.mockReset();
});

describe("GET /api/v1/webhook-subscriptions", () => {
  it("401s without an Authorization bearer", async () => {
    const res = await GET(request({ method: "GET", auth: null }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHENTICATED");
  });

  it("401s an unknown/revoked key without distinguishing which", async () => {
    resolveApiKeyMock.mockResolvedValue({ ok: false, reason: "RESOLVE_API_KEY_REVOKED" });
    const res = await GET(request({ method: "GET" }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.message).toBe("Invalid API key.");
  });

  it("429s with retry-after when the per-key limiter denies", async () => {
    rateLimitHitMock.mockResolvedValue({ allowed: false, retryAfterMs: 30_000 });
    const res = await GET(request({ method: "GET" }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
  });

  it("403s a key without the webhooks.manage scope", async () => {
    resolveApiKeyMock.mockResolvedValue({
      ok: true,
      key: { ...RESOLVED_KEY, scopes: ["orders.read"] },
    });
    const res = await GET(request({ method: "GET" }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("SCOPE_DENIED");
  });

  it("lists subscriptions org-scoped, secret NEVER selected, with eligible event types", async () => {
    const rows = [{ id: "sub-1", url: "https://partner.example.com/hooks", status: "ACTIVE" }];
    const findMany = vi.fn().mockResolvedValue(rows);
    readInOrgScopeMock.mockImplementation(
      async (_org: string, fn: (tx: unknown) => Promise<unknown>) =>
        fn({ webhookSubscription: { findMany } })
    );

    const res = await GET(request({ method: "GET" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual(rows);
    expect(body.eligibleEventTypes).toEqual([
      "order.shipped.v1",
      "platform.webhook_subscription.created.v1",
    ]);

    expect(readInOrgScopeMock.mock.calls[0]?.[0]).toBe("org-1");
    const args = findMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
      select: Record<string, unknown>;
    };
    expect(args.where["organizationId"]).toBe("org-1");
    // One-time-secret contract: neither the ciphertext envelope nor
    // any secret projection may appear in a list response.
    expect(Object.keys(args.select)).not.toContain("secretEnc");
    expect(Object.keys(args.select)).not.toContain("secret");
  });
});

describe("POST /api/v1/webhook-subscriptions", () => {
  it("400s without an Idempotency-Key header", async () => {
    const res = await POST(request({ body: VALID_BODY }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(executeCommandDetailedMock).not.toHaveBeenCalled();
  });

  it("400s an Idempotency-Key that is too short", async () => {
    const res = await POST(request({ idempotencyKey: "short", body: VALID_BODY }));
    expect(res.status).toBe(400);
    expect(executeCommandDetailedMock).not.toHaveBeenCalled();
  });

  it("400s a non-JSON body", async () => {
    const req = new Request("http://localhost/api/v1/webhook-subscriptions", {
      method: "POST",
      headers: {
        authorization: "Bearer pxk_test-token",
        "idempotency-key": "retry-boundary-1",
      },
      body: "not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_JSON");
  });

  it("201s a FIRST creation with the signing secret, idempotency key namespaced per API key", async () => {
    executeCommandDetailedMock.mockResolvedValue({
      output: {
        subscriptionId: "sub-1",
        url: VALID_BODY.url,
        eventTypes: VALID_BODY.eventTypes,
        status: "ACTIVE",
      },
      replayed: false,
    });

    const res = await POST(request({ idempotencyKey: "retry-boundary-1", body: VALID_BODY }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.id).toBe("sub-1");
    expect(body.data.secret).toBe(FRESH_SECRET);
    expect(body.meta).toBeUndefined();

    const [, input, options] = executeCommandDetailedMock.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
      { idempotencyKey: string },
    ];
    expect(input["secret"]).toBe(FRESH_SECRET);
    expect(options.idempotencyKey).toBe("partner:key-1:retry-boundary-1");
  });

  it("REPLAY returns the stored subscription with secret: null — never the fresh unstored secret", async () => {
    executeCommandDetailedMock.mockResolvedValue({
      output: {
        subscriptionId: "sub-original",
        url: VALID_BODY.url,
        eventTypes: VALID_BODY.eventTypes,
        status: "ACTIVE",
      },
      replayed: true,
    });

    const res = await POST(request({ idempotencyKey: "retry-boundary-1", body: VALID_BODY }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe("sub-original");
    expect(body.data.secret).toBeNull();
    expect(body.meta).toEqual({ idempotentReplay: true });
    // The fresh secret must not leak anywhere in the payload.
    expect(JSON.stringify(body)).not.toContain(FRESH_SECRET);
  });

  it("maps a command PharmaxError to a 422 with its code", async () => {
    executeCommandDetailedMock.mockRejectedValue(
      new errors.ValidationError({
        code: "CREATE_WEBHOOK_SUBSCRIPTION_URL_NOT_HTTPS",
        message: "Webhook endpoints must be HTTPS.",
      })
    );
    const res = await POST(
      request({
        idempotencyKey: "retry-boundary-1",
        body: { ...VALID_BODY, url: "http://insecure.example.com" },
      })
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("CREATE_WEBHOOK_SUBSCRIPTION_URL_NOT_HTTPS");
  });
});
