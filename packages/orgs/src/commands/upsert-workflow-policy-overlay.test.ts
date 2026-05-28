// UpsertWorkflowPolicyOverlay contract tests.
//
// Test surface:
//
//   - Happy path: org-wide overlay; clinic-scoped overlay; supersedure
//     of a prior ACTIVE row.
//   - Zod boundary: rejects unknown keys; rejects empty overlays;
//     rejects malformed attestation entries.
//   - Domain guards:
//       * UPSERT_OVERLAY_BASE_POLICY_NOT_FOUND when the policy id is
//         not in this org.
//       * UPSERT_OVERLAY_BASE_POLICY_NOT_READABLE when the policy is
//         DRAFT or ARCHIVED.
//       * UPSERT_OVERLAY_BASE_POLICY_UNSUPPORTED when the policy is
//         not in the supported registry (today: order.standard v1).
//       * UPSERT_OVERLAY_CLINIC_NOT_FOUND when clinic id is not in
//         this org.
//   - Tighten-only invariant: overlay that references an unknown
//     (command, state) pair lands as
//     OVERLAY_LOOSENS_BASE_POLICY via the merge function.
//   - RBAC: denied without WORKFLOW_OVERLAY_MANAGE.
//   - Race: P2002 surfaces as UPSERT_OVERLAY_ACTIVE_RACE.
//
// PHI invariant: every overlay shape uses synthetic ids (UUIDs) +
// configuration-only data. Nothing in this file references real
// patients or operator data.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { Prisma, RoleScope, WorkflowPolicyOverlayStatus } from "@pharmax/database";
import { clock, errors, logger } from "@pharmax/platform-core";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";

import {
  UPSERT_OVERLAY_ACTIVE_RACE,
  UPSERT_OVERLAY_BASE_POLICY_NOT_FOUND,
  UPSERT_OVERLAY_BASE_POLICY_NOT_READABLE,
  UPSERT_OVERLAY_BASE_POLICY_UNSUPPORTED,
  UPSERT_OVERLAY_CLINIC_NOT_FOUND,
  UpsertWorkflowPolicyOverlay,
} from "./upsert-workflow-policy-overlay.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const POLICY_ID = "00000000-0000-4000-8000-000000000020";
const CLINIC_ID = "00000000-0000-4000-8000-000000000030";
const PRIOR_OVERLAY_ID = "00000000-0000-4000-8000-000000000040";
const USER_ID = "00000000-0000-4000-8000-000000000009";

const orgAdminGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.WORKFLOW_OVERLAY_MANAGE]),
  },
];

function ctx() {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: USER_ID, correlationId: "01CORRELATION0000000000000" },
  });
}

interface PolicyRow {
  id: string;
  code: string;
  version: number;
  status: "DRAFT" | "ACTIVE" | "SUPERSEDED" | "ARCHIVED";
}

interface PriorOverlayRow {
  id: string;
  version: number;
}

interface ClinicRow {
  id: string;
  organizationId: string;
}

interface FakeCall {
  table: string;
  op: string;
  args: unknown;
}

interface FakeOpts {
  policy: PolicyRow | null;
  prior?: PriorOverlayRow | null;
  clinic?: ClinicRow | null;
  insertError?: unknown;
}

function buildPrismaFake(opts: FakeOpts) {
  const calls: FakeCall[] = [];
  const tx = {
    workflowPolicy: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "workflowPolicy", op: "findFirst", args });
        return opts.policy;
      }),
    },
    clinic: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "clinic", op: "findUnique", args });
        return opts.clinic ?? null;
      }),
    },
    workflowPolicyOverlay: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "workflowPolicyOverlay", op: "findFirst", args });
        return opts.prior ?? null;
      }),
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "workflowPolicyOverlay", op: "update", args });
        return { id: PRIOR_OVERLAY_ID };
      }),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "workflowPolicyOverlay", op: "create", args });
        if (opts.insertError !== undefined) throw opts.insertError;
        return { id: (args as { data: { id: string } }).data.id };
      }),
    },
    commandLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "create", args });
        return { id: "cl-tx" };
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

