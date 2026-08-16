// export-session-log tests.
//
// The point of this file is the thing EI-6 got wrong: an evidence
// script can look healthy while querying a table nothing writes. So
// these tests pin the two properties that would have caught it —
// that the exporter reads the tables the live identity engine writes
// (`auth_session`, `portal_session`), and that rows from BOTH reach
// the artifact — alongside the CSV shape and the PHI posture.
//
// All fixtures are synthetic.

import { describe, expect, it } from "vitest";

import {
  collectSessionEvidence,
  composeRevocationCsv,
  composeSessionLogCsv,
  createPrismaSessionEvidenceClient,
  currentQuarterLabel,
  type OperatorSessionRecord,
  type PortalSessionRecord,
  type SessionEvidenceClient,
  type SessionQuery,
} from "./export-session-log.js";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const USER_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const USER_2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const PORTAL_ACCOUNT_1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";

const FROM = new Date("2026-04-01T00:00:00.000Z");
const TO = new Date("2026-06-30T23:59:59.999Z");

function operatorSession(
  overrides: Partial<OperatorSessionRecord> & Pick<OperatorSessionRecord, "id">
): OperatorSessionRecord {
  return {
    organizationId: ORG_A,
    userId: USER_1,
    mfaSatisfied: true,
    createdAt: new Date("2026-04-10T09:00:00.000Z"),
    lastActivityAt: new Date("2026-04-10T17:00:00.000Z"),
    idleExpiresAt: new Date("2026-04-10T17:30:00.000Z"),
    absoluteExpiresAt: new Date("2026-04-11T09:00:00.000Z"),
    revokedAt: null,
    revokedReason: null,
    ...overrides,
  };
}

function portalSession(
  overrides: Partial<PortalSessionRecord> & Pick<PortalSessionRecord, "id">
): PortalSessionRecord {
  return {
    organizationId: ORG_A,
    portalAccountId: PORTAL_ACCOUNT_1,
    createdAt: new Date("2026-04-12T11:00:00.000Z"),
    lastActivityAt: new Date("2026-04-12T12:00:00.000Z"),
    idleExpiresAt: new Date("2026-04-12T12:30:00.000Z"),
    absoluteExpiresAt: new Date("2026-04-13T11:00:00.000Z"),
    revokedAt: null,
    revokedReason: null,
    ...overrides,
  };
}

/**
 * Fake port. Each surface answers from a fixed set, filtered by the
 * same anchor semantics the Prisma implementation uses.
 */
function fakeClient(input: {
  readonly operator?: ReadonlyArray<OperatorSessionRecord>;
  readonly portal?: ReadonlyArray<PortalSessionRecord>;
}): SessionEvidenceClient {
  const inWindow = (q: SessionQuery, createdAt: Date, revokedAt: Date | null): boolean => {
    const anchoredAt = q.anchor === "OPENED" ? createdAt : revokedAt;
    if (anchoredAt === null) return false;
    return anchoredAt >= q.from && anchoredAt <= q.to;
  };
  return {
    async listOperatorSessions(q) {
      return (input.operator ?? []).filter((r) => inWindow(q, r.createdAt, r.revokedAt));
    },
    async listPortalSessions(q) {
      return (input.portal ?? []).filter((r) => inWindow(q, r.createdAt, r.revokedAt));
    },
  };
}

