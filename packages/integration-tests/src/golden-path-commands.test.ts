// The golden path, executed by the real command bus against real
// Postgres, asserting the four-table write after EVERY transition.
//
// ## What this file is for
//
// `packages/*/src/commands/*.test.ts` already covers each of these
// commands in isolation against a fake Prisma. What no test covered
// before this file is the sequence: that fifteen real transactions,
// each taking a row lock and advancing a version, compose into a
// dispensed order — and that every one of them leaves the audit trail
// the architecture promises.
//
// ## The assertion that matters
//
// After each dispatch, `expectTransitionRecorded` checks that the
// transition produced rows in ALL FOUR tables the workflow rules
// require — `command_log`, `order_event`, `audit_log`, `event_outbox` —
// plus the `idempotency_key` row, and that the order's status and
// version moved. The mocked unit tests assert the same shapes, but
// against a `$transaction` that is `fn => fn(tx)`; here the transaction
// is real, so a write that was never actually committed cannot pass.
//
// The counts are compared as DELTAS around each dispatch rather than as
// absolutes. Absolute counts would silently pass if a command wrote
// nothing while a previous one wrote twice.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { executeCommand } from "@pharmax/command-bus";
import { AssignLot, CompleteFill, PrintVialLabel, StartFill } from "@pharmax/fill";
import { buildVialBarcodeValue, ConfirmVialLabelPrint } from "@pharmax/labels";
import { CreateOrder, CreatePrescription } from "@pharmax/orders";
import { ConfirmShipment, CreateShipment, ReleaseToShip } from "@pharmax/shipping";
import {
  AcknowledgePV1ScreeningFinding,
  ApproveFinalVerification,
  ApprovePV1,
  CompleteTypingReview,
  StartFinalVerification,
  StartPV1,
  StartTyping,
} from "@pharmax/verification";

import { assertSchemaReady, connect } from "./lib/db.js";
import {
  actingAs,
  assertAppRolePinned,
  configureHarness,
  newIdempotencyKey,
} from "./support/bus-harness.js";
import {
  cleanupCommandFixture,
  seedCommandFixture,
  type CommandFixture,
} from "./support/fixtures.js";

import type { Client } from "pg";

interface AuditCounts {
  readonly commandLog: number;
  readonly orderEvent: number;
  readonly auditLog: number;
  readonly eventOutbox: number;
  readonly idempotencyKey: number;
}

async function readAuditCounts(client: Client, organizationId: string): Promise<AuditCounts> {
  const { rows } = await client.query<{
    command_log: string;
    order_event: string;
    audit_log: string;
    event_outbox: string;
    idempotency_key: string;
  }>(
    `SELECT
       (SELECT count(*) FROM command_log     WHERE "organizationId" = $1)::text AS command_log,
       (SELECT count(*) FROM order_event     WHERE "organizationId" = $1)::text AS order_event,
       (SELECT count(*) FROM audit_log       WHERE "organizationId" = $1)::text AS audit_log,
       (SELECT count(*) FROM event_outbox    WHERE "organizationId" = $1)::text AS event_outbox,
       (SELECT count(*) FROM idempotency_key WHERE "organizationId" = $1)::text AS idempotency_key`,
    [organizationId]
  );
  const r = rows[0];
  return {
    commandLog: Number(r?.command_log ?? 0),
    orderEvent: Number(r?.order_event ?? 0),
    auditLog: Number(r?.audit_log ?? 0),
    eventOutbox: Number(r?.event_outbox ?? 0),
    idempotencyKey: Number(r?.idempotency_key ?? 0),
  };
}

async function readOrderState(
  client: Client,
  orderId: string
): Promise<{ status: string; version: number } | null> {
  const { rows } = await client.query<{ currentStatus: string; version: number }>(
    `SELECT "currentStatus", version FROM "order" WHERE id = $1`,
    [orderId]
  );
  const row = rows[0];
  return row === undefined ? null : { status: row.currentStatus, version: Number(row.version) };
}

