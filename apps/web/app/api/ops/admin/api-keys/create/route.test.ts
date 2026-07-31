// Contract tests for POST /api/ops/admin/api-keys/create.
//
// The critical regression pinned here: the idempotency key is the
// CALLER's retry boundary (Idempotency-Key header, namespaced per
// operator) — never derived from the per-attempt token hash, which
// made every retry mint a second live key. On a replay the stored
// key's metadata comes back WITHOUT a token (the raw token is
// unrecoverable by design; recovery is revoke + re-mint).

import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveOperatorTenancyContextMock = vi.hoisted(() => vi.fn());
const loadOperatorRoleCodesMock = vi.hoisted(() => vi.fn());
const enforceOperatorMfaMock = vi.hoisted(() => vi.fn());
const executeCommandDetailedMock = vi.hoisted(() => vi.fn());
const GENERATED = vi.hoisted(() => ({
  token: `pxk_${"t".repeat(43)}`,
  tokenHash: "ab".repeat(32),
  tokenPrefix: "pxk_tttt",
}));

vi.mock("@pharmax/command-bus", () => ({
  executeCommandDetailed: executeCommandDetailedMock,
}));

vi.mock("@pharmax/partner-api", () => ({
  CreateApiKey: { name: "CreateApiKey" },
  generateApiKeyToken: () => GENERATED,
}));

vi.mock("@pharmax/tenancy", () => ({
  buildTenancyContext: (input: unknown) => input,
  withTenancyContext: (_ctx: unknown, fn: () => Promise<unknown>) => fn(),
}));

vi.mock("@/server/auth/resolve-tenancy", () => ({
  resolveOperatorTenancyContext: resolveOperatorTenancyContextMock,
}));

vi.mock("@/server/auth/load-operator-role-codes", () => ({
  loadOperatorRoleCodes: loadOperatorRoleCodesMock,
}));

vi.mock("@/server/auth/require-mfa", () => ({
  enforceOperatorMfa: enforceOperatorMfaMock,
  MFA_REQUIRED: "MFA_REQUIRED",
}));

vi.mock("@/server/observability/ops-scope", () => ({
  withSentryOpsScope: (_scope: unknown, fn: () => Promise<unknown>) => fn(),
}));

vi.mock("@/server/logger", () => {
  const noop = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
  noop.child.mockReturnValue(noop);
  return { logger: noop };
});

import { errors } from "@pharmax/platform-core";

import { POST } from "./route.js";

const SESSION = {
  ok: true,
  tenancy: {
    organizationId: "org-1",
    actor: { userId: "user-op" },
  },
  operator: { userId: "user-op", displayName: "Op Erator", mfaSatisfied: true },
};

function request(input: {
  readonly idempotencyKey?: string;
  readonly body?: unknown;
  readonly rawBody?: string;
}): Request {
  const headers: Record<string, string> = {};
  if (input.idempotencyKey !== undefined) headers["idempotency-key"] = input.idempotencyKey;
  return new Request("http://localhost/api/ops/admin/api-keys/create", {
    method: "POST",
    headers,
    body: input.rawBody ?? JSON.stringify(input.body ?? {}),
  });
}

const VALID_BODY = { name: "Acme telehealth prod", scopes: ["orders.read"] };

const COMMAND_OUTPUT = {
  apiKeyId: "ak-1",
  name: VALID_BODY.name,
  tokenPrefix: GENERATED.tokenPrefix,
  scopes: VALID_BODY.scopes,
};

beforeEach(() => {
  resolveOperatorTenancyContextMock.mockReset().mockResolvedValue(SESSION);
  loadOperatorRoleCodesMock.mockReset().mockResolvedValue(["OrgAdmin"]);
  enforceOperatorMfaMock.mockReset();
  executeCommandDetailedMock.mockReset();
});