const ACTIVE_BASE_POLICY: PolicyRow = {
  id: POLICY_ID,
  code: "order.standard",
  version: 1,
  status: "ACTIVE",
};

const VALID_FORBID_INPUT = {
  workflowPolicyId: POLICY_ID,
  clinicId: null,
  overlay: {
    forbidTransitionsFromStates: {
      REOPEN_FOR_CORRECTION: ["PV1_REJECTED"],
    },
  },
} as const;

describe("UpsertWorkflowPolicyOverlay — happy path", () => {
  it("activates a brand-new org-wide overlay (no prior ACTIVE)", async () => {
    const fake = buildPrismaFake({ policy: ACTIVE_BASE_POLICY, prior: null });
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        UpsertWorkflowPolicyOverlay,
        { ...VALID_FORBID_INPUT },
        { idempotencyKey: "u-1" }
      )
    );

    expect(out.supersededOverlayId).toBeNull();
    expect(out.overlayVersion).toBe(1);
    expect(out.clinicId).toBeNull();
    expect(out.workflowPolicyId).toBe(POLICY_ID);
    expect(out.affectedTransitionIds.length).toBeGreaterThan(0);

    const insert = fake.calls.find((c) => c.table === "workflowPolicyOverlay" && c.op === "create");
    expect(insert).toBeDefined();
    const data = (insert!.args as { data: Record<string, unknown> }).data;
    expect(data["organizationId"]).toBe(ORG_ID);
    expect(data["clinicId"]).toBeNull();
    expect(data["workflowPolicyId"]).toBe(POLICY_ID);
    expect(data["status"]).toBe(WorkflowPolicyOverlayStatus.ACTIVE);
    expect(data["version"]).toBe(1);
    expect(data["createdByUserId"]).toBe(USER_ID);

    // No prior to supersede ⇒ no update call.
    expect(
      fake.calls.find((c) => c.table === "workflowPolicyOverlay" && c.op === "update")
    ).toBeUndefined();
  });

  it("supersedes the prior ACTIVE overlay and increments version", async () => {
    const fake = buildPrismaFake({
      policy: ACTIVE_BASE_POLICY,
      prior: { id: PRIOR_OVERLAY_ID, version: 3 },
    });
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        UpsertWorkflowPolicyOverlay,
        { ...VALID_FORBID_INPUT },
        { idempotencyKey: "u-2" }
      )
    );

    expect(out.supersededOverlayId).toBe(PRIOR_OVERLAY_ID);
    expect(out.overlayVersion).toBe(4);

    const update = fake.calls.find((c) => c.table === "workflowPolicyOverlay" && c.op === "update");
    expect(update).toBeDefined();
    const updateArgs = update!.args as {
      where: { id: string };
      data: { status: WorkflowPolicyOverlayStatus };
    };
    expect(updateArgs.where.id).toBe(PRIOR_OVERLAY_ID);
    expect(updateArgs.data.status).toBe(WorkflowPolicyOverlayStatus.SUPERSEDED);
  });

  it("accepts a clinic-scoped overlay when the clinic is in the org", async () => {
    const fake = buildPrismaFake({
      policy: ACTIVE_BASE_POLICY,
      clinic: { id: CLINIC_ID, organizationId: ORG_ID },
    });
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        UpsertWorkflowPolicyOverlay,
        { ...VALID_FORBID_INPUT, clinicId: CLINIC_ID },
        { idempotencyKey: "u-3" }
      )
    );

    expect(out.clinicId).toBe(CLINIC_ID);
  });

  it("emits workflow.overlay.upserted.v1 with the affected transition ids", async () => {
    const fake = buildPrismaFake({ policy: ACTIVE_BASE_POLICY, prior: null });
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        UpsertWorkflowPolicyOverlay,
        { ...VALID_FORBID_INPUT },
        { idempotencyKey: "u-4" }
      )
    );

    const outbox = fake.calls.find((c) => c.table === "eventOutbox" && c.op === "createMany");
    expect(outbox).toBeDefined();
    const rows = (outbox!.args as { data: Array<Record<string, unknown>> }).data;
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row["eventType"]).toBe("workflow.overlay.upserted.v1");
    expect(row["aggregateType"]).toBe("WorkflowPolicyOverlay");
    expect(row["aggregateId"]).toBe(out.overlayId);

    // Prisma `Json` columns receive plain JS objects, not stringified
    // JSON — the outbox writes the payload as `payload: data`.
    const payload = row["payload"] as Record<string, unknown>;
    expect(payload["organizationId"]).toBe(ORG_ID);
    expect(payload["overlayId"]).toBe(out.overlayId);
    expect(payload["overlayVersion"]).toBe(1);
    expect(payload["affectedTransitionIds"]).toEqual(out.affectedTransitionIds);
    expect(payload["supersededOverlayId"]).toBeNull();
  });
});