describe("golden path — real commands, real transactions", () => {
  let owner: Client;
  let fixture: CommandFixture;

  // Carried across the ordered `it` blocks. The path is inherently
  // sequential — an order cannot be filled before it exists — and
  // `sequence.concurrent: false` in this package's vitest config makes
  // that ordering a guarantee rather than a hope.
  let prescriptionId: string;
  let orderId: string;
  let orderLineId: string;

  beforeAll(async () => {
    await assertSchemaReady();
    configureHarness();
    await assertAppRolePinned();
    owner = await connect("owner");
    fixture = await seedCommandFixture(owner);
  });

  afterAll(async () => {
    if (fixture !== undefined) await cleanupCommandFixture(owner, fixture);
    await owner?.end().catch(() => undefined);
  });

  /**
   * Dispatch `fn`, then assert the transition left a complete audit
   * trail and moved the order forward.
   *
   * `expectedStatus` is `null` for commands that do not transition an
   * order (only `CreatePrescription`, which has no order yet).
   */
  async function expectTransitionRecorded<T>(
    label: string,
    expectedStatus: string | null,
    fn: () => Promise<T>
  ): Promise<T> {
    const before = await readAuditCounts(owner, fixture.organizationId);
    const versionBefore =
      orderId === undefined ? null : ((await readOrderState(owner, orderId))?.version ?? null);

    const result = await fn();

    const after = await readAuditCounts(owner, fixture.organizationId);

    // command_log, audit_log, event_outbox and idempotency_key are the
    // bus's own writes and must advance for every accepted command.
    expect(after.commandLog, `${label}: command_log`).toBeGreaterThan(before.commandLog);
    expect(after.auditLog, `${label}: audit_log`).toBeGreaterThan(before.auditLog);
    expect(after.eventOutbox, `${label}: event_outbox`).toBeGreaterThan(before.eventOutbox);
    expect(after.idempotencyKey, `${label}: idempotency_key`).toBeGreaterThan(
      before.idempotencyKey
    );

    if (expectedStatus !== null) {
      // order_event is written by the workflow transition, so it only
      // advances for commands that move an order.
      expect(after.orderEvent, `${label}: order_event`).toBeGreaterThan(before.orderEvent);

      const state = await readOrderState(owner, orderId);
      expect(state?.status, `${label}: order status`).toBe(expectedStatus);
      if (versionBefore !== null) {
        expect(state?.version, `${label}: order version`).toBeGreaterThan(versionBefore);
      }
    }

    return result;
  }

  it("CreatePrescription writes the prescription and its audit trail", async () => {
    const out = await expectTransitionRecorded("CreatePrescription", null, () =>
      actingAs({ organizationId: fixture.organizationId, userId: fixture.adminUserId }, () =>
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
          { idempotencyKey: newIdempotencyKey("rx") }
        )
      )
    );
    prescriptionId = out.prescriptionId;
    expect(prescriptionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("CreateOrder lands the order in RECEIVED", async () => {
    // `orderId` is assigned inside the dispatched callback so that
    // `expectTransitionRecorded` — which reads the order's status after
    // `fn` resolves — sees the freshly created row. The four-table
    // audit trail is load-bearing on the very first transition that
    // lands an order, and skipping the helper here is how a broken
    // `order_event` / `command_log` / `audit_log` / `event_outbox` /
    // `idempotency_key` write on `CreateOrder` becomes invisible.
    const out = await expectTransitionRecorded("CreateOrder", "RECEIVED", async () => {
      const result = await actingAs(
        {
          organizationId: fixture.organizationId,
          userId: fixture.adminUserId,
          siteId: fixture.siteId,
        },
        () =>
          executeCommand(
            CreateOrder,
            {
              clinicId: fixture.clinicId,
              siteId: fixture.siteId,
              patientId: fixture.patientId,
              intakeSourceKind: "API",
              lines: [{ prescriptionId, quantityToFill: 30, daysSupplyToFill: 30 }],
            },
            { idempotencyKey: newIdempotencyKey("order") }
          )
      );
      orderId = result.orderId;
      return result;
    });
    orderLineId = out.orderLineIds[0] ?? "";
    expect(orderLineId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("walks RECEIVED to SHIPPED, auditing every transition", async () => {
    // Each step names the operator who performs it, because segregation
    // of duties makes the actor part of the contract rather than
    // incidental. Walking the whole path as one user is refused with
    // SOD_VIOLATION — see `CommandFixture` for the three rules.
    const as =
      (userId: string) =>
      <T>(fn: () => Promise<T>): Promise<T> =>
        actingAs({ organizationId: fixture.organizationId, userId, siteId: fixture.siteId }, fn);

    const asTypist = as(fixture.typistUserId);
    const asPharmacist = as(fixture.pharmacistUserId);
    const asPharmacist2 = as(fixture.pharmacist2UserId);

    // The technician's context carries a workstation. Commands standing
    // for a physical act at the bench — printing a vial label — refuse
    // without one, which is why the workstation is scoped to this actor
    // rather than set globally for the walk.
    const asTechnician = <T>(fn: () => Promise<T>): Promise<T> =>
      actingAs(
        {
          organizationId: fixture.organizationId,
          userId: fixture.technicianUserId,
          siteId: fixture.siteId,
          workstationId: fixture.workstationId,
        },
        fn
      );

    await expectTransitionRecorded("StartTyping", "TYPING_IN_PROGRESS", () =>
      asTypist(() =>
        executeCommand(StartTyping, { orderId }, { idempotencyKey: newIdempotencyKey("typing") })
      )
    );

    await expectTransitionRecorded("CompleteTypingReview", "TYPED_READY_FOR_PV1", () =>
      asTypist(() =>
        executeCommand(
          CompleteTypingReview,
          { orderId },
          { idempotencyKey: newIdempotencyKey("typed") }
        )
      )
    );

    await expectTransitionRecorded("StartPV1", "PV1_IN_PROGRESS", () =>
      asPharmacist(() =>
        executeCommand(StartPV1, { orderId }, { idempotencyKey: newIdempotencyKey("pv1") })
      )
    );

    // The screening acknowledgement gate stands between StartPV1 and
    // ApprovePV1, and it is not incidental to this test — it is one of
    // the workflow safety rules.
    //
    // No drug-knowledge vendor is provisioned, so the screen reports
    // coverage gaps rather than clinical alerts. The gate treats an
    // unacknowledged gap exactly like an unacknowledged interaction:
    // `ApprovePV1` refuses with `PV1_SCREENING_ACKNOWLEDGEMENT_REQUIRED`
    // until THIS pharmacist has acknowledged each outstanding
    // fingerprint. Acknowledgements are per-pharmacist by design, so a
    // colleague's acknowledgement would not satisfy it.
    //
    // Fingerprints are read from the persisted screen rather than
    // constructed, so this asserts the real recorded findings — if the
    // engine stops persisting them, this fails instead of quietly
    // acknowledging nothing.
    // Only `REQUIRES_ACKNOWLEDGEMENT` findings are acknowledgeable.
    // Acknowledging an informational one is itself refused — the command
    // will not let a pharmacist sign for something the gate never asked
    // about, which keeps the acknowledgement record meaningful.
    const outstanding = await owner.query<{ fingerprint: string }>(
      `SELECT DISTINCT fingerprint FROM order_screening_finding
        WHERE "organizationId" = $1 AND "orderId" = $2
          AND disposition = 'REQUIRES_ACKNOWLEDGEMENT'`,
      [fixture.organizationId, orderId]
    );
    expect(
      outstanding.rows.length,
      "StartPV1 should have persisted screening findings to acknowledge"
    ).toBeGreaterThan(0);

    for (const { fingerprint } of outstanding.rows) {
      await asPharmacist(() =>
        executeCommand(
          AcknowledgePV1ScreeningFinding,
          { orderId, fingerprint },
          { idempotencyKey: newIdempotencyKey("ack") }
        )
      );
    }

    await expectTransitionRecorded("ApprovePV1", "PV1_APPROVED_READY_FOR_FILL", () =>
      asPharmacist(() =>
        executeCommand(ApprovePV1, { orderId }, { idempotencyKey: newIdempotencyKey("pv1ok") })
      )
    );

    await expectTransitionRecorded("StartFill", "FILL_IN_PROGRESS", () =>
      asTechnician(() =>
        executeCommand(StartFill, { orderId }, { idempotencyKey: newIdempotencyKey("fill") })
      )
    );

    await expectTransitionRecorded("AssignLot", "FILL_IN_PROGRESS", () =>
      asTechnician(() =>
        executeCommand(
          AssignLot,
          { orderId, orderLineId, lotId: fixture.lotId },
          { idempotencyKey: newIdempotencyKey("lot") }
        )
      )
    );

    const printed = await expectTransitionRecorded("PrintVialLabel", "FILL_IN_PROGRESS", () =>
      asTechnician(() =>
        executeCommand(
          PrintVialLabel,
          { orderId, orderLineId, printerId: fixture.printerId },
          { idempotencyKey: newIdempotencyKey("label") }
        )
      )
    );

    // In production the print agent confirms the job once the printer
    // acknowledges the ZPL, and `CompleteFill` refuses until it has:
    // "The active vial label print for this line has not completed."
    // That is deliberate — a fill must not be completed against a label
    // that never came out of the printer. There is no print agent in
    // this suite, so the harness plays its part explicitly rather than
    // reaching into `print_job` with SQL, which would bypass the very
    // command that records the confirmation.
    await asTechnician(() =>
      executeCommand(
        ConfirmVialLabelPrint,
        { printJobId: printed.printJobId, status: "COMPLETED" },
        { idempotencyKey: newIdempotencyKey("printok") }
      )
    );

    await expectTransitionRecorded("CompleteFill", "FILL_COMPLETED_READY_FOR_FINAL", () =>
      asTechnician(() =>
        executeCommand(
          CompleteFill,
          {
            orderId,
            lineScans: [
              {
                orderLineId,
                lotScan: fixture.lotNumber,
                vialLabelScan: buildVialBarcodeValue(orderLineId),
              },
            ],
          },
          { idempotencyKey: newIdempotencyKey("filled") }
        )
      )
    );

    await expectTransitionRecorded("StartFinalVerification", "FINAL_VERIFICATION_IN_PROGRESS", () =>
      asPharmacist2(() =>
        executeCommand(
          StartFinalVerification,
          { orderId },
          { idempotencyKey: newIdempotencyKey("final") }
        )
      )
    );

    await expectTransitionRecorded(
      "ApproveFinalVerification",
      "FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP",
      () =>
        asPharmacist2(() =>
          executeCommand(
            ApproveFinalVerification,
            { orderId },
            { idempotencyKey: newIdempotencyKey("finalok") }
          )
        )
    );

    await expectTransitionRecorded("ReleaseToShip", "READY_TO_SHIP", () =>
      asPharmacist2(() =>
        executeCommand(ReleaseToShip, { orderId }, { idempotencyKey: newIdempotencyKey("release") })
      )
    );

    await expectTransitionRecorded("CreateShipment", "READY_TO_SHIP", () =>
      asPharmacist2(() =>
        executeCommand(
          CreateShipment,
          {
            orderId,
            carrier: "UPS",
            serviceLevel: "GROUND",
            trackingNumber: `1Z-IT-${orderId.slice(0, 8)}`,
          },
          { idempotencyKey: newIdempotencyKey("shipment") }
        )
      )
    );

    await expectTransitionRecorded("ConfirmShipment", "SHIPPED", () =>
      asPharmacist2(() =>
        executeCommand(
          ConfirmShipment,
          { orderId },
          { idempotencyKey: newIdempotencyKey("shipped") }
        )
      )
    );

    const finalState = await readOrderState(owner, orderId);
    expect(finalState?.status).toBe("SHIPPED");
  });
});

// The expected vial scan is derived from the order line, not from the
// print output: `validateVialLabelScan` compares the scanned value
// against `buildVialBarcodeValue(orderLineId)`. Using the production
// helper means the test scans exactly what a real scanner at the bench
// would read off the label, rather than a value invented here that
// happens to satisfy the check.
