// resolveOperatorTenancyContext contract tests (coverage-audit
// 2026-08, backfill item 2). This is the session → TenancyContext
// bridge (ADR-0030) — the single tenant-isolation entry point for
// the operator console, and a cross-tenant-isolation risk if any
// path yields a context broader than the session's actual grants.
//
// Test double strategy: the REAL `resolveSession` (@pharmax/auth),
// REAL `cached()` read-through, and REAL `buildTenancyContext`
// (@pharmax/tenancy) run against a fake Prisma `$transaction`
// client, so session-state handling (absent / malformed / revoked /
// idle-expired / absolute-expired / valid) is exercised through the
// production code path rather than a mocked-out resolver. Only the
// process-singleton edges are mocked (logger, server cache
// singleton, cookie reader, Prisma singleton).
//
// THE invariant, asserted exactly: a successful resolution yields a
// TenancyContext with the SESSION's organizationId and the actor —
// and nothing else. No siteId / clinicId / teamId / bucketId /
// workstationId ever appears (this bridge grants org scope only),
// and a divergent user-row organizationId can never widen or move
// the tenancy.
//
// CLEAN ROOM / PHI: synthetic operator identities only.

import { clock } from "@pharmax/platform-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loggerMock = vi.hoisted(() => {
  const noop = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
  noop.child.mockReturnValue(noop);
  return noop;
});
const readCookieMock = vi.hoisted(() => vi.fn());

vi.mock("../logger.js", () => ({ logger: loggerMock }));

// The tests always inject a cache; reaching the process singleton
// would mean the injectable seam regressed.
vi.mock("../cache.js", () => ({
  getServerCache: () => {
    throw new Error("getServerCache must not be reached — tests inject options.cache");
  },
}));

vi.mock("./session-cookie.js", () => ({
  readSessionTokenFromCookies: readCookieMock,
}));

// Partial mock: keep the real module surface (UserStatus and the
// enums transitive imports like @pharmax/rbac need), but replace the
// Prisma singleton — the client is always injected in these tests.
vi.mock("@pharmax/database", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, prisma: {} };
});

import {
  buildAuthConfiguration,
  configureAuth,
  resetAuthConfigurationForTests,
  type PasswordHasher,
} from "@pharmax/auth";
import type { Cache, CacheSetOptions } from "@pharmax/composition";

import {
  resolveOperatorTenancyContext,
  RESOLVE_TENANCY_NO_SESSION,
  RESOLVE_TENANCY_USER_NOT_ACTIVE,
  RESOLVE_TENANCY_USER_NOT_LINKED,
} from "./resolve-tenancy.js";

type ResolveOptions = NonNullable<Parameters<typeof resolveOperatorTenancyContext>[0]>;

const NOW = new Date("2026-06-01T12:00:00.000Z");
const ORG_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ORG_ID = "00000000-0000-4000-8000-000000000002";
const USER_ID = "00000000-0000-4000-8000-0000000000a1";
const SESSION_ID = "00000000-0000-4000-8000-0000000000e1";
const RAW_TOKEN = "synthetic-opaque-session-token";

const STUB_HASHER: PasswordHasher = {
  hash: async () => "$argon2id$stub",
  verify: async () => false,
  needsRehash: () => false,
};

interface FakeSessionRow {
  readonly id: string;
  readonly userId: string;
  readonly organizationId: string;
  readonly mfaSatisfied: boolean;
  readonly lastActivityAt: Date;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly revokedAt: Date | null;
}

interface FakeUserRow {
  readonly id: string;
  readonly organizationId: string;
  readonly email: string;
  readonly displayName: string;
  readonly status: string;
}

function validSessionRow(overrides: Partial<FakeSessionRow> = {}): FakeSessionRow {
  return {
    id: SESSION_ID,
    userId: USER_ID,
    organizationId: ORG_ID,
    mfaSatisfied: true,
    lastActivityAt: NOW,
    idleExpiresAt: new Date(NOW.getTime() + 30 * 60_000),
    absoluteExpiresAt: new Date(NOW.getTime() + 12 * 3_600_000),
    revokedAt: null,
    ...overrides,
  };
}

function activeUserRow(overrides: Partial<FakeUserRow> = {}): FakeUserRow {
  return {
    id: USER_ID,
    organizationId: ORG_ID,
    email: "operator@example.test",
    displayName: "Synthetic Operator",
    status: "ACTIVE",
    ...overrides,
  };
}

