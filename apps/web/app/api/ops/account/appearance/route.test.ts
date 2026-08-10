// Contract tests for POST /api/ops/account/appearance.
//
// Pins: the idempotency key is the caller's retry boundary namespaced
// per operator, the cookie value on the response matches what was
// saved (the render hint may never disagree with the account), and the
// route maps the lowercase wire value to the Prisma enum.

import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveOperatorTenancyContextMock = vi.hoisted(() => vi.fn());
const executeCommandMock = vi.hoisted(() => vi.fn());

vi.mock("@pharmax/command-bus", () => ({
  executeCommand: executeCommandMock,
}));

vi.mock("@pharmax/auth", () => ({
  SetThemePreference: { name: "SetThemePreference" },
}));

vi.mock("@pharmax/tenancy", () => ({
  buildTenancyContext: (input: unknown) => input,
  withTenancyContext: (_ctx: unknown, fn: () => Promise<unknown>) => fn(),
}));

vi.mock("@/server/auth/resolve-tenancy", () => ({
  resolveOperatorTenancyContext: resolveOperatorTenancyContextMock,
}));

import { POST } from "./route.js";

const SESSION = {
  ok: true,
  tenancy: {
    organizationId: "org-1",
    actor: { userId: "user-op" },
  },
};

function request(input: { readonly idempotencyKey?: string; readonly body?: unknown }): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (input.idempotencyKey !== undefined) headers["idempotency-key"] = input.idempotencyKey;
  return new Request("http://localhost/api/ops/account/appearance", {
    method: "POST",
    headers,
    body: JSON.stringify(input.body ?? {}),
  });
}

beforeEach(() => {
  resolveOperatorTenancyContextMock.mockReset().mockResolvedValue(SESSION);
  executeCommandMock.mockReset().mockResolvedValue({ theme: "LIGHT" });
});

describe("POST /api/ops/account/appearance", () => {
  it("401s without an operator session", async () => {
    resolveOperatorTenancyContextMock.mockResolvedValue({ ok: false });
    const res = await POST(request({ idempotencyKey: "t-1", body: { theme: "light" } }));
    expect(res.status).toBe(401);
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it("400s without an Idempotency-Key header", async () => {
    const res = await POST(request({ body: { theme: "light" } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it("400s a theme outside dark|light|system", async () => {
    const res = await POST(request({ idempotencyKey: "t-1", body: { theme: "BLUE" } }));
    expect(res.status).toBe(400);
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it("saves the preference and refreshes the render-hint cookie to match", async () => {
    const res = await POST(request({ idempotencyKey: "t-1", body: { theme: "light" } }));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);

    // Wire value maps to the Prisma enum; key is operator-namespaced.
    const [, input, options] = executeCommandMock.mock.calls[0] as [
      unknown,
      { theme: string },
      { idempotencyKey: string },
    ];
    expect(input.theme).toBe("LIGHT");
    expect(options.idempotencyKey).toBe("route:set-theme:user-op:t-1");

    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("pharmax_theme=light");
    expect(setCookie).toContain("Path=/");
    // Render hint only — must stay readable by the client toggle.
    expect(setCookie.toLowerCase()).not.toContain("httponly");
  });

  it("passes 'system' through unchanged", async () => {
    executeCommandMock.mockResolvedValue({ theme: "SYSTEM" });
    const res = await POST(request({ idempotencyKey: "t-2", body: { theme: "system" } }));
    expect(res.status).toBe(200);

    const [, input] = executeCommandMock.mock.calls[0] as [unknown, { theme: string }];
    expect(input.theme).toBe("SYSTEM");
    expect(res.headers.get("set-cookie") ?? "").toContain("pharmax_theme=system");
  });
});
