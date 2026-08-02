// Provider-onboarding command family contract tests (ADR-0033).
//
// Invariants asserted across the four commands:
//
//   1. Submit pins the ACTIVE provider.onboarding policy id +
//      version on the row and refuses roster-duplicate NPIs and
//      open-application duplicates with TYPED conflicts.
//   2. Proofing PASS auto-approves: roster row + APPROVED update +
//      BOTH events (onboarding.approved + provider.registered) in
//      one transaction, with decidedByUserId null.
//   3. Proofing PASS downgrades to ALREADY_REGISTERED →
//      NEEDS_REVIEW when the roster slot got taken in the window.
//   4. Non-PASS outcomes route to NEEDS_REVIEW with the evidence
//      snapshot and emit review_required.
//   5. Approve/Reject are review-permission-gated, require
//      NEEDS_REVIEW state, and stamp the deciding user + reason.
//
// All identifiers and names below are synthetic.

import { afterEach, describe, expect, it, vi } from "vitest";

import { clock, logger } from "@pharmax/platform-core";
import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type PermissionCode,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { Prisma, RoleScope } from "@pharmax/database";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";

import { ApproveProviderOnboardingApplication } from "./approve-application.js";
import { RecordProviderOnboardingProofing } from "./record-proofing.js";
import { RejectProviderOnboardingApplication } from "./reject-application.js";
import { SubmitProviderOnboardingApplication } from "./submit-application.js";

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const MACHINE_USER_ID = "33333333-3333-4333-8333-333333333333";
const REVIEWER_USER_ID = "44444444-4444-4444-8444-444444444444";
const APPLICATION_ID = "55555555-5555-4555-8555-555555555555";
const POLICY_ID = "66666666-6666-4666-8666-666666666666";

function grantsWith(perms: ReadonlyArray<PermissionCode>): ReadonlyArray<ResolvedGrant> {
  return [
    {
      roleScope: RoleScope.ORGANIZATION,
      grantScope: { siteId: null, clinicId: null, teamId: null },
      permissions: new Set(perms),
    },
  ];
}

function machineCtx() {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: MACHINE_USER_ID, correlationId: "01CORRELATION0000000000000" },
  });
}

function reviewerCtx() {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: REVIEWER_USER_ID, correlationId: "01CORRELATION0000000000001" },
  });
}

const SUBMITTED_APP = {
  id: APPLICATION_ID,
  status: "SUBMITTED",
  npi: "1234567893",
  firstName: "Aisha",
  lastName: "Patel",
  credential: "MD",
  email: "a.patel@example-practice.test",
  phone: null,
  proofingOutcome: null,
};

// ---------------------------------------------------------------------
// Fake Prisma
// ---------------------------------------------------------------------

interface FakeCall {
  table: string;
  op: string;
  args: unknown;
}

interface FakePrismaOptions {
  /** Result of workflowPolicy.findUnique. */
  policyRow?: { id: string; version: number; status: string } | null;
  /** Result of provider.findUnique (roster check). */
  existingProvider?: { id: string } | null;
  /** Result of providerOnboardingApplication.findUnique. */
  applicationRow?: Record<string, unknown> | null;
  /** When set, providerOnboardingApplication.create throws. */
  applicationCreateError?: Error;
  /** Result of portalAccount.findUnique (email-conflict check). */
  existingPortalAccount?: { id: string } | null;
}

