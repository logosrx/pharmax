// Contract tests for DELETE /api/v1/webhook-subscriptions/{id}
// (ADR-0031 amended commitment 7). Pins the UUID gate, the
// Idempotency-Key requirement, the not-found → 404 mapping, and the
// default revocation reason.

import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveApiKeyMock = vi.hoisted(() => vi.fn());
const rateLimitHitMock = vi.hoisted(() => vi.fn());
const executeCommandMock = vi.hoisted(() => vi.fn());

vi.mock("@pharmax/partner-api", () => ({
  resolveApiKey: resolveApiKeyMock,
  RevokeWebhookSubscription: { name: "RevokeWebhookSubscription" },
}));

vi.mock("@pharmax/command-bus", () => ({
  executeCommand: executeCommandMock,
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

import { DELETE } from "./route.js";

const SUB_ID = "aaaaaaaa-bbbb-4ccc-addd-eeeeeeeeeeee";

const RESOLVED_KEY = {
  apiKeyId: "key-1",
  organizationId: "org-1",
  name: "Acme prod",
  tokenPrefix: "pxk_abcd",
  scopes: ["webhooks.manage"],
  createdByUserId: "user-1",
} as const;

function call(input: {
  readonly subscriptionId: string;
  readonly idempotencyKey?: string;
  readonly body?: unknown;
}) {
  const headers: Record<string, string> = { authorization: "Bearer pxk_test-token" };
  if (input.idempotencyKey !== undefined) headers["idempotency-key"] = input.idempotencyKey;
  const req = new Request(`http://localhost/api/v1/webhook-subscriptions/${input.subscriptionId}`, {
    method: "DELETE",
    headers,
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
  return DELETE(req, { params: Promise.resolve({ subscriptionId: input.subscriptionId }) });
}

beforeEach(() => {
  resolveApiKeyMock.mockReset().mockResolvedValue({ ok: true, key: RESOLVED_KEY });
  rateLimitHitMock.mockReset().mockResolvedValue({ allowed: true });
  executeCommandMock.mockReset();
});

describe("DELETE /api/v1/webhook-subscriptions/{id}", () => {
  it("400s without an Idempotency-Key header", async () => {
    const res = await call({ subscriptionId: SUB_ID });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it("400s a non-UUID subscription id", async () => {
    const res = await call({ subscriptionId: "nope", idempotencyKey: "revoke-attempt-1" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_SUBSCRIPTION_ID");
  });

  it("404s the command's not-found error", async () => {
    executeCommandMock.mockRejectedValue(
      new errors.NotFoundError({
        code: "REVOKE_WEBHOOK_SUBSCRIPTION_NOT_FOUND",
        message: "No such subscription.",
      })
    );
    const res = await call({ subscriptionId: SUB_ID, idempotencyKey: "revoke-attempt-1" });
    expect(res.status).toBe(404);
  });

  it("422s any other command error with its code", async () => {
    executeCommandMock.mockRejectedValue(
      new errors.ConflictError({ code: "SOMETHING_ELSE", message: "nope" })
    );
    const res = await call({ subscriptionId: SUB_ID, idempotencyKey: "revoke-attempt-1" });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("SOMETHING_ELSE");
  });

  it("revokes with the caller-namespaced idempotency key and the default reason", async () => {
    executeCommandMock.mockResolvedValue({ subscriptionId: SUB_ID, status: "REVOKED" });
    const res = await call({ subscriptionId: SUB_ID, idempotencyKey: "revoke-attempt-1" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe("REVOKED");

    const [, input, options] = executeCommandMock.mock.calls[0] as [
      unknown,
      { subscriptionId: string; reason: string },
      { idempotencyKey: string },
    ];
    expect(input).toEqual({ subscriptionId: SUB_ID, reason: "revoked via partner API" });
    expect(options.idempotencyKey).toBe("partner:key-1:revoke-attempt-1");
  });

  it("passes a caller-supplied reason through", async () => {
    executeCommandMock.mockResolvedValue({ subscriptionId: SUB_ID, status: "REVOKED" });
    await call({
      subscriptionId: SUB_ID,
      idempotencyKey: "revoke-attempt-2",
      body: { reason: "rotating signing secret" },
    });
    const [, input] = executeCommandMock.mock.calls[0] as [unknown, { reason: string }];
    expect(input.reason).toBe("rotating signing secret");
  });
});
