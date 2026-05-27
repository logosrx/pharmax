// Unit tests for the access-activity aggregator. The Prisma adapter
// is exercised in integration tests; here we drive the aggregator
// with an in-memory client.

import { describe, expect, it } from "vitest";

import {
  aggregateAccessActivity,
  type AccessActivityClient,
  type AuditCountByActor,
  type CommandCountByActor,
} from "./access-activity-aggregator.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const ACTOR_A = "00000000-0000-4000-8000-0000000000aa";
const ACTOR_B = "00000000-0000-4000-8000-0000000000bb";

function fakeClient(args: {
  command: ReadonlyArray<CommandCountByActor>;
  audit: ReadonlyArray<AuditCountByActor>;
}): AccessActivityClient {
  return {
    async groupCommandLogByActor() {
      return args.command;
    },
    async groupAuditLogByActor() {
      return args.audit;
    },
  };
}

describe("aggregateAccessActivity", () => {
  it("sums command/audit rows and reports distinct operators", async () => {
    const out = await aggregateAccessActivity({
      organizationId: ORG_ID,
      periodStart: new Date("2026-01-01T00:00:00Z"),
      periodEnd: new Date("2026-04-01T00:00:00Z"),
      client: fakeClient({
        command: [
          {
            commandName: "StartTyping",
            actorUserId: ACTOR_A,
            count: 10,
            successes: 10,
            failures: 0,
          },
          {
            commandName: "ApprovePV1",
            actorUserId: ACTOR_B,
            count: 5,
            successes: 5,
            failures: 0,
          },
        ],
        audit: [
          { action: "patient.view", actorUserId: ACTOR_A, count: 20 },
          { action: "order.read", actorUserId: ACTOR_B, count: 7 },
        ],
      }),
    });
    expect(out.organizationId).toBe(ORG_ID);
    expect(out.totals.commandRows).toBe(15);
    expect(out.totals.auditRows).toBe(27);
    expect(out.totals.distinctOperators).toBe(2);
  });

  it("counts a NULL actor as a separate row but not a distinct operator", async () => {
    const out = await aggregateAccessActivity({
      organizationId: ORG_ID,
      periodStart: new Date("2026-01-01T00:00:00Z"),
      periodEnd: new Date("2026-04-01T00:00:00Z"),
      client: fakeClient({
        command: [
          {
            commandName: "CreateOrganization",
            actorUserId: null,
            count: 1,
            successes: 1,
            failures: 0,
          },
        ],
        audit: [],
      }),
    });
    expect(out.totals.commandRows).toBe(1);
    expect(out.totals.distinctOperators).toBe(0);
  });

  it("emits ISO timestamps in the aggregate", async () => {
    const out = await aggregateAccessActivity({
      organizationId: ORG_ID,
      periodStart: new Date("2026-01-01T00:00:00Z"),
      periodEnd: new Date("2026-04-01T00:00:00Z"),
      client: fakeClient({ command: [], audit: [] }),
    });
    expect(out.periodStart).toBe("2026-01-01T00:00:00.000Z");
    expect(out.periodEnd).toBe("2026-04-01T00:00:00.000Z");
  });
});
