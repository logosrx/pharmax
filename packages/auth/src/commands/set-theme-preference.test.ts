// SetThemePreference contract tests — the self-service appearance
// setting. Pins: the command only ever writes the ACTOR's own user row
// (no cross-user targeting surface exists in the input), needs no RBAC
// permission, and lands an audit entry like every account mutation.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { RoleScope, UserThemePreference } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";
import {
  configureRbac,
  InMemoryPermissionLoader,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";

import { SetThemePreference } from "./set-theme-preference.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const ACTOR_ID = "00000000-0000-4000-8000-0000000000ac";

// Deliberately NO permissions — the command is self-service.
const emptyGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set(),
  },
];

function ctx() {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: ACTOR_ID, correlationId: "01CORRELATION0000000000000" },
  });
}

function buildFake() {
  const tx = {
    user: {
      update: vi.fn(async () => ({})),
    },
    commandLog: {
      create: vi.fn(async () => ({ id: "cl-1" })),
      update: vi.fn(async () => ({ ok: true })),
      findUnique: vi.fn(async () => null),
    },
    auditLog: { create: vi.fn(async () => ({ id: "al-1" })) },
    auditChainState: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({
        organizationId: ORG_ID,
        latestHash: Buffer.alloc(32),
        latestSeq: 1n,
      })),
    },
    eventOutbox: { createMany: vi.fn(async () => ({ count: 0 })) },
    idempotencyKey: { create: vi.fn(async () => ({})), findUnique: vi.fn(async () => null) },
    $executeRaw: vi.fn(async () => 0),
  };
  const client = {
    commandLog: { create: vi.fn(async () => ({ id: "cl-pre" })), update: vi.fn(async () => ({})) },
    idempotencyKey: { findUnique: vi.fn(async () => null) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return { client, tx };
}

function configureBus(client: unknown): void {
  configureCommandBus({
    prisma: client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(new Date("2026-08-09T12:00:00.000Z")),
    logger: logger.noopLogger,
  });
}

beforeEach(() => {
  configureRbac({
    loader: new InMemoryPermissionLoader([
      { organizationId: ORG_ID, userId: ACTOR_ID, grants: emptyGrants },
    ]),
  });
});
afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
});

describe("SetThemePreference", () => {
  it("saves the actor's own theme (no permission required) and audits it", async () => {
    const fake = buildFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        SetThemePreference,
        { theme: UserThemePreference.LIGHT },
        { idempotencyKey: "theme-1" }
      )
    );

    expect(out.theme).toBe(UserThemePreference.LIGHT);

    expect(fake.tx.user.update).toHaveBeenCalledTimes(1);
    const updateCalls = fake.tx.user.update.mock.calls as unknown as ReadonlyArray<
      readonly [{ where: { id: string }; data: { themePreference: string } }]
    >;
    const updateArgs = updateCalls[0]![0];
    // Self-service invariant: the target row is always the actor's own.
    expect(updateArgs.where.id).toBe(ACTOR_ID);
    expect(updateArgs.data.themePreference).toBe(UserThemePreference.LIGHT);

    const auditCalls = fake.tx.auditLog.create.mock.calls as unknown as ReadonlyArray<
      readonly [{ data: { action: string; resourceId: string } }]
    >;
    expect(auditCalls[0]![0].data.action).toBe("user.theme_preference.changed");
    expect(auditCalls[0]![0].data.resourceId).toBe(ACTOR_ID);
  });

  it("rejects a value outside the enum before touching the row", async () => {
    const fake = buildFake();
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          SetThemePreference,
          { theme: "BLUE" } as unknown as { theme: UserThemePreference },
          { idempotencyKey: "theme-2" }
        )
      )
    ).rejects.toThrow();
    expect(fake.tx.user.update).not.toHaveBeenCalled();
  });
});