/**
 * Fake of the `$transaction`-capable client both `resolveSession`
 * and the user-projection lookup run against. Rows are held in
 * mutable boxes so a test can change what the "DB" returns between
 * calls (user deleted after session issued, etc.).
 */
function buildFakeClient(input: {
  sessionRow: FakeSessionRow | null;
  userRow: FakeUserRow | null;
}) {
  const state = { sessionRow: input.sessionRow, userRow: input.userRow };
  const gucCalls: string[][] = [];
  const authSessionUpdate = vi.fn(async () => ({}));
  const authSessionFindUnique = vi.fn(async () => state.sessionRow);
  const userFindUnique = vi.fn(async () => state.userRow);

  const tx = {
    $executeRaw: vi.fn(
      async (_template: TemplateStringsArray, ...values: ReadonlyArray<unknown>) => {
        gucCalls.push(values.map(String));
        return 0;
      }
    ),
    authSession: { findUnique: authSessionFindUnique, update: authSessionUpdate },
    user: { findUnique: userFindUnique },
  };

  const client = {
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    user: tx.user,
  };

  return { client, state, gucCalls, authSessionFindUnique, authSessionUpdate, userFindUnique };
}

/** Minimal in-memory Cache implementing the composition port. */
class FakeCache implements Cache {
  private readonly store = new Map<string, unknown>();
  public async get<T>(key: string): Promise<T | null> {
    return (this.store.get(key) as T | undefined) ?? null;
  }
  public async set<T>(key: string, value: T, _options: CacheSetOptions): Promise<void> {
    this.store.set(key, value);
  }
  public async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  public async deletePrefix(prefix: string): Promise<void> {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }
}

function optionsFor(
  fake: ReturnType<typeof buildFakeClient>,
  extra: Partial<ResolveOptions> = {}
): ResolveOptions {
  return {
    rawToken: RAW_TOKEN,
    client: fake.client as unknown as ResolveOptions["client"],
    cache: new FakeCache(),
    ...extra,
  };
}

beforeEach(() => {
  readCookieMock.mockReset();
  loggerMock.warn.mockReset();
  configureAuth(
    buildAuthConfiguration({
      clock: clock.createFrozenClock(NOW),
      hasher: STUB_HASHER,
    })
  );
});

afterEach(() => {
  resetAuthConfigurationForTests();
});

describe("resolveOperatorTenancyContext — session states", () => {
  it("no cookie → NO_SESSION, and the user projection is never looked up", async () => {
    readCookieMock.mockResolvedValue(null);
    const fake = buildFakeClient({ sessionRow: null, userRow: activeUserRow() });

    const result = await resolveOperatorTenancyContext(optionsFor(fake, { rawToken: undefined }));

    expect(result).toEqual({ ok: false, reason: RESOLVE_TENANCY_NO_SESSION });
    expect(fake.userFindUnique).not.toHaveBeenCalled();
    expect(fake.authSessionFindUnique).not.toHaveBeenCalled();
  });

  it("empty token → NO_SESSION without touching the session store", async () => {
    const fake = buildFakeClient({ sessionRow: validSessionRow(), userRow: activeUserRow() });

    const result = await resolveOperatorTenancyContext(optionsFor(fake, { rawToken: "" }));

    expect(result).toEqual({ ok: false, reason: RESOLVE_TENANCY_NO_SESSION });
    expect(fake.authSessionFindUnique).not.toHaveBeenCalled();
  });

  it("malformed/unknown token (no matching session row) → NO_SESSION", async () => {
    const fake = buildFakeClient({ sessionRow: null, userRow: activeUserRow() });

    const result = await resolveOperatorTenancyContext(
      optionsFor(fake, { rawToken: "%%% not a real token %%%" })
    );

    expect(result).toEqual({ ok: false, reason: RESOLVE_TENANCY_NO_SESSION });
    expect(fake.userFindUnique).not.toHaveBeenCalled();
  });

  it("revoked session → NO_SESSION, no identity lookup", async () => {
    const fake = buildFakeClient({
      sessionRow: validSessionRow({ revokedAt: new Date(NOW.getTime() - 60_000) }),
      userRow: activeUserRow(),
    });

    const result = await resolveOperatorTenancyContext(optionsFor(fake));

    expect(result).toEqual({ ok: false, reason: RESOLVE_TENANCY_NO_SESSION });
    expect(fake.userFindUnique).not.toHaveBeenCalled();
  });

  it("idle-expired session → NO_SESSION and the row is auto-revoked with IDLE_TIMEOUT", async () => {
    const fake = buildFakeClient({
      sessionRow: validSessionRow({ idleExpiresAt: new Date(NOW.getTime() - 1) }),
      userRow: activeUserRow(),
    });

    const result = await resolveOperatorTenancyContext(optionsFor(fake));

    expect(result).toEqual({ ok: false, reason: RESOLVE_TENANCY_NO_SESSION });
    expect(fake.authSessionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ revokedReason: "IDLE_TIMEOUT" }),
      })
    );
    expect(fake.userFindUnique).not.toHaveBeenCalled();
  });

  it("absolute-expired session → NO_SESSION and the row is auto-revoked with ABSOLUTE_TIMEOUT", async () => {
    const fake = buildFakeClient({
      sessionRow: validSessionRow({ absoluteExpiresAt: new Date(NOW.getTime() - 1) }),
      userRow: activeUserRow(),
    });

    const result = await resolveOperatorTenancyContext(optionsFor(fake));

    expect(result).toEqual({ ok: false, reason: RESOLVE_TENANCY_NO_SESSION });
    expect(fake.authSessionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ revokedReason: "ABSOLUTE_TIMEOUT" }),
      })
    );
  });

  it("valid session read from the cookie resolves end-to-end", async () => {
    readCookieMock.mockResolvedValue(RAW_TOKEN);
    const fake = buildFakeClient({ sessionRow: validSessionRow(), userRow: activeUserRow() });

    const result = await resolveOperatorTenancyContext(optionsFor(fake, { rawToken: undefined }));

    expect(result.ok).toBe(true);
  });
});