describe("collectSessionEvidence", () => {
  it("emits rows from BOTH current session tables, not one surface only", async () => {
    const evidence = await collectSessionEvidence(
      fakeClient({
        operator: [operatorSession({ id: "s-op-1" })],
        portal: [portalSession({ id: "s-portal-1" })],
      }),
      FROM,
      TO
    );

    expect(evidence.opened.map((r) => r.sessionId)).toEqual(["s-op-1", "s-portal-1"]);
    expect(evidence.opened.map((r) => r.surface)).toEqual(["OPERATOR", "PORTAL"]);
  });

  it("normalizes each surface onto its own principal column", async () => {
    const evidence = await collectSessionEvidence(
      fakeClient({
        operator: [operatorSession({ id: "s-op-1", userId: USER_2 })],
        portal: [portalSession({ id: "s-portal-1" })],
      }),
      FROM,
      TO
    );

    const [operatorRow, portalRow] = evidence.opened;
    expect(operatorRow?.principalId).toBe(USER_2);
    expect(operatorRow?.mfaSatisfied).toBe(true);
    // `portal_session` carries no MFA column; the artifact must say
    // "not applicable", never "false" (which would read as a finding).
    expect(portalRow?.principalId).toBe(PORTAL_ACCOUNT_1);
    expect(portalRow?.mfaSatisfied).toBeNull();
  });

  it("excludes sessions opened outside the period", async () => {
    const evidence = await collectSessionEvidence(
      fakeClient({
        operator: [
          operatorSession({ id: "s-in", createdAt: new Date("2026-05-01T00:00:00.000Z") }),
          operatorSession({ id: "s-before", createdAt: new Date("2026-03-31T23:59:59.000Z") }),
          operatorSession({ id: "s-after", createdAt: new Date("2026-07-01T00:00:01.000Z") }),
        ],
      }),
      FROM,
      TO
    );

    expect(evidence.opened.map((r) => r.sessionId)).toEqual(["s-in"]);
  });

  it("collects the revocation slice on revokedAt, not on createdAt", async () => {
    // A session opened BEFORE the period but terminated inside it is
    // exactly the CC6.5-1 case: the off-boarding happened this quarter.
    const evidence = await collectSessionEvidence(
      fakeClient({
        operator: [
          operatorSession({
            id: "s-terminated",
            createdAt: new Date("2026-03-01T09:00:00.000Z"),
            revokedAt: new Date("2026-05-20T14:00:00.000Z"),
            revokedReason: "USER_TERMINATED",
          }),
        ],
      }),
      FROM,
      TO
    );

    expect(evidence.opened).toHaveLength(0);
    expect(evidence.revoked.map((r) => r.sessionId)).toEqual(["s-terminated"]);
    expect(evidence.revoked[0]?.revokedReason).toBe("USER_TERMINATED");
  });

  it("orders the merged surfaces deterministically by org then time then id", async () => {
    const evidence = await collectSessionEvidence(
      fakeClient({
        operator: [
          operatorSession({
            id: "s-op-orgB",
            organizationId: ORG_B,
            createdAt: new Date("2026-04-02T00:00:00.000Z"),
          }),
          operatorSession({ id: "s-op-late", createdAt: new Date("2026-06-01T00:00:00.000Z") }),
        ],
        portal: [
          portalSession({ id: "s-portal-early", createdAt: new Date("2026-04-01T00:00:00.000Z") }),
        ],
      }),
      FROM,
      TO
    );

    expect(evidence.opened.map((r) => r.sessionId)).toEqual([
      "s-portal-early",
      "s-op-late",
      "s-op-orgB",
    ]);
  });
});

describe("createPrismaSessionEvidenceClient", () => {
  interface RecordedCall {
    readonly delegate: string;
    readonly where: Record<string, unknown>;
    readonly select: Record<string, unknown>;
  }

  function stubDelegates() {
    const calls: RecordedCall[] = [];
    const delegate = (name: string) => ({
      findMany: (args: { where: Record<string, unknown>; select: Record<string, unknown> }) => {
        calls.push({ delegate: name, where: args.where, select: args.select });
        return Promise.resolve([]);
      },
    });
    const client = {
      authSession: delegate("authSession"),
      portalSession: delegate("portalSession"),
    };
    return { calls, client };
  }

  it("reads auth_session and portal_session — the tables the live engine writes", async () => {
    const { calls, client } = stubDelegates();
    const evidenceClient = createPrismaSessionEvidenceClient(
      client as unknown as Parameters<typeof createPrismaSessionEvidenceClient>[0]
    );

    await collectSessionEvidence(evidenceClient, FROM, TO);

    expect(calls.map((c) => c.delegate).sort()).toEqual([
      "authSession",
      "authSession",
      "portalSession",
      "portalSession",
    ]);
  });

  it("anchors the opened window on createdAt and the revoked window on a non-null revokedAt", async () => {
    const { calls, client } = stubDelegates();
    const evidenceClient = createPrismaSessionEvidenceClient(
      client as unknown as Parameters<typeof createPrismaSessionEvidenceClient>[0]
    );

    await collectSessionEvidence(evidenceClient, FROM, TO);

    const opened = calls.filter((c) => "createdAt" in c.where);
    const revoked = calls.filter((c) => "revokedAt" in c.where);
    expect(opened).toHaveLength(2);
    expect(revoked).toHaveLength(2);
    expect(opened[0]?.where["createdAt"]).toEqual({ gte: FROM, lte: TO });
    // Without `not: null` an active session would qualify on a null
    // comparison and land in the deprovisioning artifact.
    expect(revoked[0]?.where["revokedAt"]).toEqual({ gte: FROM, lte: TO, not: null });
  });

  it("selects no credential or request-metadata column", async () => {
    const { calls, client } = stubDelegates();
    const evidenceClient = createPrismaSessionEvidenceClient(
      client as unknown as Parameters<typeof createPrismaSessionEvidenceClient>[0]
    );

    await collectSessionEvidence(evidenceClient, FROM, TO);

    for (const call of calls) {
      expect(call.select).not.toHaveProperty("tokenHash");
      expect(call.select).not.toHaveProperty("ipAddress");
      expect(call.select).not.toHaveProperty("userAgent");
    }
  });
});

