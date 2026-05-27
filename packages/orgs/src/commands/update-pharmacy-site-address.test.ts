// UpdatePharmacySiteAddress contract tests.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { RoleScope } from "@pharmax/database";
import { clock, errors, logger } from "@pharmax/platform-core";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";

import { UpdatePharmacySiteAddress } from "./update-pharmacy-site-address.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const SITE_ID = "00000000-0000-4000-8000-000000000010";
const USER_ID = "00000000-0000-4000-8000-000000000009";

const orgAdminGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.ORG_MANAGE_SITES]),
  },
];

function ctx() {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: USER_ID, correlationId: "01CORRELATION0000000000000" },
  });
}

interface ExistingRow {
  id: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string;
  phone: string | null;
}

interface FakeCall {
  table: string;
  op: string;
  args: unknown;
}

function buildPrismaFake(input: { existing: ExistingRow | null }) {
  const calls: FakeCall[] = [];

  const tx = {
    pharmacySite: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "pharmacySite", op: "findFirst", args });
        return input.existing;
      }),
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "pharmacySite", op: "update", args });
        return { id: SITE_ID };
      }),
    },
    commandLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "create", args });
        return { id: "cl-1" };
      }),
    },
    auditLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "auditLog", op: "create", args });
        return { id: "al-1" };
      }),
    },
    auditChainState: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({
        organizationId: ORG_ID,
        latestHash: Buffer.alloc(32),
        latestSeq: 1n,
      })),
    },
    eventOutbox: {
      createMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "eventOutbox", op: "createMany", args });
        return { count: 1 };
      }),
    },
    idempotencyKey: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "idempotencyKey", op: "create", args });
        return { ok: true };
      }),
    },
    $executeRaw: vi.fn(async () => 0),
  };

  const client = {
    commandLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "create", args });
        return { id: "cl-pre" };
      }),
      update: vi.fn(async () => ({ ok: true })),
    },
    idempotencyKey: { findUnique: vi.fn(async () => null) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  return { client, calls, tx };
}

function configureBus(client: unknown): void {
  configureCommandBus({
    prisma: client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(new Date("2026-05-25T20:00:00.000Z")),
    logger: logger.noopLogger,
  });
}

const VALID_INPUT = {
  siteId: SITE_ID,
  addressLine1: "100 Main St",
  city: "Boston",
  state: "MA",
  postalCode: "02110",
  country: "US",
  phone: "+16175550100",
} as const;

beforeEach(() => {
  configureRbac({
    loader: new InMemoryPermissionLoader([
      { organizationId: ORG_ID, userId: USER_ID, grants: orgAdminGrants },
    ]),
  });
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
});

function buildEmptyExisting(): ExistingRow {
  return {
    id: SITE_ID,
    addressLine1: null,
    addressLine2: null,
    city: null,
    state: null,
    postalCode: null,
    country: "US",
    phone: null,
  };
}

describe("UpdatePharmacySiteAddress — happy path", () => {
  it("populates an empty address and reports every changed field", async () => {
    const fake = buildPrismaFake({ existing: buildEmptyExisting() });
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(UpdatePharmacySiteAddress, { ...VALID_INPUT }, { idempotencyKey: "u-1" })
    );

    expect(out.siteId).toBe(SITE_ID);
    // country is unchanged (existing default "US" === input "US"); the
    // other six populated fields are all changes.
    expect(out.fieldsChanged).toEqual(
      expect.arrayContaining(["addressLine1", "city", "state", "postalCode", "phone"])
    );
    expect(out.fieldsChanged).not.toContain("country");
  });

  it("writes the update with the trimmed plaintext values", async () => {
    const fake = buildPrismaFake({ existing: buildEmptyExisting() });
    configureBus(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        UpdatePharmacySiteAddress,
        { ...VALID_INPUT, addressLine1: "  100 Main St  " },
        { idempotencyKey: "u-2" }
      )
    );

    const update = fake.calls.find((c) => c.table === "pharmacySite" && c.op === "update");
    const data = (update!.args as { data: Record<string, unknown> }).data;
    expect(data["addressLine1"]).toBe("100 Main St");
    expect(data["postalCode"]).toBe("02110");
  });
});

describe("UpdatePharmacySiteAddress — guards", () => {
  it("throws PHARMACY_SITE_NOT_FOUND when the site is not in the tenant", async () => {
    const fake = buildPrismaFake({ existing: null });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(UpdatePharmacySiteAddress, { ...VALID_INPUT }, { idempotencyKey: "u-3" })
      )
    ).rejects.toMatchObject({ code: "PHARMACY_SITE_NOT_FOUND" });
  });

  it("rejects an unknown country code at the Zod boundary", async () => {
    const fake = buildPrismaFake({ existing: buildEmptyExisting() });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          UpdatePharmacySiteAddress,
          { ...VALID_INPUT, country: "USA" } as unknown as typeof VALID_INPUT,
          { idempotencyKey: "u-4" }
        )
      )
    ).rejects.toBeInstanceOf(errors.ValidationError);
  });
});

describe("UpdatePharmacySiteAddress — RBAC", () => {
  it("denies when the actor lacks ORG_MANAGE_SITES", async () => {
    configureRbac({
      loader: new InMemoryPermissionLoader([
        {
          organizationId: ORG_ID,
          userId: USER_ID,
          grants: [
            {
              roleScope: RoleScope.ORGANIZATION,
              grantScope: { siteId: null, clinicId: null, teamId: null },
              permissions: new Set([PERMISSIONS.ORGS_READ]),
            },
          ],
        },
      ]),
    });
    const fake = buildPrismaFake({ existing: buildEmptyExisting() });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(UpdatePharmacySiteAddress, { ...VALID_INPUT }, { idempotencyKey: "u-5" })
      )
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
});