function buildFakePrisma(opts: FakePrismaOptions = {}): { client: unknown; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const record = (table: string, op: string) =>
    vi.fn(async (args: unknown) => {
      calls.push({ table, op, args });
      return { id: `${table}-1` };
    });

  const tx = {
    workflowPolicy: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "workflowPolicy", op: "findUnique", args });
        return opts.policyRow === undefined
          ? { id: POLICY_ID, version: 1, status: "ACTIVE" }
          : opts.policyRow;
      }),
    },
    provider: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "provider", op: "findUnique", args });
        return opts.existingProvider ?? null;
      }),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "provider", op: "create", args });
        return (args as { data: { id: string } }).data;
      }),
    },
    portalAccount: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "portalAccount", op: "findUnique", args });
        return opts.existingPortalAccount ?? null;
      }),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "portalAccount", op: "create", args });
        return { id: (args as { data: { id: string } }).data.id };
      }),
    },
    providerOnboardingApplication: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "providerOnboardingApplication", op: "findUnique", args });
        return opts.applicationRow === undefined ? SUBMITTED_APP : opts.applicationRow;
      }),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "providerOnboardingApplication", op: "create", args });
        if (opts.applicationCreateError !== undefined) throw opts.applicationCreateError;
        return (args as { data: { id: string } }).data;
      }),
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "providerOnboardingApplication", op: "update", args });
        return { id: APPLICATION_ID };
      }),
    },
    commandLog: {
      create: record("commandLog", "create"),
      update: record("commandLog", "update"),
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "findUnique", args });
        return null;
      }),
    },
    auditLog: { create: record("auditLog", "create") },
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
        return { count: (args as { data: unknown[] }).data.length };
      }),
    },
    idempotencyKey: {
      create: record("idempotencyKey", "create"),
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "idempotencyKey", op: "findUnique", args });
        return null;
      }),
    },
    $executeRaw: vi.fn(async (template: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ table: "$executeRaw", op: "raw", args: { sql: template.join("?"), values } });
      return 0;
    }),
  };

  const client = {
    commandLog: {
      create: record("commandLog", "create"),
      update: record("commandLog", "update"),
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

function callsOf(calls: FakeCall[], table: string, op: string): FakeCall[] {
  return calls.filter((c) => c.table === table && c.op === op);
}

function outboxTypesOf(calls: FakeCall[]): string[] {
  return callsOf(calls, "eventOutbox", "createMany").flatMap((c) =>
    (c.args as { data: Array<{ eventType: string }> }).data.map((d) => d.eventType)
  );
}

function wire(client: unknown, perms: ReadonlyArray<PermissionCode>, userId: string): void {
  configureCommandBus({
    prisma: client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(new Date("2026-07-31T12:00:00.000Z")),
    logger: logger.noopLogger,
  });
  configureRbac({
    loader: new InMemoryPermissionLoader([
      { organizationId: ORG_ID, userId, grants: grantsWith(perms) },
    ]),
  });
}

afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
});

// ---------------------------------------------------------------------
// SubmitProviderOnboardingApplication
// ---------------------------------------------------------------------

