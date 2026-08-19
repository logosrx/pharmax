// Harness smoke test: does a single real command actually run?
//
// Kept separate from the golden-path walk and the invariant suite
// because it answers a different question. Those two ask "is the system
// correct"; this asks "is the harness wired". When the fixture is
// missing a row or the bus is misconfigured, EVERY test in the other
// files fails at once with the same unhelpful error. This one fails
// alone and names the cause.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { executeCommand } from "@pharmax/command-bus";
import { CreatePrescription } from "@pharmax/orders";

import { assertSchemaReady, connect } from "./lib/db.js";
import { actingAs, configureHarness, newIdempotencyKey } from "./support/bus-harness.js";
import {
  cleanupCommandFixture,
  seedCommandFixture,
  type CommandFixture,
} from "./support/fixtures.js";

import type { Client } from "pg";

describe("command bus harness", () => {
  let owner: Client;
  let fixture: CommandFixture;

  beforeAll(async () => {
    await assertSchemaReady();
    configureHarness();
    owner = await connect("owner");
    fixture = await seedCommandFixture(owner);
  });

  afterAll(async () => {
    if (fixture !== undefined) await cleanupCommandFixture(owner, fixture);
    await owner?.end().catch(() => undefined);
  });

  it("dispatches CreatePrescription against real Postgres", async () => {
    const result = await actingAs(
      { organizationId: fixture.organizationId, userId: fixture.adminUserId },
      () =>
        executeCommand(
          CreatePrescription,
          {
            clinicId: fixture.clinicId,
            patientId: fixture.patientId,
            providerId: fixture.providerId,
            drugNdc: fixture.productNdc,
            drugName: "Integration Tablet",
            quantityAuthorized: "30",
            daysSupply: 30,
            refillsAuthorized: 2,
            originalDateWritten: "2026-08-01",
            sig: "Take one tablet by mouth once daily.",
          },
          { idempotencyKey: newIdempotencyKey("smoke") }
        )
    );

    expect(result.prescriptionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.rxNumber.length).toBeGreaterThan(0);
    expect(result.controlledSubstanceSchedule).toBe("NON_CONTROLLED");

    // The bus's own bookkeeping, read back through the same tenancy-
    // extended client the command used.
    const logged = await owner.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM command_log
        WHERE "organizationId" = $1 AND "commandName" = 'CreatePrescription' AND status = 'SUCCEEDED'`,
      [fixture.organizationId]
    );
    expect(Number(logged.rows[0]?.count)).toBe(1);
  });
});
