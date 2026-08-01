// Enforcement tests for resolvePartnerContext (ADR-0032).
//
// The behavior pinned here: quota-tier enforcement is TWO limiter
// windows resolved from the key's tier — a per-minute burst gate
// (429 RATE_LIMITED, transient) and a daily quota (429
// QUOTA_EXCEEDED, sustained) — and the daily counter only counts
// requests that already passed the burst gate. Unauthenticated
// requests never touch the limiter at all (an attacker without a
// key cannot burn a partner's quota).

import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveApiKeyMock = vi.hoisted(() => vi.fn());
const hitMock = vi.hoisted(() => vi.fn());

const QUOTAS = vi.hoisted(() => ({
  STANDARD: {
    tier: "STANDARD",
    burst: { limit: 120, windowMs: 60_000 },
    daily: { limit: 50_000, windowMs: 86_400_000 },
  },
  ELEVATED: {
    tier: "ELEVATED",
    burst: { limit: 600, windowMs: 60_000 },
    daily: { limit: 250_000, windowMs: 86_400_000 },
  },
}));

vi.mock("server-only", () => ({}));

vi.mock("@pharmax/partner-api", () => ({
  resolveApiKey: resolveApiKeyMock,
  getApiKeyQuota: (tier: "STANDARD" | "ELEVATED") => QUOTAS[tier],
}));

vi.mock("@pharmax/composition", () => ({
  createRateLimiterFromEnv: () => ({
    rateLimiter: { hit: hitMock },
    close: async () => {},
  }),
}));

vi.mock("@pharmax/database", () => ({ prisma: {} }));

vi.mock("@pharmax/tenancy", () => ({
  buildTenancyContext: (input: unknown) => input,
}));

vi.mock("@/server/env", () => ({ env: { REDIS_URL: undefined } }));

vi.mock("@/server/logger", () => {
  const noop = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
  noop.child.mockReturnValue(noop);
  return { logger: noop };
});

import { resolvePartnerContext } from "./resolve-partner-context.js";

const RESOLVED_KEY = {
  apiKeyId: "ak-1",
  organizationId: "org-1",
  name: "Acme prod",
  tokenPrefix: "pxk_tttt",
  scopes: ["orders.read"],
  quotaTier: "STANDARD",
  createdByUserId: "user-minter",
};

function request(authorization?: string): Request {
  return new Request("http://localhost/api/v1/orders", {
    headers: authorization === undefined ? {} : { authorization },
  });
}

const ALLOWED = { allowed: true, retryAfterMs: 0 };

beforeEach(() => {
  resolveApiKeyMock.mockReset().mockResolvedValue({ ok: true, key: RESOLVED_KEY });
  hitMock.mockReset().mockResolvedValue(ALLOWED);
});

describe("resolvePartnerContext quota enforcement", () => {
  it("401s without a bearer token and never touches the limiter", async () => {
    const result = await resolvePartnerContext(request());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
    expect(resolveApiKeyMock).not.toHaveBeenCalled();
    expect(hitMock).not.toHaveBeenCalled();
  });

  it("401s an unresolvable key and never touches the limiter — anonymous traffic cannot burn a partner's quota", async () => {
    resolveApiKeyMock.mockResolvedValue({ ok: false, reason: "RESOLVE_API_KEY_NOT_FOUND" });
    const result = await resolvePartnerContext(request("Bearer pxk_bogus"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
    expect(hitMock).not.toHaveBeenCalled();
  });

  it("hits burst then daily windows, keyed per key id, with the tier's rules", async () => {
    const result = await resolvePartnerContext(request("Bearer pxk_valid"));
    expect(result.ok).toBe(true);

    expect(hitMock).toHaveBeenCalledTimes(2);
    expect(hitMock).toHaveBeenNthCalledWith(1, "partner-api:burst:ak-1", QUOTAS.STANDARD.burst);
    expect(hitMock).toHaveBeenNthCalledWith(2, "partner-api:daily:ak-1", QUOTAS.STANDARD.daily);
  });

  it("resolves the ELEVATED tier's rules for an ELEVATED key", async () => {
    resolveApiKeyMock.mockResolvedValue({
      ok: true,
      key: { ...RESOLVED_KEY, quotaTier: "ELEVATED" },
    });
    await resolvePartnerContext(request("Bearer pxk_valid"));
    expect(hitMock).toHaveBeenNthCalledWith(1, "partner-api:burst:ak-1", QUOTAS.ELEVATED.burst);
    expect(hitMock).toHaveBeenNthCalledWith(2, "partner-api:daily:ak-1", QUOTAS.ELEVATED.daily);
  });

  it("429 RATE_LIMITED with Retry-After when the burst window rejects — and daily quota is NOT consumed", async () => {
    hitMock.mockResolvedValueOnce({ allowed: false, retryAfterMs: 30_500 });

    const result = await resolvePartnerContext(request("Bearer pxk_valid"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(429);
      expect(result.response.headers.get("retry-after")).toBe("31");
      const body = await result.response.json();
      expect(body.error.code).toBe("RATE_LIMITED");
    }
    // The daily window was never hit: a spike being shaped must not
    // also burn the partner's daily allowance.
    expect(hitMock).toHaveBeenCalledTimes(1);
  });

  it("429 QUOTA_EXCEEDED with Retry-After when the daily window rejects", async () => {
    hitMock
      .mockResolvedValueOnce(ALLOWED)
      .mockResolvedValueOnce({ allowed: false, retryAfterMs: 3_600_000 });

    const result = await resolvePartnerContext(request("Bearer pxk_valid"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(429);
      expect(result.response.headers.get("retry-after")).toBe("3600");
      const body = await result.response.json();
      expect(body.error.code).toBe("QUOTA_EXCEEDED");
    }
  });

  it("builds the tenancy context in the key's org with the minter as the acting user", async () => {
    const result = await resolvePartnerContext(request("Bearer pxk_valid"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.key).toBe(RESOLVED_KEY);
      const tenancy = result.context.tenancy as unknown as {
        organizationId: string;
        actor: { userId: string };
      };
      expect(tenancy.organizationId).toBe("org-1");
      expect(tenancy.actor.userId).toBe("user-minter");
    }
  });
});
