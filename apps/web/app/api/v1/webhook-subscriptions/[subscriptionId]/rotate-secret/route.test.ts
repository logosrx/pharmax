// Contract tests for POST
// /api/v1/webhook-subscriptions/{id}/rotate-secret (ADR-0031 amended
// commitment 7). Pins the scope gate, the Idempotency-Key
// requirement, the one-time secret contract (fresh secret on first
// call, `secret: null` on replay — a replay must never surface the
// unstored fresh value), and the not-found → 404 mapping.

import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveApiKeyMock = vi.hoisted(() => vi.fn());
const rateLimitHitMock = vi.hoisted(() => vi.fn());
const executeCommandDetailedMock = vi.hoisted(() => vi.fn());

const FRESH_SECRET = `pxw_${"f".repeat(43)}`;

vi.mock("@pharmax/partner-api", () => ({
  resolveApiKey: resolveApiKeyMock,
  RotateWebhookSubscriptionSecret: { name: "RotateWebhookSubscriptionSecret" },
  generateWebhookSecret: () => FRESH_SECRET,
  getApiKeyQuota: () => ({
    tier: "STANDARD",
    burst: { limit: 120, windowMs: 60_000 },
    daily: { limit: 50_000, windowMs: 86_400_000 },
  }),
}));

vi.mock("@pharmax/command-bus", () => ({
  executeCommandDetailed: executeCommandDetailedMock,
}));

vi.mock("@pharmax/composition", () => ({
  createRateLimiterFromEnv: () => ({ rateLimiter: { hit: rateLimitHitMock } }),
}));

vi.mock("@pharmax/database", () => ({ prisma: {} }));

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

import { POST } from "./route.js";

const SUB_ID = "aaaaaaaa-bbbb-4ccc-addd-eeeeeeeeeeee";

const RESOLVED_KEY = {
  apiKeyId: "key-1",
  organizationId: "org-1",
  name: "Acme prod",
  tokenPrefix: "pxk_abcd",
  scopes: ["webhooks.manage"],
  quotaTier: "STANDARD",
  createdByUserId: "user-1",
} as const;

const COMMAND_OUTPUT = {
  subscriptionId: SUB_ID,
  url: "https://partner.example.com/hooks",
  rotatedAt: "2026-07-31T12:00:00.000Z",
} as const;

function call(input: {
  readonly subscriptionId: string;
  readonly idempotencyKey?: string;
  readonly auth?: string | null;
}) {
  const headers: Record<string, string> = {};
  if (input.auth !== null) headers["authorization"] = input.auth ?? "Bearer pxk_test-token";
  if (input.idempotencyKey !== undefined) headers["idempotency-key"] = input.idempotencyKey;
  const req = new Request(
    `http://localhost/api/v1/webhook-subscriptions/${input.subscriptionId}/rotate-secret`,
    { method: "POST", headers }
  );
  return POST(req, { params: Promise.resolve({ subscriptionId: input.subscriptionId }) });
}

beforeEach(() => {
  resolveApiKeyMock.mockReset().mockResolvedValue({ ok: true, key: RESOLVED_KEY });
  rateLimitHitMock.mockReset().mockResolvedValue({ allowed: true });
  executeCommandDetailedMock.mockReset();
});

describe("POST /api/v1/webhook-subscriptions/{id}/rotate-secret", () => {
  it("401s without a bearer token", async () => {
    const res = await call({
      subscriptionId: SUB_ID,
      auth: null,
      idempotencyKey: "rotate-attempt-1",
    });
    expect(res.status).toBe(401);
    expect(executeCommandDetailedMock).not.toHaveBeenCalled();
  });

  it("403s a key without the webhooks.manage scope", async () => {
    resolveApiKeyMock.mockResolvedValue({
      ok: true,
      key: { ...RESOLVED_KEY, scopes: ["orders.read"] },
    });
    const res = await call({ subscriptionId: SUB_ID, idempotencyKey: "rotate-attempt-1" });
    expect(res.status).toBe(403);
  });

  it("400s without an Idempotency-Key header", async () => {
    const res = await call({ subscriptionId: SUB_ID });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(executeCommandDetailedMock).not.toHaveBeenCalled();
  });

  it("400s a non-UUID subscription id", async () => {
    const res = await call({ subscriptionId: "nope", idempotencyKey: "rotate-attempt-1" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_SUBSCRIPTION_ID");
  });

  it("rotates: dispatches the fresh secret under the caller-namespaced key and returns it once", async () => {
    executeCommandDetailedMock.mockResolvedValue({ output: COMMAND_OUTPUT, replayed: false });
    const res = await call({ subscriptionId: SUB_ID, idempotencyKey: "rotate-attempt-1" });
    expect(res.status).toBe(200);

    const [, input, options] = executeCommandDetailedMock.mock.calls[0] as [
      unknown,
      { subscriptionId: string; secret: string },
      { idempotencyKey: string },
    ];
    expect(input).toEqual({ subscriptionId: SUB_ID, secret: FRESH_SECRET });
    expect(options.idempotencyKey).toBe("partner:key-1:rotate-attempt-1");

    const body = await res.json();
    expect(body.data.secret).toBe(FRESH_SECRET);
    expect(body.data.subscriptionId).toBe(SUB_ID);
    expect(body.meta).toBeUndefined();
  });

  it("replay: secret is null (the fresh value was never stored) and the replay is flagged", async () => {
    executeCommandDetailedMock.mockResolvedValue({ output: COMMAND_OUTPUT, replayed: true });
    const res = await call({ subscriptionId: SUB_ID, idempotencyKey: "rotate-attempt-1" });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.secret).toBeNull();
    expect(body.meta).toEqual({ idempotentReplay: true });
  });

  it("404s the command's not-found error", async () => {
    executeCommandDetailedMock.mockRejectedValue(
      new errors.NotFoundError({
        code: "ROTATE_WEBHOOK_SUBSCRIPTION_SECRET_NOT_FOUND",
        message: "No such subscription.",
      })
    );
    const res = await call({ subscriptionId: SUB_ID, idempotencyKey: "rotate-attempt-1" });
    expect(res.status).toBe(404);
  });

  it("409s the disabled-subscription conflict with its code", async () => {
    executeCommandDetailedMock.mockRejectedValue(
      new errors.ConflictError({
        code: "ROTATE_WEBHOOK_SUBSCRIPTION_SECRET_DISABLED",
        message: "Cannot rotate a disabled subscription.",
      })
    );
    const res = await call({ subscriptionId: SUB_ID, idempotencyKey: "rotate-attempt-1" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("ROTATE_WEBHOOK_SUBSCRIPTION_SECRET_DISABLED");
  });
});