describe("UpsertWorkflowPolicyOverlay — Zod boundary", () => {
  it("rejects an unknown top-level key", async () => {
    const fake = buildPrismaFake({ policy: ACTIVE_BASE_POLICY });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          UpsertWorkflowPolicyOverlay,
          { ...VALID_FORBID_INPUT, notes: "free text" } as unknown as typeof VALID_FORBID_INPUT,
          { idempotencyKey: "z-1" }
        )
      )
    ).rejects.toBeInstanceOf(errors.ValidationError);
  });

  it("rejects an empty overlay (no forbid and no attestations)", async () => {
    const fake = buildPrismaFake({ policy: ACTIVE_BASE_POLICY });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          UpsertWorkflowPolicyOverlay,
          { workflowPolicyId: POLICY_ID, clinicId: null, overlay: {} } as never,
          { idempotencyKey: "z-2" }
        )
      )
    ).rejects.toBeInstanceOf(errors.ValidationError);
  });

  it("rejects a malformed attestation entry (minSignatures < 1)", async () => {
    const fake = buildPrismaFake({ policy: ACTIVE_BASE_POLICY });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          UpsertWorkflowPolicyOverlay,
          {
            workflowPolicyId: POLICY_ID,
            clinicId: null,
            overlay: {
              addRequiredAttestations: {
                "wf.v1.approve_pv1": [
                  {
                    id: "second-pv1",
                    minSignatures: 0,
                    permission: "pv1.approve",
                  },
                ],
              },
            },
          } as never,
          { idempotencyKey: "z-3" }
        )
      )
    ).rejects.toBeInstanceOf(errors.ValidationError);
  });
});