describe("resolveOperatorTenancyContext — membership shapes (user projection gate)", () => {
  it("valid session but no linked user row (never provisioned / no org membership) → USER_NOT_LINKED", async () => {
    const fake = buildFakeClient({ sessionRow: validSessionRow(), userRow: null });

    const result = await resolveOperatorTenancyContext(optionsFor(fake));

    expect(result).toEqual({ ok: false, reason: RESOLVE_TENANCY_USER_NOT_LINKED });
  });

  it("user deleted AFTER the session was issued → USER_NOT_LINKED, and the miss is never negatively cached", async () => {
    const fake = buildFakeClient({ sessionRow: validSessionRow(), userRow: null });
    const cache = new FakeCache();

    const first = await resolveOperatorTenancyContext(optionsFor(fake, { cache }));
    expect(first).toEqual({ ok: false, reason: RESOLVE_TENANCY_USER_NOT_LINKED });

    // The operator gets re-provisioned; the very next request must see
    // them (a cached negative here would lock a valid operator out).
    fake.state.userRow = activeUserRow();
    const second = await resolveOperatorTenancyContext(optionsFor(fake, { cache }));

    expect(second.ok).toBe(true);
    expect(fake.userFindUnique).toHaveBeenCalledTimes(2);
  });

  it.each([["INVITED"], ["SUSPENDED"], ["TERMINATED"]])(
    "disabled membership — %s user → USER_NOT_ACTIVE, no tenancy context escapes",
    async (status) => {
      const fake = buildFakeClient({
        sessionRow: validSessionRow(),
        userRow: activeUserRow({ status }),
      });

      const result = await resolveOperatorTenancyContext(optionsFor(fake));

      expect(result).toEqual({ ok: false, reason: RESOLVE_TENANCY_USER_NOT_ACTIVE });
      expect("tenancy" in result).toBe(false);
    }
  );
});