describe("SubmitProviderOnboardingApplication", () => {
  const INPUT = {
    npi: "1234567893",
    firstName: "Aisha",
    lastName: "Patel",
    credential: "MD",
    email: "a.patel@example-practice.test",
  };

  it("creates a SUBMITTED row pinned to the active policy and emits submitted.v1", async () => {
    const fake = buildFakePrisma();
    wire(fake.client, [PERMISSIONS.PROVIDERS_ONBOARDING_SUBMIT], MACHINE_USER_ID);

    const out = await withTenancyContext(machineCtx(), () =>
      executeCommand(SubmitProviderOnboardingApplication, INPUT, { idempotencyKey: "submit-1" })
    );

    expect(out.status).toBe("SUBMITTED");
    const create = callsOf(fake.calls, "providerOnboardingApplication", "create")[0]!;
    const data = (create.args as { data: Record<string, unknown> }).data;
    expect(data["workflowPolicyId"]).toBe(POLICY_ID);
    expect(data["workflowPolicyVersion"]).toBe(1);
    expect(data["status"]).toBe("SUBMITTED");
    expect(outboxTypesOf(fake.calls)).toEqual(["provider.onboarding.submitted.v1"]);
  });

  it("409s a roster-duplicate NPI with a typed conflict", async () => {
    const fake = buildFakePrisma({ existingProvider: { id: "prov-1" } });
    wire(fake.client, [PERMISSIONS.PROVIDERS_ONBOARDING_SUBMIT], MACHINE_USER_ID);

    await expect(
      withTenancyContext(machineCtx(), () =>
        executeCommand(SubmitProviderOnboardingApplication, INPUT, { idempotencyKey: "submit-2" })
      )
    ).rejects.toMatchObject({ code: "PROVIDER_ONBOARDING_NPI_ALREADY_REGISTERED" });
  });

  it("translates the open-application partial-unique P2002 to a typed conflict", async () => {
    const realP2002 = new Prisma.PrismaClientKnownRequestError("unique violation", {
      code: "P2002",
      clientVersion: "test",
    });
    const fake = buildFakePrisma({ applicationCreateError: realP2002 });
    wire(fake.client, [PERMISSIONS.PROVIDERS_ONBOARDING_SUBMIT], MACHINE_USER_ID);

    await expect(
      withTenancyContext(machineCtx(), () =>
        executeCommand(SubmitProviderOnboardingApplication, INPUT, { idempotencyKey: "submit-3" })
      )
    ).rejects.toMatchObject({ code: "PROVIDER_ONBOARDING_ALREADY_OPEN" });
  });

  it("fails typed when the provider.onboarding policy is missing", async () => {
    const fake = buildFakePrisma({ policyRow: null });
    wire(fake.client, [PERMISSIONS.PROVIDERS_ONBOARDING_SUBMIT], MACHINE_USER_ID);

    await expect(
      withTenancyContext(machineCtx(), () =>
        executeCommand(SubmitProviderOnboardingApplication, INPUT, { idempotencyKey: "submit-4" })
      )
    ).rejects.toMatchObject({ code: "PROVIDER_ONBOARDING_POLICY_NOT_FOUND" });
  });

  it("denies actors without providers.onboarding.submit", async () => {
    const fake = buildFakePrisma();
    wire(fake.client, [PERMISSIONS.PROVIDERS_READ], MACHINE_USER_ID);

    await expect(
      withTenancyContext(machineCtx(), () =>
        executeCommand(SubmitProviderOnboardingApplication, INPUT, { idempotencyKey: "submit-5" })
      )
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
});

// ---------------------------------------------------------------------
// RecordProviderOnboardingProofing
// ---------------------------------------------------------------------

describe("RecordProviderOnboardingProofing", () => {
  const SNAPSHOT = { npi: "1234567893", status: "A", lastName: "Patel" };

  it("PASS auto-approves: roster row + APPROVED + both events, decidedBy null", async () => {
    const fake = buildFakePrisma();
    wire(fake.client, [PERMISSIONS.PROVIDERS_ONBOARDING_SUBMIT], MACHINE_USER_ID);

    const out = await withTenancyContext(machineCtx(), () =>
      executeCommand(
        RecordProviderOnboardingProofing,
        { applicationId: APPLICATION_ID, outcome: "PASS", snapshot: SNAPSHOT },
        { idempotencyKey: "proof-pass-1" }
      )
    );

    expect(out.status).toBe("APPROVED");
    expect(out.providerId).not.toBeNull();
    expect(out.portalAccountId).not.toBeNull();

    const providerCreate = callsOf(fake.calls, "provider", "create")[0]!;
    const providerData = (providerCreate.args as { data: Record<string, unknown> }).data;
    expect(providerData["npi"]).toBe("1234567893");
    expect(providerData["status"]).toBe("ACTIVE");

    // Portal credential slot provisioned atomically with the roster row
    // (ADR-0033 slice 2): PENDING_SETUP, no password.
    const portalCreate = callsOf(fake.calls, "portalAccount", "create")[0]!;
    const portalData = (portalCreate.args as { data: Record<string, unknown> }).data;
    expect(portalData["email"]).toBe("a.patel@example-practice.test");
    expect(portalData["hashedPassword"]).toBeUndefined();

    const update = callsOf(fake.calls, "providerOnboardingApplication", "update")[0]!;
    const updateData = (update.args as { data: Record<string, unknown> }).data;
    expect(updateData["status"]).toBe("APPROVED");
    expect(updateData["proofingOutcome"]).toBe("PASS");
    expect(updateData["decidedByUserId"]).toBeUndefined();

    const types = outboxTypesOf(fake.calls);
    expect(types).toContain("provider.onboarding.approved.v1");
    expect(types).toContain("provider.registered.v1");
    expect(types).toContain("provider.portal_account.provisioned.v1");

    const outboxRows = callsOf(fake.calls, "eventOutbox", "createMany").flatMap(
      (c) =>
        (c.args as { data: Array<{ eventType: string; payload: Record<string, unknown> }> }).data
    );
    const approved = outboxRows.find((r) => r.eventType === "provider.onboarding.approved.v1")!;
    expect(approved.payload["autoApproved"]).toBe(true);
    expect(approved.payload["decidedByUserId"]).toBeNull();
  });

  it("downgrades PASS to ALREADY_REGISTERED → NEEDS_REVIEW when the roster slot is taken", async () => {
    const fake = buildFakePrisma({ existingProvider: { id: "prov-1" } });
    wire(fake.client, [PERMISSIONS.PROVIDERS_ONBOARDING_SUBMIT], MACHINE_USER_ID);

    const out = await withTenancyContext(machineCtx(), () =>
      executeCommand(
        RecordProviderOnboardingProofing,
        { applicationId: APPLICATION_ID, outcome: "PASS", snapshot: SNAPSHOT },
        { idempotencyKey: "proof-pass-2" }
      )
    );

    expect(out.status).toBe("NEEDS_REVIEW");
    expect(out.proofingOutcome).toBe("ALREADY_REGISTERED");
    expect(callsOf(fake.calls, "provider", "create")).toHaveLength(0);
    expect(outboxTypesOf(fake.calls)).toEqual(["provider.onboarding.review_required.v1"]);
  });

  it("routes NAME_MISMATCH to NEEDS_REVIEW with the evidence snapshot", async () => {
    const fake = buildFakePrisma();
    wire(fake.client, [PERMISSIONS.PROVIDERS_ONBOARDING_SUBMIT], MACHINE_USER_ID);

    const out = await withTenancyContext(machineCtx(), () =>
      executeCommand(
        RecordProviderOnboardingProofing,
        { applicationId: APPLICATION_ID, outcome: "NAME_MISMATCH", snapshot: SNAPSHOT },
        { idempotencyKey: "proof-mismatch-1" }
      )
    );

    expect(out.status).toBe("NEEDS_REVIEW");
    const update = callsOf(fake.calls, "providerOnboardingApplication", "update")[0]!;
    const updateData = (update.args as { data: Record<string, unknown> }).data;
    expect(updateData["status"]).toBe("NEEDS_REVIEW");
    expect(updateData["proofingOutcome"]).toBe("NAME_MISMATCH");
    expect(updateData["proofingSnapshot"]).toEqual(SNAPSHOT);
    expect(outboxTypesOf(fake.calls)).toEqual(["provider.onboarding.review_required.v1"]);
  });

  it("409s a non-SUBMITTED application (benign worker race)", async () => {
    const fake = buildFakePrisma({
      applicationRow: { ...SUBMITTED_APP, status: "NEEDS_REVIEW" },
    });
    wire(fake.client, [PERMISSIONS.PROVIDERS_ONBOARDING_SUBMIT], MACHINE_USER_ID);

    await expect(
      withTenancyContext(machineCtx(), () =>
        executeCommand(
          RecordProviderOnboardingProofing,
          { applicationId: APPLICATION_ID, outcome: "PASS" },
          { idempotencyKey: "proof-race-1" }
        )
      )
    ).rejects.toMatchObject({ code: "PROVIDER_ONBOARDING_INVALID_STATE" });
  });
});

// ---------------------------------------------------------------------
// Approve / Reject (human review decisions)
// ---------------------------------------------------------------------

describe("ApproveProviderOnboardingApplication", () => {
  const NEEDS_REVIEW_APP = {
    ...SUBMITTED_APP,
    status: "NEEDS_REVIEW",
    proofingOutcome: "NAME_MISMATCH",
  };

  it("approves from NEEDS_REVIEW: roster row + reviewer stamp + both events", async () => {
    const fake = buildFakePrisma({ applicationRow: NEEDS_REVIEW_APP });
    wire(fake.client, [PERMISSIONS.PROVIDERS_ONBOARDING_REVIEW], REVIEWER_USER_ID);

    const out = await withTenancyContext(reviewerCtx(), () =>
      executeCommand(
        ApproveProviderOnboardingApplication,
        { applicationId: APPLICATION_ID, reasonCode: "IDENTITY_VERIFIED_OFFLINE" },
        { idempotencyKey: "approve-1" }
      )
    );

    expect(out.status).toBe("APPROVED");
    expect(out.portalAccountId).not.toBeNull();
    const update = callsOf(fake.calls, "providerOnboardingApplication", "update")[0]!;
    const updateData = (update.args as { data: Record<string, unknown> }).data;
    expect(updateData["decidedByUserId"]).toBe(REVIEWER_USER_ID);
    expect(updateData["decisionReasonCode"]).toBe("IDENTITY_VERIFIED_OFFLINE");

    const types = outboxTypesOf(fake.calls);
    expect(types).toContain("provider.onboarding.approved.v1");
    expect(types).toContain("provider.registered.v1");
    expect(types).toContain("provider.portal_account.provisioned.v1");

    const outboxRows = callsOf(fake.calls, "eventOutbox", "createMany").flatMap(
      (c) =>
        (c.args as { data: Array<{ eventType: string; payload: Record<string, unknown> }> }).data
    );
    const approved = outboxRows.find((r) => r.eventType === "provider.onboarding.approved.v1")!;
    expect(approved.payload["autoApproved"]).toBe(false);
    expect(approved.payload["decidedByUserId"]).toBe(REVIEWER_USER_ID);
  });

  it("still approves when the portal email is taken — provisioning is skipped, not fatal", async () => {
    const fake = buildFakePrisma({
      applicationRow: NEEDS_REVIEW_APP,
      existingPortalAccount: { id: "portal-1" },
    });
    wire(fake.client, [PERMISSIONS.PROVIDERS_ONBOARDING_REVIEW], REVIEWER_USER_ID);

    const out = await withTenancyContext(reviewerCtx(), () =>
      executeCommand(
        ApproveProviderOnboardingApplication,
        { applicationId: APPLICATION_ID, reasonCode: "IDENTITY_VERIFIED_OFFLINE" },
        { idempotencyKey: "approve-email-taken-1" }
      )
    );

    expect(out.status).toBe("APPROVED");
    expect(out.portalAccountId).toBeNull();
    expect(callsOf(fake.calls, "portalAccount", "create")).toHaveLength(0);
    expect(outboxTypesOf(fake.calls)).not.toContain("provider.portal_account.provisioned.v1");
  });

  it("409s when the roster slot is already taken", async () => {
    const fake = buildFakePrisma({
      applicationRow: NEEDS_REVIEW_APP,
      existingProvider: { id: "prov-1" },
    });
    wire(fake.client, [PERMISSIONS.PROVIDERS_ONBOARDING_REVIEW], REVIEWER_USER_ID);

    await expect(
      withTenancyContext(reviewerCtx(), () =>
        executeCommand(
          ApproveProviderOnboardingApplication,
          { applicationId: APPLICATION_ID, reasonCode: "IDENTITY_VERIFIED_OFFLINE" },
          { idempotencyKey: "approve-2" }
        )
      )
    ).rejects.toMatchObject({ code: "PROVIDER_ONBOARDING_NPI_ALREADY_REGISTERED" });
  });

  it("409s a SUBMITTED application (review applies to NEEDS_REVIEW only)", async () => {
    const fake = buildFakePrisma();
    wire(fake.client, [PERMISSIONS.PROVIDERS_ONBOARDING_REVIEW], REVIEWER_USER_ID);

    await expect(
      withTenancyContext(reviewerCtx(), () =>
        executeCommand(
          ApproveProviderOnboardingApplication,
          { applicationId: APPLICATION_ID, reasonCode: "IDENTITY_VERIFIED_OFFLINE" },
          { idempotencyKey: "approve-3" }
        )
      )
    ).rejects.toMatchObject({ code: "PROVIDER_ONBOARDING_INVALID_STATE" });
  });

  it("denies the machine submit permission (SoD between pipeline and review)", async () => {
    const fake = buildFakePrisma({ applicationRow: NEEDS_REVIEW_APP });
    wire(fake.client, [PERMISSIONS.PROVIDERS_ONBOARDING_SUBMIT], MACHINE_USER_ID);

    await expect(
      withTenancyContext(machineCtx(), () =>
        executeCommand(
          ApproveProviderOnboardingApplication,
          { applicationId: APPLICATION_ID, reasonCode: "IDENTITY_VERIFIED_OFFLINE" },
          { idempotencyKey: "approve-4" }
        )
      )
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
});

describe("RejectProviderOnboardingApplication", () => {
  const NEEDS_REVIEW_APP = {
    ...SUBMITTED_APP,
    status: "NEEDS_REVIEW",
    proofingOutcome: "NOT_FOUND",
  };

  it("rejects from NEEDS_REVIEW with reviewer stamp + reason and emits rejected.v1", async () => {
    const fake = buildFakePrisma({ applicationRow: NEEDS_REVIEW_APP });
    wire(fake.client, [PERMISSIONS.PROVIDERS_ONBOARDING_REVIEW], REVIEWER_USER_ID);

    const out = await withTenancyContext(reviewerCtx(), () =>
      executeCommand(
        RejectProviderOnboardingApplication,
        { applicationId: APPLICATION_ID, reasonCode: "NPI_NOT_FOUND_AT_CMS" },
        { idempotencyKey: "reject-1" }
      )
    );

    expect(out.status).toBe("REJECTED");
    const update = callsOf(fake.calls, "providerOnboardingApplication", "update")[0]!;
    const updateData = (update.args as { data: Record<string, unknown> }).data;
    expect(updateData["status"]).toBe("REJECTED");
    expect(updateData["decidedByUserId"]).toBe(REVIEWER_USER_ID);
    expect(updateData["decisionReasonCode"]).toBe("NPI_NOT_FOUND_AT_CMS");

    const outboxRows = callsOf(fake.calls, "eventOutbox", "createMany").flatMap(
      (c) =>
        (c.args as { data: Array<{ eventType: string; payload: Record<string, unknown> }> }).data
    );
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]!.eventType).toBe("provider.onboarding.rejected.v1");
    expect(outboxRows[0]!.payload["reasonCode"]).toBe("NPI_NOT_FOUND_AT_CMS");
    expect(outboxRows[0]!.payload["decidedByUserId"]).toBe(REVIEWER_USER_ID);
  });

  it("409s an APPROVED application", async () => {
    const fake = buildFakePrisma({
      applicationRow: { ...SUBMITTED_APP, status: "APPROVED" },
    });
    wire(fake.client, [PERMISSIONS.PROVIDERS_ONBOARDING_REVIEW], REVIEWER_USER_ID);

    await expect(
      withTenancyContext(reviewerCtx(), () =>
        executeCommand(
          RejectProviderOnboardingApplication,
          { applicationId: APPLICATION_ID, reasonCode: "DUPLICATE" },
          { idempotencyKey: "reject-2" }
        )
      )
    ).rejects.toMatchObject({ code: "PROVIDER_ONBOARDING_INVALID_STATE" });
  });
});