describe("POST /api/ops/admin/api-keys/create", () => {
  it("401s without an operator session", async () => {
    resolveOperatorTenancyContextMock.mockResolvedValue({ ok: false });
    const res = await POST(request({ idempotencyKey: "mint-attempt-1", body: VALID_BODY }));
    expect(res.status).toBe(401);
  });

  it("403s when the MFA floor is not met, before any command dispatch", async () => {
    enforceOperatorMfaMock.mockImplementation(() => {
      throw new errors.AuthorizationError({ code: "MFA_REQUIRED", message: "MFA required." });
    });
    const res = await POST(request({ idempotencyKey: "mint-attempt-1", body: VALID_BODY }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("MFA_REQUIRED");
    expect(executeCommandDetailedMock).not.toHaveBeenCalled();
  });

  it("400s without an Idempotency-Key header — server-generated retry boundaries are forbidden", async () => {
    const res = await POST(request({ body: VALID_BODY }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(executeCommandDetailedMock).not.toHaveBeenCalled();
  });

  it("400s invalid JSON, a missing name, and empty scopes", async () => {
    const badJson = await POST(request({ idempotencyKey: "mint-attempt-1", rawBody: "}{" }));
    expect(badJson.status).toBe(400);

    const noName = await POST(
      request({ idempotencyKey: "mint-attempt-1", body: { name: "  ", scopes: ["orders.read"] } })
    );
    expect(noName.status).toBe(400);
    expect((await noName.json()).error.code).toBe("NAME_REQUIRED");

    const noScopes = await POST(
      request({ idempotencyKey: "mint-attempt-1", body: { name: "x", scopes: [] } })
    );
    expect(noScopes.status).toBe(400);
    expect((await noScopes.json()).error.code).toBe("SCOPES_REQUIRED");
  });

  it("201s a FIRST mint: token shown once, idempotency key = operator + header (NOT the token hash)", async () => {
    executeCommandDetailedMock.mockResolvedValue({ output: COMMAND_OUTPUT, replayed: false });

    const res = await POST(request({ idempotencyKey: "mint-attempt-1", body: VALID_BODY }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.apiKeyId).toBe("ak-1");
    expect(body.data.token).toBe(GENERATED.token);

    const [, input, options] = executeCommandDetailedMock.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
      { idempotencyKey: string },
    ];
    // Only the hash + prefix cross the bus, never the raw token.
    expect(input["tokenHash"]).toBe(GENERATED.tokenHash);
    expect(JSON.stringify(input)).not.toContain(GENERATED.token);
    // Regression: a key derived from the per-attempt token hash
    // means every client retry mints a second live key.
    expect(options.idempotencyKey).toBe("route:create-api-key:user-op:mint-attempt-1");
    expect(options.idempotencyKey).not.toContain(GENERATED.tokenHash);
  });

  it("REPLAY returns the stored key's metadata with token: null — no second key, no fresh token", async () => {
    executeCommandDetailedMock.mockResolvedValue({ output: COMMAND_OUTPUT, replayed: true });

    const res = await POST(request({ idempotencyKey: "mint-attempt-1", body: VALID_BODY }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.apiKeyId).toBe("ak-1");
    expect(body.data.token).toBeNull();
    expect(body.meta).toEqual({ idempotentReplay: true });
    // The fresh token generated on the retried attempt was never
    // stored; leaking it would hand the operator a dead credential.
    expect(JSON.stringify(body)).not.toContain(GENERATED.token);
  });

  it("422s a command error with its code", async () => {
    executeCommandDetailedMock.mockRejectedValue(
      new errors.ValidationError({
        code: "CREATE_API_KEY_UNKNOWN_SCOPE",
        message: "Unrecognized scope code(s): bogus.",
      })
    );
    const res = await POST(
      request({ idempotencyKey: "mint-attempt-1", body: { name: "x", scopes: ["bogus"] } })
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("CREATE_API_KEY_UNKNOWN_SCOPE");
  });
});
