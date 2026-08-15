// AcceptCheckException contract tests.
//
// This is the command that makes a red control stop being red without
// the underlying problem being fixed, so the tests are mostly about
// the constraints that keep it from becoming the quiet way to make
// the dashboard green: a named approver, a justification long enough
// to mean something, a reason code from a closed set, a capped
// expiry, and a refusal to stack a second exception over a live one.
//
// Surface:
//   - Evidence: approver, reason code, justification, and expiry
//     land on the record and in the audit row.
//   - Expiry arithmetic: exactly durationDays from acceptance,
//     bounded by COMPLIANCE_EXCEPTION_MAX_DAYS.
//   - Input guards: short justifications and unknown reason codes are
//     refused before anything is written.
//   - RBAC: COMPLIANCE_EXCEPTION_ACCEPT is required, and control
//     sign-off does not substitute for it.
//   - Duplicate guard: an active exception for the same scope blocks
//     a second one; the search is scoped to that subject.
//   - Idempotency: a retried acceptance replays rather than creating
//     a second exception.

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
  type ResolvedGrant,
} from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";

import {
  AcceptCheckException,
  COMPLIANCE_CHECK_NOT_FOUND,
  COMPLIANCE_EXCEPTION_ALREADY_ACTIVE,
  COMPLIANCE_EXCEPTION_MAX_DAYS,
} from "./accept-check-exception.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const SUBJECT_ORG_ID = "00000000-0000-4000-8000-000000000002";
const USER_ID = "00000000-0000-4000-8000-000000000009";
const CHECK_ID = "33330000-3333-4333-8333-000000000001";
const EXCEPTION_ID = "44440000-4444-4444-8444-000000000001";
const CHECK_CODE = "integrity.outbox-dead-letter-backlog";

const NOW = new Date("2026-06-01T12:00:00.000Z");
const DAY_MS = 86_400_000;

const approverGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.COMPLIANCE_EXCEPTION_ACCEPT]),
  },
];

interface FakeCheck {
  id: string;
  code: string;
  severity: string;
  exceptions: Array<{ id: string; expiresAt: Date }>;
}

interface FakeOverrides {
  check?: FakeCheck | null;
  persistIdempotency?: boolean;
}

interface FakeCall {
  readonly table: string;
  readonly op: string;
  readonly args: unknown;
}

const defaultCheck = (): FakeCheck => ({
  id: CHECK_ID,
  code: CHECK_CODE,
  severity: "HIGH",
  exceptions: [],
});

function buildPrismaFake(overrides: FakeOverrides = {}): {
  client: unknown;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const push = (table: string, op: string, args: unknown): void => {
    calls.push({ table, op, args });
  };
  const check = overrides.check === undefined ? defaultCheck() : overrides.check;

  const idempotencyStore = new Map<string, Record<string, unknown>>();
  const idempotencyId = (organizationId: unknown, commandName: unknown, key: unknown): string =>
    `${String(organizationId)}\u0000${String(commandName)}\u0000${String(key)}`;
  const idempotencyLookup = (args: unknown): Record<string, unknown> | null => {
    if (overrides.persistIdempotency !== true) return null;
    const where = (args as { where?: Record<string, unknown> }).where ?? {};
    const composite =
      (where["organizationId_commandName_key"] as Record<string, unknown> | undefined) ?? where;
    return (
      idempotencyStore.get(
        idempotencyId(composite["organizationId"], composite["commandName"], composite["key"])
      ) ?? null
    );
  };

  const tx = {
    complianceCheck: {
      findUnique: vi.fn(async (args: unknown) => {
        push("complianceCheck", "findUnique", args);
        return check;
      }),
    },
    complianceCheckException: {
      create: vi.fn(async (args: unknown) => {
        push("complianceCheckException", "create", args);
        return { id: EXCEPTION_ID };
      }),
    },
    commandLog: {
      create: vi.fn(async (args: unknown) => {
        push("commandLog", "create", args);
        return { id: "cl" };
      }),
      update: vi.fn(async (args: unknown) => {
        push("commandLog", "update", args);
        return { ok: true };
      }),
      findUnique: vi.fn(async (args: unknown) => {
        push("commandLog", "findUnique", args);
        return null;
      }),
    },
    auditLog: {
      create: vi.fn(async (args: unknown) => {
        push("auditLog", "create", args);
        return { id: "al" };
      }),
    },
    auditChainState: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async (args: unknown) => {
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
        push("eventOutbox", "createMany", args);
        return { count: (args as { data: unknown[] }).data.length };
      }),
    },
    idempotencyKey: {
      create: vi.fn(async (args: unknown) => {
        push("idempotencyKey", "create", args);
        const data = (args as { data: Record<string, unknown> }).data;
        idempotencyStore.set(
          idempotencyId(data["organizationId"], data["commandName"], data["key"]),
          { id: "idem-1", requestHash: null, responsePayload: null, ...data }
        );
        return { id: "idem-1" };
      }),
      findUnique: vi.fn(async (args: unknown) => {
        push("idempotencyKey", "findUnique", args);
        return idempotencyLookup(args);
      }),
    },
    $executeRaw: vi.fn(async () => 0),
  };

  const client = {
    commandLog: {
      create: vi.fn(async () => ({ id: "cl-pre" })),
      update: vi.fn(async () => ({ ok: true })),
    },
    idempotencyKey: {
      findUnique: vi.fn(async (args: unknown) => idempotencyLookup(args)),
    },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  return { client, calls };
}

