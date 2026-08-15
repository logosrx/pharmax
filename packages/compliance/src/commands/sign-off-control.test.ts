// SignOffControl contract tests.
//
// This command produces SOC 2 evidence: a named person attesting that
// a control is designed and operating. Two properties make that
// evidence worth anything, and both are tested here — the signature
// carries who signed and when, and the platform refuses to let anyone
// sign a claim its own probe history contradicts.
//
// Surface:
//   - Attestation: actor id + signing time + attested status land on
//     the control and in the evidence record.
//   - RBAC: COMPLIANCE_CONTROL_SIGN_OFF is required, and no adjacent
//     compliance permission substitutes for it.
//   - Failing-check guard: FAIL/ERROR on an enabled, unexcepted check
//     blocks; a disabled check or an active exception does not.
//   - Exception cover is limited to live exceptions (not revoked,
//     not expired).
//   - Unknown control code is refused.
//   - Idempotency: a retried sign-off replays rather than stamping a
//     second attestation.

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
  COMPLIANCE_CONTROL_HAS_FAILING_CHECKS,
  COMPLIANCE_CONTROL_NOT_FOUND,
  SignOffControl,
} from "./sign-off-control.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000009";
const CONTROL_ID = "22220000-2222-4222-8222-000000000001";
const CONTROL_CODE = "CC6.1-2";

const NOW = new Date("2026-06-01T12:00:00.000Z");

const signerGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.COMPLIANCE_CONTROL_SIGN_OFF]),
  },
];

interface FakeCheck {
  id: string;
  code: string;
  lastOutcome: string | null;
  enabled: boolean;
  exceptions: Array<{ id: string }>;
}

interface FakeControl {
  id: string;
  code: string;
  ownerRole: string;
  checks: Array<{ check: FakeCheck }>;
}

interface FakeOverrides {
  control?: FakeControl | null;
  persistIdempotency?: boolean;
}

interface FakeCall {
  readonly table: string;
  readonly op: string;
  readonly args: unknown;
}

const passingCheck = (): FakeCheck => ({
  id: "33330000-3333-4333-8333-000000000001",
  code: "identity.mfa-elevated-role-enrollment",
  lastOutcome: "PASS",
  enabled: true,
  exceptions: [],
});

const defaultControl = (): FakeControl => ({
  id: CONTROL_ID,
  code: CONTROL_CODE,
  ownerRole: "SECURITY_OFFICER",
  checks: [{ check: passingCheck() }],
});

