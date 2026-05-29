// RecordAccessReviewSnapshot contract tests.
//
// These tests pin the SOC 2 evidence-recording behavior end-to-end
// through the tenant command bus:
//
//   - happy path: a valid AccessReviewReport is digest-sealed, the
//     snapshot row carries the computed `digestSha256`, the audit
//     entry + outbox payload mirror the same digest, and the
//     persisted `report` is the exact caller payload (no re-shape).
//
//   - cross-tenant rejection: an operator running in org A cannot
//     record evidence about org B (the executor's tenancy MUST
//     match `input.organizationId`).
//
//   - report mismatch: even when `input.organizationId` matches the
//     tenancy, the embedded `report.organizationId` must also match
//     — otherwise we'd persist forged evidence under the wrong
//     organization.
//
//   - RBAC denial: a user without `compliance.access_review.record`
//     is rejected at the bus boundary; no DB writes.
//
// All tests run against an in-memory Prisma fake. The shape mirrors
// the orgs/create-organization test fake (which exercises the same
// audit-chain + outbox writers).

import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { RoleScope } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
} from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";

import type { AccessReviewReport } from "./generate-access-review.js";
import { RecordAccessReviewSnapshot } from "./record-access-review-snapshot.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const CORRELATION = "01HZZZZZZZZZZZZZZZZZZZZZZZ";

function makeReport(overrides: Partial<AccessReviewReport> = {}): AccessReviewReport {
  return {
    organizationId: ORG_ID,
    organizationSlug: "acme",
    generatedAt: "2026-05-28T14:00:00.000Z",
    period: {
      start: "2026-04-01T00:00:00.000Z",
      end: "2026-05-28T00:00:00.000Z",
    },
    principals: [
      {
        userId: USER_ID,
        email: "security@acme.test",
        displayName: "Security Officer",
        status: "ACTIVE",
        clerkUserId: null,
        lastLoginAt: "2026-05-27T10:00:00.000Z",
        assignments: [],
        effectivePermissions: [],
      },
    ],
    summary: {
      totalPrincipals: 4,
      principalsWithElevatedRoles: ["u-1", "u-2"],
      inactivePrincipals: ["u-3"],
      staleAssignments: [
        { userId: "u-2", userRoleId: "ur-2", roleCode: "Pharmacist", ageDays: 400 },
      ],
      cryptoShredCapableRoles: ["SecurityOfficer"],
    },
    ...overrides,
  };
}

// Canonical (sorted-key) SHA-256, mirroring the implementation. The
// test computes this independently so a typo in the production
// canonicalizer surfaces here as a digest divergence rather than
// silently agreeing with itself.
function expectedDigest(value: unknown): string {
  const canon = JSON.stringify(value, (_k, v: unknown): unknown => {
    if (v === null || v === undefined) return v;
    if (typeof v !== "object" || Array.isArray(v)) return v;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      sorted[k] = (v as Record<string, unknown>)[k];
    }
    return sorted;
  });
  return createHash("sha256").update(canon).digest("hex");
}

// ---------------------------------------------------------------------------
// Fake Prisma
// ---------------------------------------------------------------------------

interface FakeCall {
  table: string;
  op: string;
  args: unknown;
}

function buildPrismaFake(): { client: unknown; calls: FakeCall[] } {
  const calls: FakeCall[] = [];

  const tx = {
    accessReviewSnapshot: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "accessReviewSnapshot", op: "create", args });
        const data = (args as { data: { id: string } }).data;
        return { id: data.id };
      }),
    },
    idempotencyKey: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "idempotencyKey", op: "create", args });
        return { id: "idem-1" };
      }),
    },
    auditLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "auditLog", op: "create", args });
        return { id: "audit-1" };
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
        let op: string;
        if (/\bset_config\b/i.test(joined)) {
          op = "set_config";
        } else if (/\bpg_advisory_xact_lock\b/i.test(joined)) {
          op = "advisory_lock";
        } else {
          op = "raw";
        }
        calls.push({ table: "$executeRaw", op, args: { sql: joined, values: [...values] } });
        return 0;
      }
    ),
  };

  const client = {
    commandLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "create", args });
        return { id: (args as { data: { id: string } }).data.id };
      }),
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "update", args });
        return {};
      }),
    },
    idempotencyKey: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "idempotencyKey", op: "findUnique", args });
        return null;
      }),
    },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  return { client, calls };
}