function wire(client: unknown, grants: ReadonlyArray<ResolvedGrant> = approverGrants): void {
  configureCommandBus({
    prisma: client as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(NOW),
    logger: logger.noopLogger,
  });
  configureRbac({
    loader: new InMemoryPermissionLoader([{ organizationId: ORG_ID, userId: USER_ID, grants }]),
  });
}

function callsOf(calls: FakeCall[], table: string, op: string): FakeCall[] {
  return calls.filter((c) => c.table === table && c.op === op);
}

function createDataOf(calls: FakeCall[]): Record<string, unknown> {
  const created = callsOf(calls, "complianceCheckException", "create")[0];
  if (created === undefined) throw new Error("expected an exception row");
  return (created.args as { data: Record<string, unknown> }).data;
}

function auditDataOf(calls: FakeCall[]): { action: string; metadata: Record<string, unknown> } {
  const audit = callsOf(calls, "auditLog", "create")[0];
  if (audit === undefined) throw new Error("expected an audit row");
  return (audit.args as { data: { action: string; metadata: Record<string, unknown> } }).data;
}

function outboxRowsOf(
  calls: FakeCall[]
): Array<{ eventType: string; payload: Record<string, unknown> }> {
  return callsOf(calls, "eventOutbox", "createMany").flatMap(
    (c) => (c.args as { data: Array<{ eventType: string; payload: Record<string, unknown> }> }).data
  );
}

const ctxFor = () =>
  buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: USER_ID, correlationId: "01CORRELATION0000000000000" },
  });

const JUSTIFICATION =
  "Upstream carrier sandbox is down; the drain backlog clears as soon as they restore service.";

const validInput = {
  checkCode: CHECK_CODE,
  subjectOrganizationId: SUBJECT_ORG_ID,
  reasonCode: "VENDOR_DEPENDENCY" as const,
  justification: JUSTIFICATION,
  durationDays: 30,
};

const run = (input: unknown = validInput, idempotencyKey = "exc-1") =>
  withTenancyContext(ctxFor(), () =>
    executeCommand(AcceptCheckException, input, { idempotencyKey })
  );

beforeEach(() => {
  const fake = buildPrismaFake();
  wire(fake.client);
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
});

describe("AcceptCheckException — the evidence record", () => {
  it("names the approver and preserves the justification verbatim", async () => {
    const fake = buildPrismaFake();
    wire(fake.client);

    const out = await run();

    // Someone decided to tolerate a failing control. An exception
    // whose approver or reasoning is missing is an anonymous decision
    // with nobody to ask about it at audit time.
    expect(out).toMatchObject({
      exceptionId: EXCEPTION_ID,
      checkId: CHECK_ID,
      checkCode: CHECK_CODE,
      reasonCode: "VENDOR_DEPENDENCY",
      approvedByUserId: USER_ID,
    });
    expect(createDataOf(fake.calls)).toMatchObject({
      checkId: CHECK_ID,
      subjectOrganizationId: SUBJECT_ORG_ID,
      reasonCode: "VENDOR_DEPENDENCY",
      justification: JUSTIFICATION,
      approvedByUserId: USER_ID,
    });
  });

  it("records the acceptance on the audit chain with its reason and severity", async () => {
    const fake = buildPrismaFake();
    wire(fake.client);

    await run();

    const audit = auditDataOf(fake.calls);
    expect(audit.action).toBe("compliance.check_exception.accepted");
    expect(audit.metadata).toMatchObject({
      checkCode: CHECK_CODE,
      severity: "HIGH",
      subjectOrganizationId: SUBJECT_ORG_ID,
      reasonCode: "VENDOR_DEPENDENCY",
      justification: JUSTIFICATION,
      durationDays: 30,
    });
  });

  it("emits compliance.check_exception.accepted.v1 with the approver attached", async () => {
    const fake = buildPrismaFake();
    wire(fake.client);

    await run();

    const rows = outboxRowsOf(fake.calls);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe("compliance.check_exception.accepted.v1");
    expect(rows[0]?.payload).toMatchObject({
      exceptionId: EXCEPTION_ID,
      checkCode: CHECK_CODE,
      organizationId: ORG_ID,
      subjectOrganizationId: SUBJECT_ORG_ID,
      approvedByUserId: USER_ID,
    });
  });

  it("accepts platform-wide when no subject organization is named", async () => {
    const fake = buildPrismaFake();
    wire(fake.client);

    const out = await run({
      checkCode: CHECK_CODE,
      reasonCode: "PROBE_DEFECT",
      justification: JUSTIFICATION,
      durationDays: 7,
    });

    // A platform-wide exception is a broader claim than a
    // tenant-scoped one; it has to be recorded as an explicit null
    // rather than inheriting the approver's own organization.
    expect(out.subjectOrganizationId).toBeNull();
    expect(createDataOf(fake.calls)["subjectOrganizationId"]).toBeNull();
  });
});