describe("composeSessionLogCsv", () => {
  it("writes the header even with no rows, so an empty period is legible", () => {
    const csv = composeSessionLogCsv([]);
    expect(csv).toBe(
      "surface,sessionId,organizationId,principalId,mfaSatisfied,createdAt," +
        "lastActivityAt,idleExpiresAt,absoluteExpiresAt,revokedAt,revokedReason\n"
    );
  });

  it("carries no operator identifier beyond the principal UUID", () => {
    const header = composeSessionLogCsv([]).split("\n")[0] ?? "";
    for (const forbidden of ["email", "displayName", "ipAddress", "userAgent", "tokenHash"]) {
      expect(header).not.toContain(forbidden);
    }
  });

  it("renders an active operator session with an empty revocation pair", async () => {
    const evidence = await collectSessionEvidence(
      fakeClient({ operator: [operatorSession({ id: "s-op-1" })] }),
      FROM,
      TO
    );

    const dataRow = composeSessionLogCsv(evidence.opened).split("\n")[1];
    expect(dataRow).toBe(
      `OPERATOR,s-op-1,${ORG_A},${USER_1},true,` +
        "2026-04-10T09:00:00.000Z,2026-04-10T17:00:00.000Z," +
        "2026-04-10T17:30:00.000Z,2026-04-11T09:00:00.000Z,,"
    );
  });

  it("leaves mfaSatisfied blank for the portal surface", async () => {
    const evidence = await collectSessionEvidence(
      fakeClient({ portal: [portalSession({ id: "s-portal-1" })] }),
      FROM,
      TO
    );

    const dataRow = composeSessionLogCsv(evidence.opened).split("\n")[1] ?? "";
    expect(dataRow.startsWith(`PORTAL,s-portal-1,${ORG_A},${PORTAL_ACCOUNT_1},,`)).toBe(true);
  });
});

describe("composeRevocationCsv", () => {
  it("keeps the revocation reason and derives the session lifetime", async () => {
    const evidence = await collectSessionEvidence(
      fakeClient({
        operator: [
          operatorSession({
            id: "s-terminated",
            createdAt: new Date("2026-05-20T09:00:00.000Z"),
            revokedAt: new Date("2026-05-20T11:30:00.000Z"),
            revokedReason: "USER_TERMINATED",
          }),
        ],
      }),
      FROM,
      TO
    );

    const dataRow = composeRevocationCsv(evidence.revoked).split("\n")[1];
    expect(dataRow).toBe(
      `OPERATOR,s-terminated,${ORG_A},${USER_1},` +
        "2026-05-20T09:00:00.000Z,2026-05-20T11:30:00.000Z,USER_TERMINATED,150"
    );
  });

  it("distinguishes off-boarding revocations from routine ones", async () => {
    const evidence = await collectSessionEvidence(
      fakeClient({
        operator: [
          operatorSession({
            id: "s-logout",
            revokedAt: new Date("2026-05-01T10:00:00.000Z"),
            revokedReason: "USER_LOGOUT",
          }),
          operatorSession({
            id: "s-terminated",
            revokedAt: new Date("2026-05-02T10:00:00.000Z"),
            revokedReason: "USER_TERMINATED",
          }),
        ],
      }),
      FROM,
      TO
    );

    const terminations = evidence.revoked.filter((r) => r.revokedReason === "USER_TERMINATED");
    expect(terminations.map((r) => r.sessionId)).toEqual(["s-terminated"]);
    expect(composeRevocationCsv(evidence.revoked)).toContain("USER_LOGOUT");
  });
});

describe("currentQuarterLabel", () => {
  it("derives the pack folder from the period end", () => {
    expect(currentQuarterLabel(new Date("2026-06-30T23:59:59.999Z"))).toBe("2026-Q2");
    expect(currentQuarterLabel(new Date("2026-01-01T00:00:00.000Z"))).toBe("2026-Q1");
    expect(currentQuarterLabel(new Date("2026-12-31T00:00:00.000Z"))).toBe("2026-Q4");
  });
});
