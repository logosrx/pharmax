// ProvisionDefaultBuckets contract tests.
//
// Runs against a mocked Prisma client so the test suite stays DB-
// free. Asserts:
//   1. Happy path: 7 canonical buckets created on a fresh org.
//   2. Idempotency: re-running with the same input creates nothing
//      and returns the same id map.
//   3. Mixed state: some buckets present, some absent → only the
//      missing ones are created and the returned id map is complete.
//   4. Site not found → NotFoundError(PROVISION_BUCKETS_SITE_NOT_FOUND).
//   5. Cross-tenant site → ValidationError(PROVISION_BUCKETS_SITE_ORG_MISMATCH).
//   6. Audit + outbox shape — both carry the (orgId, siteId, created,
//      alreadyPresent) snapshot, and the outbox event type is the
//      versioned `org.buckets.provisioned.v1`.
//   7. Coverage regression: every bucket code referenced by the
//      workflow map (`BUCKET_CODE_FOR_STATUS` +
//      `BUCKET_CODE_FOR_EXCEPTION_STATE`) is in DEFAULT_BUCKET_CODES.
//      If a future state→bucket entry adds a new code, this test
//      forces us to add it to the canonical provisioning set —
//      otherwise that state would land orders in a non-existent
//      bucket and the workflow would fail at runtime.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clock, errors, logger } from "@pharmax/platform-core";
import {
  configureCommandBus,
  executeSystemCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { withSystemContext } from "@pharmax/tenancy";
import { BUCKET_CODE_FOR_EXCEPTION_STATE, BUCKET_CODE_FOR_STATUS } from "@pharmax/workflow";

import {
  DEFAULT_BUCKET_CODES,
  ProvisionDefaultBuckets,
  type DefaultBucketCode,
} from "./provision-default-buckets.js";

interface FakeCall {
  table: string;
  op: string;
  args: unknown;
}

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ORG_ID = "00000000-0000-4000-8000-000000000002";
const SITE_ID = "00000000-0000-4000-8000-000000000003";

/** Build a Prisma fake. Optionally pre-populate buckets to test the
 *  idempotent / partial-fill paths. */
function buildPrismaFake(opts: {
  /** Set of bucket codes already present for ORG_ID. */
  preExistingCodes?: ReadonlySet<DefaultBucketCode>;
  /** If "missing", pharmacySite.findUnique returns null. If
   *  "other-org", it returns a site whose organizationId !== ORG_ID. */
  siteResolution?: "ok" | "missing" | "other-org";
}): {
  client: unknown;
  calls: FakeCall[];
  bucketRows: Map<string, { id: string; siteId: string }>;
} {
  const calls: FakeCall[] = [];
  const bucketRows = new Map<string, { id: string; siteId: string }>(); // code → row

  const preExistingCodes = opts.preExistingCodes ?? new Set<DefaultBucketCode>();
  let preIdx = 0;
  for (const code of preExistingCodes) {
    bucketRows.set(code, {
      id: `pre-${String(++preIdx).padStart(2, "0")}-${code.toLowerCase()}`,
      siteId: SITE_ID,
    });
  }

  let bucketCounter = 0;
  const newBucketId = () => `bbbbbbbb-bbbb-bbbb-bbbb-${String(++bucketCounter).padStart(12, "0")}`;
  let auditCounter = 0;
  const newAuditId = () => `audit-${String(++auditCounter).padStart(4, "0")}`;

  const tx = {
    pharmacySite: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "pharmacySite", op: "findUnique", args });
        const resolution = opts.siteResolution ?? "ok";
        if (resolution === "missing") return null;
        if (resolution === "other-org") {
          return { id: SITE_ID, organizationId: OTHER_ORG_ID };
        }
        return { id: SITE_ID, organizationId: ORG_ID };
      }),
    },
    bucket: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "bucket", op: "findUnique", args });
        const code = (args as { where: { organizationId_code: { code: string } } }).where
          .organizationId_code.code;
        const row = bucketRows.get(code);
        if (row === undefined) return null;
        return { id: row.id, siteId: row.siteId };
      }),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "bucket", op: "create", args });
        const data = (args as { data: { code: string; siteId: string } }).data;
        const id = newBucketId();
        bucketRows.set(data.code, { id, siteId: data.siteId });
        return { id };
      }),
    },
    commandLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "create", args });
        return { id: "cmd-log-1" };
      }),
    },
    auditLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "auditLog", op: "create", args });
        return { id: newAuditId() };
      }),
    },
    auditChainState: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "auditChainState", op: "findUnique", args });
        return null;
      }),
      upsert: vi.fn(async (args: unknown) => {
        calls.push({ table: "auditChainState", op: "upsert", args });
        const data = args as {
          where: { organizationId: string };
          create: { latestHash: Buffer; latestSeq: bigint };
        };
        return {
          organizationId: data.where.organizationId,
          latestHash: data.create.latestHash,
          latestSeq: data.create.latestSeq,
        };
      }),
    },
    eventOutbox: {
      createMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "eventOutbox", op: "createMany", args });
        return { count: 1 };
      }),
    },
    $executeRaw: vi.fn(
      async (template: TemplateStringsArray, ...values: ReadonlyArray<unknown>) => {
        const joined = template.join("?");
        const op = /\bset_config\b/i.test(joined) ? "set_config" : "raw";
        calls.push({ table: "$executeRaw", op, args: { sql: joined, values: [...values] } });
        return 0;
      }
    ),
  };

  const client = {
    commandLog: { update: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  return { client, calls, bucketRows };
}

function configureBusWith(fake: { client: unknown }) {
  configureCommandBus({
    prisma: fake.client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(new Date("2026-05-23T20:00:00.000Z")),
    logger: logger.noopLogger,
  });
}

beforeEach(() => {
  // A default bus configuration so any stray invocation has something
  // to bind to; each test re-configures with its own fake to read calls.
  const fake = buildPrismaFake({});
  configureBusWith(fake);
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
});

describe("ProvisionDefaultBuckets — happy path (fresh org)", () => {
  it("creates all 7 canonical buckets on first run", async () => {
    const fake = buildPrismaFake({});
    configureBusWith(fake);

    const out = await withSystemContext("bootstrap:test", () =>
      executeSystemCommand(ProvisionDefaultBuckets, {
        organizationId: ORG_ID,
        siteId: SITE_ID,
      })
    );

    expect(out.created).toBe(DEFAULT_BUCKET_CODES.size);
    expect(out.alreadyPresent).toBe(0);
    for (const code of DEFAULT_BUCKET_CODES) {
      expect(out.bucketIdsByCode[code]).toMatch(/^[0-9a-f-]{36}$/);
    }

    // 1 site lookup + 7 bucket.findUnique + 7 bucket.create.
    expect(
      fake.calls.filter((c) => c.table === "pharmacySite" && c.op === "findUnique")
    ).toHaveLength(1);
    expect(fake.calls.filter((c) => c.table === "bucket" && c.op === "findUnique")).toHaveLength(
      DEFAULT_BUCKET_CODES.size
    );
    expect(fake.calls.filter((c) => c.table === "bucket" && c.op === "create")).toHaveLength(
      DEFAULT_BUCKET_CODES.size
    );

    // Each create row tagged isSystem=true and pinned to the right org+site.
    const creates = fake.calls.filter((c) => c.table === "bucket" && c.op === "create");
    for (const c of creates) {
      const data = (c.args as { data: Record<string, unknown> }).data;
      expect(data["organizationId"]).toBe(ORG_ID);
      expect(data["siteId"]).toBe(SITE_ID);
      expect(data["isSystem"]).toBe(true);
    }
  });

  it("uses ascending sortOrder in steps of 10 (so admins can insert custom buckets between)", async () => {
    const fake = buildPrismaFake({});
    configureBusWith(fake);

    await withSystemContext("bootstrap:test", () =>
      executeSystemCommand(ProvisionDefaultBuckets, {
        organizationId: ORG_ID,
        siteId: SITE_ID,
      })
    );

    const creates = fake.calls.filter((c) => c.table === "bucket" && c.op === "create");
    const sortOrders = creates.map(
      (c) => (c.args as { data: { sortOrder: number } }).data.sortOrder
    );
    expect(sortOrders).toEqual([10, 20, 30, 40, 50, 60, 70]);
  });
});

describe("ProvisionDefaultBuckets — idempotency", () => {
  it("a second run with all buckets present creates nothing and returns the same id map", async () => {
    // Seed all canonical codes as already present.
    const fake = buildPrismaFake({
      preExistingCodes: DEFAULT_BUCKET_CODES,
    });
    configureBusWith(fake);

    const out = await withSystemContext("backfill:test", () =>
      executeSystemCommand(ProvisionDefaultBuckets, {
        organizationId: ORG_ID,
        siteId: SITE_ID,
      })
    );

    expect(out.created).toBe(0);
    expect(out.alreadyPresent).toBe(DEFAULT_BUCKET_CODES.size);
    // Returned ids match the pre-seeded rows.
    for (const code of DEFAULT_BUCKET_CODES) {
      expect(out.bucketIdsByCode[code]).toBe(fake.bucketRows.get(code)?.id);
    }
    // No bucket.create calls.
    expect(fake.calls.filter((c) => c.table === "bucket" && c.op === "create")).toHaveLength(0);
  });

  it("mixed state: only missing buckets are created; returned id map is complete", async () => {
    // Pre-seed half the canonical codes.
    const preExisting = new Set<DefaultBucketCode>(["INBOX", "TYPING", "PV1"]);
    const fake = buildPrismaFake({ preExistingCodes: preExisting });
    configureBusWith(fake);

    const out = await withSystemContext("backfill:test", () =>
      executeSystemCommand(ProvisionDefaultBuckets, {
        organizationId: ORG_ID,
        siteId: SITE_ID,
      })
    );

    expect(out.alreadyPresent).toBe(preExisting.size);
    expect(out.created).toBe(DEFAULT_BUCKET_CODES.size - preExisting.size);
    // All canonical codes present in the output map.
    for (const code of DEFAULT_BUCKET_CODES) {
      expect(out.bucketIdsByCode[code]).toBeTruthy();
    }
    // Pre-existing rows kept their original ids.
    for (const code of preExisting) {
      expect(out.bucketIdsByCode[code]).toBe(fake.bucketRows.get(code)?.id);
    }
  });
});

describe("ProvisionDefaultBuckets — site validation", () => {
  it("site not found → NotFoundError(PROVISION_BUCKETS_SITE_NOT_FOUND)", async () => {
    const fake = buildPrismaFake({ siteResolution: "missing" });
    configureBusWith(fake);

    await expect(
      withSystemContext("bootstrap:test", () =>
        executeSystemCommand(ProvisionDefaultBuckets, {
          organizationId: ORG_ID,
          siteId: SITE_ID,
        })
      )
    ).rejects.toMatchObject({
      code: "PROVISION_BUCKETS_SITE_NOT_FOUND",
    });
    // Must NOT touch the buckets table on a site-validation failure.
    expect(fake.calls.filter((c) => c.table === "bucket")).toHaveLength(0);
  });

  it("site belongs to another org → ValidationError(PROVISION_BUCKETS_SITE_ORG_MISMATCH)", async () => {
    const fake = buildPrismaFake({ siteResolution: "other-org" });
    configureBusWith(fake);

    await expect(
      withSystemContext("bootstrap:test", () =>
        executeSystemCommand(ProvisionDefaultBuckets, {
          organizationId: ORG_ID,
          siteId: SITE_ID,
        })
      )
    ).rejects.toMatchObject({
      code: "PROVISION_BUCKETS_SITE_ORG_MISMATCH",
    });
    expect(fake.calls.filter((c) => c.table === "bucket")).toHaveLength(0);
  });
});

describe("ProvisionDefaultBuckets — audit + outbox", () => {
  it("emits org.buckets.provisioned.v1 with (orgId, siteId, created, alreadyPresent, occurredAt)", async () => {
    const fake = buildPrismaFake({});
    configureBusWith(fake);

    await withSystemContext("bootstrap:test", () =>
      executeSystemCommand(ProvisionDefaultBuckets, {
        organizationId: ORG_ID,
        siteId: SITE_ID,
      })
    );

    const outboxCalls = fake.calls.filter(
      (c) => c.table === "eventOutbox" && c.op === "createMany"
    );
    expect(outboxCalls).toHaveLength(1);
    const events = (outboxCalls[0]!.args as { data: Array<Record<string, unknown>> }).data;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      organizationId: ORG_ID,
      eventType: "org.buckets.provisioned.v1",
      aggregateType: "PharmacySite",
      aggregateId: SITE_ID,
    });
    const payload = events[0]?.["payload"] as Record<string, unknown>;
    expect(payload).toMatchObject({
      organizationId: ORG_ID,
      siteId: SITE_ID,
      created: DEFAULT_BUCKET_CODES.size,
      alreadyPresent: 0,
      occurredAt: "2026-05-23T20:00:00.000Z",
    });
  });

  it("writes an audit row with action org.buckets.provisioned and resourceType PharmacySite", async () => {
    const fake = buildPrismaFake({});
    configureBusWith(fake);

    await withSystemContext("bootstrap:test", () =>
      executeSystemCommand(ProvisionDefaultBuckets, {
        organizationId: ORG_ID,
        siteId: SITE_ID,
      })
    );

    const auditCalls = fake.calls.filter((c) => c.table === "auditLog" && c.op === "create");
    expect(auditCalls).toHaveLength(1);
    const data = (auditCalls[0]!.args as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({
      action: "org.buckets.provisioned",
      resourceType: "PharmacySite",
      resourceId: SITE_ID,
      organizationId: ORG_ID,
    });
  });
});