describe("AcceptCheckException — the expiry window", () => {
  it("expires exactly durationDays after acceptance", async () => {
    const fake = buildPrismaFake();
    wire(fake.client);

    const out = await run();

    // The expiry is the only thing that forces the condition to be
    // re-justified. If it drifted long, an exception outlives the
    // audit period it was supposed to be re-examined in.
    const expected = new Date(NOW.getTime() + 30 * DAY_MS);
    expect(out.expiresAt).toBe(expected.toISOString());
    expect(createDataOf(fake.calls)["expiresAt"]).toEqual(expected);
  });

  it("honours a one-day window without rounding it away", async () => {
    const fake = buildPrismaFake();
    wire(fake.client);

    const out = await run({ ...validInput, durationDays: 1 });

    expect(out.expiresAt).toBe(new Date(NOW.getTime() + DAY_MS).toISOString());
  });

  it("accepts the cap but refuses a window beyond it", async () => {
    const atCap = buildPrismaFake();
    wire(atCap.client);
    await run({ ...validInput, durationDays: COMPLIANCE_EXCEPTION_MAX_DAYS });
    expect(callsOf(atCap.calls, "complianceCheckException", "create")).toHaveLength(1);

    resetCommandBusConfigurationForTests();
    resetRbacConfigurationForTests();
    const overCap = buildPrismaFake();
    wire(overCap.client);

    // A permanent exception is not an exception; it is an
    // undocumented change to the control design.
    await expect(
      run({ ...validInput, durationDays: COMPLIANCE_EXCEPTION_MAX_DAYS + 1 })
    ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    expect(callsOf(overCap.calls, "complianceCheckException", "create")).toHaveLength(0);
  });

  it("refuses a zero-day window", async () => {
    const fake = buildPrismaFake();
    wire(fake.client);

    // An exception that expires the instant it is written is a way to
    // record an acceptance that never actually covered anything.
    await expect(run({ ...validInput, durationDays: 0 })).rejects.toMatchObject({
      code: "COMMAND_INPUT_INVALID",
    });
    expect(callsOf(fake.calls, "complianceCheckException", "create")).toHaveLength(0);
  });
});

describe("AcceptCheckException — evidence quality guards", () => {
  it("refuses a justification too short to be evidence", async () => {
    const fake = buildPrismaFake();
    wire(fake.client);

    // Someone reads this aloud in an audit. "n/a" defeats the only
    // part of the record a human actually consults.
    await expect(run({ ...validInput, justification: "n/a" })).rejects.toMatchObject({
      code: "COMMAND_INPUT_INVALID",
    });
    expect(callsOf(fake.calls, "complianceCheckException", "create")).toHaveLength(0);
  });

  it("refuses a reason code outside the closed vocabulary", async () => {
    const fake = buildPrismaFake();
    wire(fake.client);

    // The vocabulary is what makes exceptions countable by kind. Free
    // text here would leave a reviewer unable to tell a broken probe
    // from an accepted risk.
    await expect(run({ ...validInput, reasonCode: "BECAUSE_I_SAID_SO" })).rejects.toMatchObject({
      code: "COMMAND_INPUT_INVALID",
    });
    expect(callsOf(fake.calls, "complianceCheckException", "create")).toHaveLength(0);
  });

  it("rejects an unknown check code without writing anything", async () => {
    const fake = buildPrismaFake({ check: null });
    wire(fake.client);

    await expect(run()).rejects.toMatchObject({ code: COMPLIANCE_CHECK_NOT_FOUND });
    expect(callsOf(fake.calls, "complianceCheckException", "create")).toHaveLength(0);
    expect(outboxRowsOf(fake.calls)).toHaveLength(0);
  });

  it("rejects unknown input fields", async () => {
    const fake = buildPrismaFake();
    wire(fake.client);

    await expect(run({ ...validInput, renews: true })).rejects.toMatchObject({
      code: "COMMAND_INPUT_INVALID",
    });
  });
});

describe("AcceptCheckException — who may accept", () => {
  it("refuses an actor without COMPLIANCE_EXCEPTION_ACCEPT and leaves no trace", async () => {
    const fake = buildPrismaFake();
    wire(fake.client, [
      {
        roleScope: RoleScope.ORGANIZATION,
        grantScope: { siteId: null, clinicId: null, teamId: null },
        permissions: new Set([PERMISSIONS.COMPLIANCE_CONTROL_PLANE_VIEW]),
      },
    ]);

    // This permission is the ability to silence a finding. Granting
    // it by accident is how a dashboard goes green without anyone
    // deciding it should.
    await expect(run()).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(callsOf(fake.calls, "complianceCheckException", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(0);
  });

  it("does not accept the control sign-off permission as a substitute", async () => {
    const fake = buildPrismaFake();
    wire(fake.client, [
      {
        roleScope: RoleScope.ORGANIZATION,
        grantScope: { siteId: null, clinicId: null, teamId: null },
        permissions: new Set([PERMISSIONS.COMPLIANCE_CONTROL_SIGN_OFF]),
      },
    ]);

    // Held apart on purpose: being able to attest to controls must
    // not carry the ability to silence the checks behind them.
    await expect(run()).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(callsOf(fake.calls, "complianceCheckException", "create")).toHaveLength(0);
  });
});

describe("AcceptCheckException — no renewal by stacking", () => {
  it("refuses a second exception while one is already live for the scope", async () => {
    const existingExpiry = new Date(NOW.getTime() + 10 * DAY_MS);
    const fake = buildPrismaFake({
      check: {
        ...defaultCheck(),
        exceptions: [{ id: "44440000-4444-4444-8444-000000000002", expiresAt: existingExpiry }],
      },
    });
    wire(fake.client);

    // Stacking moves the effective expiry without anyone revoking the
    // first exception — renewal under another name, and exactly the
    // drift the capped window exists to prevent. The refusal forces a
    // revoke, which leaves the original on the record as evidence of
    // how long the condition was really tolerated.
    await expect(run()).rejects.toMatchObject({
      code: COMPLIANCE_EXCEPTION_ALREADY_ACTIVE,
      metadata: expect.objectContaining({
        existingExceptionId: "44440000-4444-4444-8444-000000000002",
        existingExpiresAt: existingExpiry.toISOString(),
      }),
    });
    expect(callsOf(fake.calls, "complianceCheckException", "create")).toHaveLength(0);
    expect(outboxRowsOf(fake.calls)).toHaveLength(0);
  });

  it("looks for live exceptions in the same subject scope only", async () => {
    const fake = buildPrismaFake();
    wire(fake.client);

    await run();

    // The filter runs in the query, so this is the only place it is
    // observable. Dropping the subject bound would let one tenant's
    // exception block another's request; dropping the expiry or
    // revoked bound would let a lapsed or withdrawn exception keep
    // standing in for a live one.
    const lookup = callsOf(fake.calls, "complianceCheck", "findUnique")[0];
    const args = lookup!.args as {
      select: { exceptions: { where: Record<string, unknown> } };
    };
    expect(args.select.exceptions.where).toEqual({
      revokedAt: null,
      expiresAt: { gt: NOW },
      subjectOrganizationId: SUBJECT_ORG_ID,
    });
  });
});

describe("AcceptCheckException — idempotency", () => {
  it("replays a retried acceptance instead of creating a second exception", async () => {
    const fake = buildPrismaFake({ persistIdempotency: true });
    wire(fake.client);

    const first = await run(validInput, "exc-replay");
    const second = await run(validInput, "exc-replay");

    // A retried HTTP attempt must not leave two live exceptions for
    // one finding — the duplicate guard would then block the next
    // legitimate acceptance and the timeline would overstate how many
    // times the risk was accepted.
    expect(second).toEqual(first);
    expect(callsOf(fake.calls, "complianceCheckException", "create")).toHaveLength(1);
    expect(outboxRowsOf(fake.calls)).toHaveLength(1);
  });

  it("refuses a reused key carrying a DIFFERENT justification", async () => {
    const fake = buildPrismaFake({ persistIdempotency: true });
    wire(fake.client);

    await run(validInput, "exc-clash");

    // Replaying the first response would report the second, differently
    // justified acceptance as recorded when nothing was written.
    await expect(
      run(
        {
          ...validInput,
          justification: "Superseded rationale that was never actually persisted anywhere.",
        },
        "exc-clash"
      )
    ).rejects.toMatchObject({ code: "COMMAND_IDEMPOTENCY_PAYLOAD_MISMATCH" });
    expect(callsOf(fake.calls, "complianceCheckException", "create")).toHaveLength(1);
  });
});