describe("UpsertWorkflowPolicyOverlay — domain guards", () => {
  it("throws UPSERT_OVERLAY_BASE_POLICY_NOT_FOUND when the policy is missing", async () => {
    const fake = buildPrismaFake({ policy: null });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          UpsertWorkflowPolicyOverlay,
          { ...VALID_FORBID_INPUT },
          { idempotencyKey: "g-1" }
        )
      )
    ).rejects.toMatchObject({ code: UPSERT_OVERLAY_BASE_POLICY_NOT_FOUND });
  });

  it("throws UPSERT_OVERLAY_BASE_POLICY_NOT_READABLE for a DRAFT policy", async () => {
    const fake = buildPrismaFake({
      policy: { ...ACTIVE_BASE_POLICY, status: "DRAFT" },
    });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          UpsertWorkflowPolicyOverlay,
          { ...VALID_FORBID_INPUT },
          { idempotencyKey: "g-2" }
        )
      )
    ).rejects.toMatchObject({ code: UPSERT_OVERLAY_BASE_POLICY_NOT_READABLE });
  });

  it("throws UPSERT_OVERLAY_BASE_POLICY_NOT_READABLE for an ARCHIVED policy", async () => {
    const fake = buildPrismaFake({
      policy: { ...ACTIVE_BASE_POLICY, status: "ARCHIVED" },
    });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          UpsertWorkflowPolicyOverlay,
          { ...VALID_FORBID_INPUT },
          { idempotencyKey: "g-3" }
        )
      )
    ).rejects.toMatchObject({ code: UPSERT_OVERLAY_BASE_POLICY_NOT_READABLE });
  });

  it("throws UPSERT_OVERLAY_BASE_POLICY_UNSUPPORTED for an unknown policy code", async () => {
    const fake = buildPrismaFake({
      policy: { ...ACTIVE_BASE_POLICY, code: "order.future", version: 9 },
    });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          UpsertWorkflowPolicyOverlay,
          { ...VALID_FORBID_INPUT },
          { idempotencyKey: "g-4" }
        )
      )
    ).rejects.toMatchObject({ code: UPSERT_OVERLAY_BASE_POLICY_UNSUPPORTED });
  });

  it("throws UPSERT_OVERLAY_CLINIC_NOT_FOUND when the clinic is not in the org", async () => {
    const fake = buildPrismaFake({
      policy: ACTIVE_BASE_POLICY,
      clinic: null,
    });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          UpsertWorkflowPolicyOverlay,
          { ...VALID_FORBID_INPUT, clinicId: CLINIC_ID },
          { idempotencyKey: "g-5" }
        )
      )
    ).rejects.toMatchObject({ code: UPSERT_OVERLAY_CLINIC_NOT_FOUND });
  });

  it("throws UPSERT_OVERLAY_CLINIC_NOT_FOUND when the clinic belongs to a different org", async () => {
    const fake = buildPrismaFake({
      policy: ACTIVE_BASE_POLICY,
      clinic: { id: CLINIC_ID, organizationId: "ffffffff-ffff-4fff-8fff-ffffffffffff" },
    });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          UpsertWorkflowPolicyOverlay,
          { ...VALID_FORBID_INPUT, clinicId: CLINIC_ID },
          { idempotencyKey: "g-6" }
        )
      )
    ).rejects.toMatchObject({ code: UPSERT_OVERLAY_CLINIC_NOT_FOUND });
  });
});

describe("UpsertWorkflowPolicyOverlay — tighten-only invariant", () => {
  it("rejects an overlay that names a transition the base does not declare", async () => {
    const fake = buildPrismaFake({ policy: ACTIVE_BASE_POLICY });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          UpsertWorkflowPolicyOverlay,
          {
            workflowPolicyId: POLICY_ID,
            clinicId: null,
            overlay: {
              // `CANCEL` from `SHIPPED` is not a base-declared transition
              // (`cancelFromStates` excludes terminal states). The merge
              // function throws OVERLAY_LOOSENS_BASE_POLICY because the
              // overlay names a (command, source) pair the base does
              // not allow — by definition the only way to "tighten" a
              // disallowed transition is a no-op.
              forbidTransitionsFromStates: { CANCEL: ["SHIPPED"] },
            },
          },
          { idempotencyKey: "t-1" }
        )
      )
    ).rejects.toMatchObject({ code: "OVERLAY_LOOSENS_BASE_POLICY" });
  });
});

describe("UpsertWorkflowPolicyOverlay — RBAC", () => {
  it("denies when the actor lacks WORKFLOW_OVERLAY_MANAGE", async () => {
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
    const fake = buildPrismaFake({ policy: ACTIVE_BASE_POLICY });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          UpsertWorkflowPolicyOverlay,
          { ...VALID_FORBID_INPUT },
          { idempotencyKey: "r-1" }
        )
      )
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
});

describe("UpsertWorkflowPolicyOverlay — race", () => {
  it("maps a Prisma P2002 on insert to UPSERT_OVERLAY_ACTIVE_RACE", async () => {
    const fake = buildPrismaFake({
      policy: ACTIVE_BASE_POLICY,
      prior: null,
      insertError: new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "5.22.0",
      }),
    });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          UpsertWorkflowPolicyOverlay,
          { ...VALID_FORBID_INPUT },
          { idempotencyKey: "race-1" }
        )
      )
    ).rejects.toMatchObject({ code: UPSERT_OVERLAY_ACTIVE_RACE });
  });
});