describe("resolveOperatorTenancyContext — THE isolation invariant", () => {
  it("a successful resolution grants EXACTLY the session's org scope: no site/clinic/team/bucket/workstation ever appears", async () => {
    const fake = buildFakeClient({ sessionRow: validSessionRow(), userRow: activeUserRow() });

    const result = await resolveOperatorTenancyContext(optionsFor(fake));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Exact shape: organizationId + actor and NOTHING else. A new
    // scope field leaking in here (site pin, clinic grant) must fail
    // this test and get an explicit decision.
    expect(Object.keys(result.tenancy).sort()).toEqual(["actor", "organizationId"]);
    expect(result.tenancy.organizationId).toBe(ORG_ID);
    expect(result.tenancy.siteId).toBeUndefined();
    expect(result.tenancy.clinicId).toBeUndefined();
    expect(result.tenancy.teamId).toBeUndefined();
    expect(result.tenancy.bucketId).toBeUndefined();
    expect(result.tenancy.workstationId).toBeUndefined();
    expect(result.tenancy.actor.userId).toBe(USER_ID);
    expect(Object.isFrozen(result.tenancy)).toBe(true);
    expect(Object.isFrozen(result.tenancy.actor)).toBe(true);
  });

  it("the tenancy is pinned to the SESSION's organizationId even when the cached user row claims another org", async () => {
    // A stale/poisoned identity-cache row must not be able to move an
    // operator into a different tenant — the session row is the grant.
    const fake = buildFakeClient({
      sessionRow: validSessionRow(),
      userRow: activeUserRow({ organizationId: OTHER_ORG_ID }),
    });

    const result = await resolveOperatorTenancyContext(optionsFor(fake));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tenancy.organizationId).toBe(ORG_ID);
    expect(result.operator.organizationId).toBe(ORG_ID);
    expect(JSON.stringify(result.tenancy)).not.toContain(OTHER_ORG_ID);
  });

  it("projects the operator identity from the session + user row (mfa and session id pass through)", async () => {
    const fake = buildFakeClient({
      sessionRow: validSessionRow({ mfaSatisfied: false }),
      userRow: activeUserRow(),
    });

    const result = await resolveOperatorTenancyContext(optionsFor(fake));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.operator).toEqual({
      userId: USER_ID,
      organizationId: ORG_ID,
      email: "operator@example.test",
      displayName: "Synthetic Operator",
      mfaSatisfied: false,
      sessionId: SESSION_ID,
    });
  });

  it("each resolution gets a FRESH correlationId (no cross-request reuse through the identity cache)", async () => {
    const fake = buildFakeClient({ sessionRow: validSessionRow(), userRow: activeUserRow() });
    const cache = new FakeCache();

    const first = await resolveOperatorTenancyContext(optionsFor(fake, { cache }));
    const second = await resolveOperatorTenancyContext(optionsFor(fake, { cache }));

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.tenancy.actor.correlationId).not.toBe(second.tenancy.actor.correlationId);
    expect(first.tenancy.actor.correlationId).toHaveLength(26);
  });
});

describe("resolveOperatorTenancyContext — identity cache and system-context hygiene", () => {
  it("the user projection is served read-through: one DB lookup across repeated requests", async () => {
    const fake = buildFakeClient({ sessionRow: validSessionRow(), userRow: activeUserRow() });
    const cache = new FakeCache();

    await resolveOperatorTenancyContext(optionsFor(fake, { cache }));
    await resolveOperatorTenancyContext(optionsFor(fake, { cache }));

    expect(fake.userFindUnique).toHaveBeenCalledTimes(1);
  });

  it("a broken cache transport degrades to the DB loader (and reports it) instead of failing the request", async () => {
    const fake = buildFakeClient({ sessionRow: validSessionRow(), userRow: activeUserRow() });
    const brokenCache: Cache = {
      get: async () => {
        throw new Error("redis down");
      },
      set: async () => {
        throw new Error("redis down");
      },
      delete: async () => {},
      deletePrefix: async () => {},
    };

    const result = await resolveOperatorTenancyContext(optionsFor(fake, { cache: brokenCache }));

    expect(result.ok).toBe(true);
    expect(fake.userFindUnique).toHaveBeenCalledTimes(1);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      "auth.operator_identity_cache.error",
      expect.objectContaining({ stage: expect.any(String) })
    );
  });

  it("the zero-options production entry point (request-memoized path) still resolves", async () => {
    // No injected client/cache/token → the react-cache()-memoized
    // path runs. The mocked cookie reader returns no token, so the
    // request resolves to NO_SESSION before any singleton is touched.
    readCookieMock.mockResolvedValue(null);

    const result = await resolveOperatorTenancyContext();

    expect(result).toEqual({ ok: false, reason: RESOLVE_TENANCY_NO_SESSION });
  });

  it("the tenant-less user lookup runs under the system-context GUC with the audit reason recorded", async () => {
    const fake = buildFakeClient({ sessionRow: validSessionRow(), userRow: activeUserRow() });

    await resolveOperatorTenancyContext(optionsFor(fake));

    // Both system transactions (session resolve, user lookup) must
    // have applied the GUC; the user lookup carries this bridge's
    // dedicated reason string for the audit trail.
    const flattened = fake.gucCalls.map((values) => values.join("|"));
    expect(flattened.some((v) => v.includes("apps/web:resolve-operator-tenancy"))).toBe(true);
    expect(flattened.some((v) => v.includes("auth:resolve-session"))).toBe(true);
  });
});
