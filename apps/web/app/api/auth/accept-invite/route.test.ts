// Contract tests for POST /api/auth/accept-invite.
//
// The burst limit itself lives in @pharmax/auth (one bucket shared with
// the reset path, keyed on the client IP) and is tested there. What only
// this layer can get wrong is the two halves of the seam:
//
//   1. handing the engine a real client IP — without it every caller in
//      the world collapses into the single `unknown` bucket and the
//      limit stops isolating anyone;
//   2. answering a limited request with the ordinary opaque refusal. A
//      429 branch added here would be a token-existence oracle: probe
//      until limited, then submit the candidate and read which shape
//      comes back.

import { beforeEach, describe, expect, it, vi } from "vitest";

const acceptInviteMock = vi.hoisted(() => vi.fn());

vi.mock("@pharmax/auth", () => ({
  acceptInvite: acceptInviteMock,
}));

import type { NextRequest } from "next/server";

import { errors } from "@pharmax/platform-core";

import { POST } from "./route.js";

// Synthetic invite material — no real operator, no PHI.
const TOKEN = "synthetic-invite-setup-token";
const PASSWORD = "first-secret-phrase-6";

function request(headers: Record<string, string> = {}): NextRequest {
  return new Request("http://localhost/api/auth/accept-invite", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ token: TOKEN, password: PASSWORD }),
  }) as unknown as NextRequest;
}

/** The single opaque refusal every failure on this path shares. */
function tokenInvalid(): errors.AuthenticationError {
  return new errors.AuthenticationError({
    code: "RESET_TOKEN_INVALID",
    message: "This password reset link is invalid or has expired.",
  });
}

async function shapeOf(response: Response): Promise<string> {
  const headers = [...response.headers.entries()].sort().map(([k, v]) => `${k}: ${v}`);
  return JSON.stringify({
    status: response.status,
    headers,
    body: (await response.json()) as unknown,
  });
}

beforeEach(() => {
  acceptInviteMock.mockReset().mockResolvedValue({ userId: "user-1" });
});

describe("POST /api/auth/accept-invite — rate-limit seam", () => {
  it("hands the engine the client-most forwarded address", async () => {
    await POST(request({ "x-forwarded-for": "198.51.100.7, 10.0.0.4" }));

    expect(acceptInviteMock).toHaveBeenCalledWith({
      rawToken: TOKEN,
      newPassword: PASSWORD,
      ipAddress: "198.51.100.7",
    });
  });

  it("omits the address when the header is absent rather than sending an empty one", async () => {
    await POST(request());

    // `undefined` lets the engine apply its own `unknown` bucket; an
    // empty string would be a second, silently different bucket.
    expect(acceptInviteMock).toHaveBeenCalledWith({
      rawToken: TOKEN,
      newPassword: PASSWORD,
      ipAddress: undefined,
    });
  });

  it("answers a limited request identically to an unknown token", async () => {
    // Both cases reach this route as the same thrown error, because the
    // limiter refuses with the same factory the command does. The
    // assertion is that the route adds no branch of its own — no 429, no
    // retry-after, no extra field.
    acceptInviteMock.mockRejectedValueOnce(tokenInvalid());
    const limited = await shapeOf(await POST(request({ "x-forwarded-for": "198.51.100.7" })));

    acceptInviteMock.mockRejectedValueOnce(tokenInvalid());
    const unknownToken = await shapeOf(await POST(request({ "x-forwarded-for": "203.0.113.9" })));

    expect(limited).toBe(unknownToken);
    expect(limited).toContain('"status":401');
    expect(limited).toContain("RESET_TOKEN_INVALID");
    expect(limited).not.toContain("retry-after");
  });

  it("does not spend limiter budget on a request that never reaches the engine", async () => {
    const res = await POST(
      new Request("http://localhost/api/auth/accept-invite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "" }),
      }) as unknown as NextRequest
    );

    // A malformed body costs no corpus lookup, so it should cost no
    // budget either — otherwise garbage traffic evicts real operators
    // from a shared NAT address for free.
    expect(res.status).toBe(400);
    expect(acceptInviteMock).not.toHaveBeenCalled();
  });
});