describe("ProvisionDefaultBuckets — coverage regression", () => {
  // If a future state→bucket entry adds a new code, this test forces
  // us to add it to the canonical provisioning set — otherwise that
  // state would land orders in a non-existent bucket and the
  // workflow would fail at runtime.
  it("every bucket code referenced by BUCKET_CODE_FOR_STATUS is in DEFAULT_BUCKET_CODES", () => {
    for (const code of Object.values(BUCKET_CODE_FOR_STATUS)) {
      expect(DEFAULT_BUCKET_CODES.has(code as DefaultBucketCode)).toBe(true);
    }
  });

  it("every bucket code referenced by BUCKET_CODE_FOR_EXCEPTION_STATE is in DEFAULT_BUCKET_CODES", () => {
    for (const code of Object.values(BUCKET_CODE_FOR_EXCEPTION_STATE)) {
      if (code === undefined) continue;
      expect(DEFAULT_BUCKET_CODES.has(code as DefaultBucketCode)).toBe(true);
    }
  });
});

describe("ProvisionDefaultBuckets — input validation", () => {
  it("rejects non-uuid organizationId", async () => {
    const fake = buildPrismaFake({});
    configureBusWith(fake);

    await expect(
      withSystemContext("bootstrap:test", () =>
        executeSystemCommand(ProvisionDefaultBuckets, {
          organizationId: "not-a-uuid",
          siteId: SITE_ID,
        })
      )
    ).rejects.toThrow();
  });

  it("rejects non-uuid siteId", async () => {
    const fake = buildPrismaFake({});
    configureBusWith(fake);

    await expect(
      withSystemContext("bootstrap:test", () =>
        executeSystemCommand(ProvisionDefaultBuckets, {
          organizationId: ORG_ID,
          siteId: "not-a-uuid",
        })
      )
    ).rejects.toThrow();
  });
});

// Local references to errors used in the tests above. Keeping this
// at the bottom (rather than as a top-level import) keeps the test
// file focused on contract behavior — the imports above stay tight.
void errors;