function buildPrismaFake(overrides: FakeOverrides = {}): {
  client: unknown;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const push = (table: string, op: string, args: unknown): void => {
    calls.push({ table, op, args });
  };
  const control = overrides.control === undefined ? defaultControl() : overrides.control;

  // Keyed the way the real unique constraint is, so a key reused
  // across two commands does not collide in the fake when it would
  // not collide in Postgres.
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
    complianceControl: {
      findUnique: vi.fn(async (args: unknown) => {
        push("complianceControl", "findUnique", args);
        return control;
      }),
      update: vi.fn(async (args: unknown) => {
        push("complianceControl", "update", args);
        return { id: CONTROL_ID };
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

function wire(client: unknown, grants: ReadonlyArray<ResolvedGrant> = signerGrants): void {
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

function updateDataOf(calls: FakeCall[]): Record<string, unknown> {
  const update = callsOf(calls, "complianceControl", "update")[0];
  if (update === undefined) throw new Error("expected a control update");
  return (update.args as { data: Record<string, unknown> }).data;
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

const validInput = {
  controlCode: CONTROL_CODE,
  status: "IMPLEMENTED" as const,
  attestationNote: "Quarterly review completed against the access-review export.",
};

const run = (input: unknown = validInput, idempotencyKey = "sign-1") =>
  withTenancyContext(ctxFor(), () => executeCommand(SignOffControl, input, { idempotencyKey }));

beforeEach(() => {
  const fake = buildPrismaFake();
  wire(fake.client);
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
});

describe("SignOffControl — the attestation record", () => {
  it("names the signer and the moment of signature", async () => {
    const fake = buildPrismaFake();
    wire(fake.client);

    const out = await run();

    // An attestation nobody signed is not an attestation. If either
    // stamp went missing the row would still look attested, and an
    // auditor asking "who says so, and as of when?" would have no
    // answer at all.
    expect(out).toMatchObject({
      controlId: CONTROL_ID,
      controlCode: CONTROL_CODE,
      status: "IMPLEMENTED",
      signedOffByUserId: USER_ID,
      signedOffAt: NOW.toISOString(),
    });

    const data = updateDataOf(fake.calls);
    expect(data["lastSignedOffByUserId"]).toBe(USER_ID);
    expect(data["lastSignedOffAt"]).toEqual(NOW);
    expect(data["status"]).toBe("IMPLEMENTED");
  });

  it("keeps the attested status and the note verbatim in the evidence", async () => {
    const fake = buildPrismaFake();
    wire(fake.client);

    await run({ ...validInput, status: "PARTIAL" });

    // The note is the part a human reads back during an audit; it is
    // deliberately not redacted, so it must survive intact.
    const audit = auditDataOf(fake.calls);
    expect(audit.action).toBe("compliance.control.signed_off");
    expect(audit.metadata).toMatchObject({
      controlCode: CONTROL_CODE,
      status: "PARTIAL",
      ownerRole: "SECURITY_OFFICER",
      attestationNote: validInput.attestationNote,
    });
  });

  it("reports how much evidence stood behind the signature", async () => {
    const fake = buildPrismaFake({
      control: {
        ...defaultControl(),
        checks: [
          { check: passingCheck() },
          { check: { ...passingCheck(), id: "c2", code: "audit.chain-head", lastOutcome: null } },
        ],
      },
    });
    wire(fake.client);

    const out = await run();

    // "Signed with 2 linked checks, 1 passing" is a materially
    // different claim from "signed with 2 of 2 passing", and the
    // counts are what let a reviewer tell them apart later.
    expect(out.linkedCheckCount).toBe(2);
    expect(out.passingCheckCount).toBe(1);
    expect(auditDataOf(fake.calls).metadata).toMatchObject({
      linkedCheckCount: 2,
      passingCheckCount: 1,
    });
  });

  it("emits compliance.control.signed_off.v1 with the signer attached", async () => {
    const fake = buildPrismaFake();
    wire(fake.client);

    await run();

    const rows = outboxRowsOf(fake.calls);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe("compliance.control.signed_off.v1");
    expect(rows[0]?.payload).toMatchObject({
      controlId: CONTROL_ID,
      controlCode: CONTROL_CODE,
      organizationId: ORG_ID,
      signedOffByUserId: USER_ID,
      signedOffAt: NOW.toISOString(),
    });
  });

  it("records a null note rather than inventing one when the signer wrote nothing", async () => {
    const fake = buildPrismaFake();
    wire(fake.client);

    await run({ controlCode: CONTROL_CODE, status: "IMPLEMENTED" });

    expect(auditDataOf(fake.calls).metadata["attestationNote"]).toBeNull();
  });
});

describe("SignOffControl — who may sign", () => {
  it("refuses an actor without COMPLIANCE_CONTROL_SIGN_OFF and leaves no trace", async () => {
    const fake = buildPrismaFake();
    wire(fake.client, [
      {
        roleScope: RoleScope.ORGANIZATION,
        grantScope: { siteId: null, clinicId: null, teamId: null },
        permissions: new Set([PERMISSIONS.COMPLIANCE_CONTROL_PLANE_VIEW]),
      },
    ]);

    // The signature is the evidence. If any authenticated actor could
    // write one, the control row would record an attestation nobody
    // accountable actually made.
    await expect(run()).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(callsOf(fake.calls, "complianceControl", "update")).toHaveLength(0);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(0);
    expect(outboxRowsOf(fake.calls)).toHaveLength(0);
  });

  it("does not accept the exception-accept permission as a substitute", async () => {
    const fake = buildPrismaFake();
    wire(fake.client, [
      {
        roleScope: RoleScope.ORGANIZATION,
        grantScope: { siteId: null, clinicId: null, teamId: null },
        permissions: new Set([PERMISSIONS.COMPLIANCE_EXCEPTION_ACCEPT]),
      },
    ]);

    // Silencing a finding and attesting that a control operates are
    // separate acts, granted separately on purpose.
    await expect(run()).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(callsOf(fake.calls, "complianceControl", "update")).toHaveLength(0);
  });
});

describe("SignOffControl — the failing-check guard", () => {
  it("refuses to attest while a linked check is failing", async () => {
    const fake = buildPrismaFake({
      control: {
        ...defaultControl(),
        checks: [{ check: { ...passingCheck(), lastOutcome: "FAIL" } }],
      },
    });
    wire(fake.client);

    // A signed claim sitting next to run history that contradicts it
    // is worse for an audit than an unsigned control: it shows the
    // attestation process does not look at the evidence.
    await expect(run()).rejects.toMatchObject({
      code: COMPLIANCE_CONTROL_HAS_FAILING_CHECKS,
      metadata: expect.objectContaining({
        blockingCheckCodes: ["identity.mfa-elevated-role-enrollment"],
      }),
    });
    expect(callsOf(fake.calls, "complianceControl", "update")).toHaveLength(0);
    expect(outboxRowsOf(fake.calls)).toHaveLength(0);
  });

  it("treats a probe that ERRORed as blocking, not as absent evidence", async () => {
    const fake = buildPrismaFake({
      control: {
        ...defaultControl(),
        checks: [{ check: { ...passingCheck(), lastOutcome: "ERROR" } }],
      },
    });
    wire(fake.client);

    // A probe that could not run has not shown the control working.
    // Reading ERROR as "not a FAIL" would let an outage become a
    // clean bill of health.
    await expect(run()).rejects.toMatchObject({
      code: COMPLIANCE_CONTROL_HAS_FAILING_CHECKS,
    });
  });

  it("permits attestation once a live exception covers the failing check", async () => {
    const fake = buildPrismaFake({
      control: {
        ...defaultControl(),
        checks: [
          {
            check: {
              ...passingCheck(),
              lastOutcome: "FAIL",
              exceptions: [{ id: "44440000-4444-4444-8444-000000000001" }],
            },
          },
        ],
      },
    });
    wire(fake.client);

    const out = await run();

    // The documented route forward: accept a justified, time-boxed
    // exception, then attest. Both acts stay on the record.
    expect(out.signedOffByUserId).toBe(USER_ID);
    expect(callsOf(fake.calls, "complianceControl", "update")).toHaveLength(1);
  });

  it("does not let a disabled check block attestation", async () => {
    const fake = buildPrismaFake({
      control: {
        ...defaultControl(),
        checks: [{ check: { ...passingCheck(), lastOutcome: "FAIL", enabled: false } }],
      },
    });
    wire(fake.client);

    const out = await run();

    expect(out.controlCode).toBe(CONTROL_CODE);
    // Disabled is a decision an operator already made and the
    // dashboard already shows; it is not counted as passing either.
    expect(out.passingCheckCount).toBe(0);
  });

  it("counts only exceptions that are neither revoked nor expired as cover", async () => {
    const fake = buildPrismaFake();
    wire(fake.client);

    await run();

    // The filter is applied in the query, so this is the only place
    // it is observable. If the expiry bound were dropped, a lapsed
    // exception would keep clearing sign-off forever — which is
    // exactly the permanent-exception drift the expiry exists to
    // prevent.
    const lookup = callsOf(fake.calls, "complianceControl", "findUnique")[0];
    const args = lookup!.args as {
      select: {
        checks: {
          select: { check: { select: { exceptions: { where: Record<string, unknown> } } } };
        };
      };
    };
    expect(args.select.checks.select.check.select.exceptions.where).toEqual({
      revokedAt: null,
      expiresAt: { gt: NOW },
    });
  });

  it("rejects an unknown control code without writing evidence", async () => {
    const fake = buildPrismaFake({ control: null });
    wire(fake.client);

    await expect(run()).rejects.toMatchObject({ code: COMPLIANCE_CONTROL_NOT_FOUND });
    expect(callsOf(fake.calls, "complianceControl", "update")).toHaveLength(0);
    expect(outboxRowsOf(fake.calls)).toHaveLength(0);
  });
});

describe("SignOffControl — repeat signatures", () => {
  it("replays a retried request instead of stamping a second attestation", async () => {
    const fake = buildPrismaFake({ persistIdempotency: true });
    wire(fake.client);

    const first = await run(validInput, "sign-replay");
    const second = await run(validInput, "sign-replay");

    // A retried HTTP attempt must not read as two separate
    // attestations of the same control on the evidence timeline.
    expect(second).toEqual(first);
    expect(callsOf(fake.calls, "complianceControl", "update")).toHaveLength(1);
    expect(outboxRowsOf(fake.calls)).toHaveLength(1);
  });

  it("refuses a reused key carrying a DIFFERENT attested status", async () => {
    const fake = buildPrismaFake({ persistIdempotency: true });
    wire(fake.client);

    await run(validInput, "sign-clash");

    // Replaying the first response for a second, different claim
    // would report a control as attested IMPLEMENTED when the signer
    // actually said DEPRECATED.
    await expect(run({ ...validInput, status: "DEPRECATED" }, "sign-clash")).rejects.toMatchObject({
      code: "COMMAND_IDEMPOTENCY_PAYLOAD_MISMATCH",
    });
    expect(callsOf(fake.calls, "complianceControl", "update")).toHaveLength(1);
  });

  it("permits re-attesting a control that is already signed off", async () => {
    // No state guard here, by design: periodic re-attestation is the
    // point, so a fresh key under a new signature is allowed to land
    // on a control that already carries one. Stating it plainly
    // because the control row keeps only the LATEST signer and time —
    // who attested before it survives on the audit chain alone.
    const fake = buildPrismaFake();
    wire(fake.client);

    await run(validInput, "sign-q1");
    await run({ ...validInput, status: "PARTIAL" }, "sign-q2");

    const updates = callsOf(fake.calls, "complianceControl", "update");
    expect(updates).toHaveLength(2);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(2);
    expect((updates[1]!.args as { data: Record<string, unknown> }).data["status"]).toBe("PARTIAL");
  });

  it("rejects unknown input fields", async () => {
    const fake = buildPrismaFake();
    wire(fake.client);

    await expect(run({ ...validInput, backdatedTo: "2020-01-01" })).rejects.toMatchObject({
      code: "COMMAND_INPUT_INVALID",
    });
  });
});