function configureForActor(
  perms: ReadonlyArray<(typeof PERMISSIONS)[keyof typeof PERMISSIONS]>
): void {
  configureRbac({
    loader: new InMemoryPermissionLoader([
      {
        organizationId: ORG_ID,
        userId: USER_ID,
        grants: [
          {
            roleScope: RoleScope.ORGANIZATION,
            grantScope: { siteId: null, clinicId: null, teamId: null },
            permissions: new Set(perms),
          },
        ],
      },
    ]),
  });
}

function tenancyForActor() {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: USER_ID, correlationId: CORRELATION },
  });
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
});

beforeEach(() => {
  // Default to the granted actor; deny-path tests reconfigure.
  configureForActor([PERMISSIONS.COMPLIANCE_ACCESS_REVIEW_RECORD]);
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("RecordAccessReviewSnapshot — happy path", () => {
  it("persists the snapshot row with the digest of the input report", async () => {
    const fake = buildPrismaFake();
    configureCommandBus({
      prisma: fake.client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
      clock: clock.createFrozenClock(new Date("2026-05-28T14:30:00.000Z")),
      logger: logger.noopLogger,
    });

    const report = makeReport();
    const digest = expectedDigest(report);

    const out = await withTenancyContext(tenancyForActor(), () =>
      executeCommand(
        RecordAccessReviewSnapshot,
        { organizationId: ORG_ID, report },
        { idempotencyKey: "cli:access-review:2026-Q2:acme" }
      )
    );

    expect(out.snapshotId).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.digestSha256).toBe(digest);
    expect(out.organizationId).toBe(ORG_ID);
    expect(out.totalPrincipals).toBe(4);
    expect(out.elevatedPrincipalCount).toBe(2);
    expect(out.inactivePrincipalCount).toBe(1);
    expect(out.staleAssignmentCount).toBe(1);
    expect(out.cryptoShredCapableRoleCount).toBe(1);
    expect(out.reportVersion).toBe(1);

    // Snapshot row landed with the input report verbatim, the
    // computed digest, and a FK back to the bus-allocated commandLogId.
    const snapshotCreate = fake.calls.find(
      (c) => c.table === "accessReviewSnapshot" && c.op === "create"
    );
    expect(snapshotCreate).toBeDefined();
    const snapData = (snapshotCreate?.args as { data: Record<string, unknown> }).data;
    expect(snapData["id"]).toBe(out.snapshotId);
    expect(snapData["organizationId"]).toBe(ORG_ID);
    expect(snapData["organizationSlug"]).toBe("acme");
    expect(snapData["digestSha256"]).toBe(digest);
    expect(snapData["reportVersion"]).toBe(1);
    expect(snapData["totalPrincipals"]).toBe(4);
    expect(snapData["elevatedPrincipalCount"]).toBe(2);
    expect(snapData["inactivePrincipalCount"]).toBe(1);
    expect(snapData["staleAssignmentCount"]).toBe(1);
    expect(snapData["cryptoShredCapableRoleCount"]).toBe(1);
    expect(snapData["recordedByUserId"]).toBe(USER_ID);
    expect(snapData["commandLogId"]).toBeDefined();
    expect(snapData["report"]).toEqual(report);

    // command_log row written PRE-tx (tenant path) with the right scope.
    const cmdCreate = fake.calls.find((c) => c.table === "commandLog" && c.op === "create");
    expect(cmdCreate).toBeDefined();
    expect((cmdCreate?.args as { data: { organizationId: string } }).data.organizationId).toBe(
      ORG_ID
    );

    // Outbox event mirrors the digest + scalars.
    const outboxCalls = fake.calls.filter(
      (c) => c.table === "eventOutbox" && c.op === "createMany"
    );
    expect(outboxCalls).toHaveLength(1);
    const outboxData = (outboxCalls[0]?.args as { data: ReadonlyArray<Record<string, unknown>> })
      .data;
    expect(outboxData).toHaveLength(1);
    expect(outboxData[0]?.["eventType"]).toBe("compliance.access_review_snapshot.recorded.v1");
    expect(outboxData[0]?.["aggregateId"]).toBe(out.snapshotId);
    const payload = outboxData[0]?.["payload"] as Record<string, unknown>;
    expect(payload["snapshotId"]).toBe(out.snapshotId);
    expect(payload["digestSha256"]).toBe(digest);
    expect(payload["organizationId"]).toBe(ORG_ID);
    expect(payload["recordedByUserId"]).toBe(USER_ID);
    expect(payload["totalPrincipals"]).toBe(4);
    expect(payload["elevatedPrincipalCount"]).toBe(2);
    expect(payload["cryptoShredCapableRoleCount"]).toBe(1);

    // Audit entry carries the same metadata; the chain writer ran
    // (set_config + advisory_lock + auditLog.create in tx).
    const auditCreate = fake.calls.find((c) => c.table === "auditLog" && c.op === "create");
    expect(auditCreate).toBeDefined();
    const auditMetadata = (auditCreate?.args as { data: { metadata: Record<string, unknown> } })
      .data.metadata;
    expect(auditMetadata["digestSha256"]).toBe(digest);
    expect(auditMetadata["reportVersion"]).toBe(1);
    expect(auditMetadata["totalPrincipals"]).toBe(4);
    expect(
      fake.calls.find((c) => c.table === "$executeRaw" && c.op === "advisory_lock")
    ).toBeDefined();
  });

  it("respects an explicit reportVersion override", async () => {
    const fake = buildPrismaFake();
    configureCommandBus({
      prisma: fake.client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
      clock: clock.createFrozenClock(new Date("2026-05-28T14:30:00.000Z")),
      logger: logger.noopLogger,
    });

    const out = await withTenancyContext(tenancyForActor(), () =>
      executeCommand(
        RecordAccessReviewSnapshot,
        { organizationId: ORG_ID, report: makeReport(), reportVersion: 7 },
        { idempotencyKey: "cli:access-review:override-version" }
      )
    );

    expect(out.reportVersion).toBe(7);
    const snapshotCreate = fake.calls.find(
      (c) => c.table === "accessReviewSnapshot" && c.op === "create"
    );
    expect((snapshotCreate?.args as { data: Record<string, unknown> }).data["reportVersion"]).toBe(
      7
    );
  });
});

// ---------------------------------------------------------------------------
// Cross-tenant rejection
// ---------------------------------------------------------------------------

describe("RecordAccessReviewSnapshot — cross-tenant rejection", () => {
  it("rejects when input.organizationId differs from tenancy", async () => {
    const fake = buildPrismaFake();
    configureCommandBus({
      prisma: fake.client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
      clock: clock.createFrozenClock(new Date("2026-05-28T14:30:00.000Z")),
      logger: logger.noopLogger,
    });

    // Actor is in ORG_ID but tries to record evidence for OTHER_ORG_ID.
    await withTenancyContext(tenancyForActor(), async () => {
      await expect(
        executeCommand(
          RecordAccessReviewSnapshot,
          {
            organizationId: OTHER_ORG_ID,
            report: makeReport({ organizationId: OTHER_ORG_ID }),
          },
          { idempotencyKey: "cli:cross-tenant" }
        )
      ).rejects.toMatchObject({ code: "ACCESS_REVIEW_TENANCY_MISMATCH" });
    });

    // No snapshot was persisted.
    expect(
      fake.calls.find((c) => c.table === "accessReviewSnapshot" && c.op === "create")
    ).toBeUndefined();
  });

  it("rejects when report.organizationId differs from input.organizationId", async () => {
    const fake = buildPrismaFake();
    configureCommandBus({
      prisma: fake.client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
      clock: clock.createFrozenClock(new Date("2026-05-28T14:30:00.000Z")),
      logger: logger.noopLogger,
    });

    await withTenancyContext(tenancyForActor(), async () => {
      await expect(
        executeCommand(
          RecordAccessReviewSnapshot,
          {
            organizationId: ORG_ID,
            report: makeReport({ organizationId: OTHER_ORG_ID }),
          },
          { idempotencyKey: "cli:report-mismatch" }
        )
      ).rejects.toMatchObject({ code: "ACCESS_REVIEW_REPORT_ORG_MISMATCH" });
    });

    expect(
      fake.calls.find((c) => c.table === "accessReviewSnapshot" && c.op === "create")
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// RBAC denial
// ---------------------------------------------------------------------------

describe("RecordAccessReviewSnapshot — RBAC", () => {
  it("rejects callers without compliance.access_review.record (no DB writes)", async () => {
    configureForActor([PERMISSIONS.COMPLIANCE_ACCESS_REVIEW_VIEW]);

    const fake = buildPrismaFake();
    configureCommandBus({
      prisma: fake.client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
      clock: clock.createFrozenClock(new Date("2026-05-28T14:30:00.000Z")),
      logger: logger.noopLogger,
    });

    await withTenancyContext(tenancyForActor(), async () => {
      await expect(
        executeCommand(
          RecordAccessReviewSnapshot,
          { organizationId: ORG_ID, report: makeReport() },
          { idempotencyKey: "cli:rbac-deny" }
        )
      ).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
        metadata: { permission: "compliance.access_review.record" },
      });
    });

    // No command_log, no snapshot.
    expect(fake.calls.filter((c) => c.table === "commandLog")).toHaveLength(0);
    expect(
      fake.calls.find((c) => c.table === "accessReviewSnapshot" && c.op === "create")
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Digest determinism
// ---------------------------------------------------------------------------

describe("RecordAccessReviewSnapshot — digest", () => {
  it("computes a digest that is stable under key reordering and changes on content change", async () => {
    const fake = buildPrismaFake();
    configureCommandBus({
      prisma: fake.client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
      clock: clock.createFrozenClock(new Date("2026-05-28T14:30:00.000Z")),
      logger: logger.noopLogger,
    });

    // Two reports identical in content but different in key order
    // hash to the same digest.
    const reportA = makeReport();
    const reportBShuffled = {
      // Keys deliberately reordered relative to reportA. The
      // canonical-stringify normalization MUST defeat this.
      summary: reportA.summary,
      principals: reportA.principals,
      period: reportA.period,
      generatedAt: reportA.generatedAt,
      organizationSlug: reportA.organizationSlug,
      organizationId: reportA.organizationId,
    } as AccessReviewReport;

    const outA = await withTenancyContext(tenancyForActor(), () =>
      executeCommand(
        RecordAccessReviewSnapshot,
        { organizationId: ORG_ID, report: reportA },
        { idempotencyKey: "cli:digest-a" }
      )
    );
    const outB = await withTenancyContext(tenancyForActor(), () =>
      executeCommand(
        RecordAccessReviewSnapshot,
        { organizationId: ORG_ID, report: reportBShuffled },
        { idempotencyKey: "cli:digest-b" }
      )
    );
    expect(outA.digestSha256).toBe(outB.digestSha256);

    // Changing any content field produces a different digest.
    const reportC = makeReport({
      summary: { ...reportA.summary, totalPrincipals: 999 },
    });
    const outC = await withTenancyContext(tenancyForActor(), () =>
      executeCommand(
        RecordAccessReviewSnapshot,
        { organizationId: ORG_ID, report: reportC },
        { idempotencyKey: "cli:digest-c" }
      )
    );
    expect(outC.digestSha256).not.toBe(outA.digestSha256);
  });
});
