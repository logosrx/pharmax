// Session engine state-machine tests (DB-free, fake tx + frozen clock).
//
// Pins the security-critical resolution logic: a valid session slides,
// a revoked session is rejected, and idle / absolute expiry auto-revoke
// and reject. The DB-backed proof (RLS + a real next-request rejection)
// lives in packages/integration-tests.

import { clock } from "@pharmax/platform-core";
import { describe, expect, it, vi } from "vitest";

import { buildAuthConfiguration, type AuthConfiguration } from "../configure.js";
import type { PasswordHasher } from "../password/hasher.js";
import {
  createSessionInTx,
  resolveSession,
  SESSION_ABSOLUTE_EXPIRED,
  SESSION_IDLE_EXPIRED,
  SESSION_NOT_FOUND,
  SESSION_REVOKED,
} from "./service.js";
import { hashSessionToken } from "./token.js";

const NOW = new Date("2026-07-13T12:00:00.000Z");
const ORG_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-0000000000a1";

const fakeHasher: PasswordHasher = {
  async hash(p) {
    return `h:${p}`;
  },
  async verify(h, p) {
    return h === `h:${p}`;
  },
  needsRehash() {
    return false;
  },
};

function config(now: Date = NOW): AuthConfiguration {
  return buildAuthConfiguration({ clock: clock.createFrozenClock(now), hasher: fakeHasher });
}

type SessionRow = {
  id: string;
  userId: string;
  organizationId: string;
  mfaSatisfied: boolean;
  lastActivityAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
};

function fakeClient(row: SessionRow | null) {
  const tx = {
    $executeRaw: vi.fn(async () => 0),
    authSession: {
      findUnique: vi.fn(async (_args: unknown) => row),
      // Declare an args param so `mock.calls[n][0]` is typed as the
      // captured argument (not an out-of-range empty-tuple index).
      update: vi.fn(async (_args: unknown) => ({})),
      create: vi.fn(async (_args: unknown) => ({ id: "session-created" })),
    },
  };
  const client = { $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)) };
  return { client, tx };
}

describe("createSessionInTx", () => {
  it("derives idle + absolute expiry from policy and stores only the token hash", async () => {
    const { tx } = fakeClient(null);
    const cfg = config();
    const result = await createSessionInTx({
      tx: tx as never,
      userId: USER_ID,
      organizationId: ORG_ID,
      mfaSatisfied: true,
      config: cfg,
    });

    expect(result.rawToken).toEqual(expect.any(String));
    expect(result.idleExpiresAt.getTime()).toBe(NOW.getTime() + cfg.session.idleTtlMs);
    expect(result.absoluteExpiresAt.getTime()).toBe(NOW.getTime() + cfg.session.absoluteTtlMs);

    const createArg = tx.authSession.create.mock.calls[0]![0] as { data: Record<string, unknown> };
    // Only the hash is persisted — never the raw token.
    expect(createArg.data["tokenHash"]).toBe(hashSessionToken(result.rawToken));
    expect(Object.values(createArg.data)).not.toContain(result.rawToken);
  });
});

describe("resolveSession", () => {
  function row(overrides: Partial<SessionRow> = {}): SessionRow {
    return {
      id: "session-1",
      userId: USER_ID,
      organizationId: ORG_ID,
      mfaSatisfied: true,
      lastActivityAt: NOW,
      idleExpiresAt: new Date(NOW.getTime() + 60_000),
      absoluteExpiresAt: new Date(NOW.getTime() + 3_600_000),
      revokedAt: null,
      ...overrides,
    };
  }

  it("resolves a valid session", async () => {
    const { client } = fakeClient(row());
    const result = await resolveSession({
      rawToken: "tok",
      client: client as never,
      config: config(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.session.userId).toBe(USER_ID);
      expect(result.session.organizationId).toBe(ORG_ID);
      expect(result.session.mfaSatisfied).toBe(true);
    }
  });

  it("rejects an unknown token", async () => {
    const { client } = fakeClient(null);
    const result = await resolveSession({
      rawToken: "tok",
      client: client as never,
      config: config(),
    });
    expect(result).toMatchObject({ ok: false, reason: SESSION_NOT_FOUND });
  });

  it("rejects an already-revoked session without re-revoking", async () => {
    const { client, tx } = fakeClient(row({ revokedAt: new Date(NOW.getTime() - 1000) }));
    const result = await resolveSession({
      rawToken: "tok",
      client: client as never,
      config: config(),
    });
    expect(result).toMatchObject({ ok: false, reason: SESSION_REVOKED });
    expect(tx.authSession.update).not.toHaveBeenCalled();
  });

  it("auto-revokes and rejects an idle-expired session", async () => {
    const { client, tx } = fakeClient(row({ idleExpiresAt: new Date(NOW.getTime() - 1) }));
    const result = await resolveSession({
      rawToken: "tok",
      client: client as never,
      config: config(),
    });
    expect(result).toMatchObject({ ok: false, reason: SESSION_IDLE_EXPIRED });
    const updateArg = tx.authSession.update.mock.calls[0]![0] as {
      data: { revokedReason: string };
    };
    expect(updateArg.data.revokedReason).toBe("IDLE_TIMEOUT");
  });

  it("auto-revokes and rejects an absolute-expired session (even if not idle)", async () => {
    const { client, tx } = fakeClient(
      row({
        idleExpiresAt: new Date(NOW.getTime() + 60_000),
        absoluteExpiresAt: new Date(NOW.getTime() - 1),
      })
    );
    const result = await resolveSession({
      rawToken: "tok",
      client: client as never,
      config: config(),
    });
    expect(result).toMatchObject({ ok: false, reason: SESSION_ABSOLUTE_EXPIRED });
    const updateArg = tx.authSession.update.mock.calls[0]![0] as {
      data: { revokedReason: string };
    };
    expect(updateArg.data.revokedReason).toBe("ABSOLUTE_TIMEOUT");
  });
});
