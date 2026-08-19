// Drive an order along the golden path to a chosen state.
//
// The invariant tests each need an order sitting at a specific point —
// "PV1 approved but not filled", "typing not yet started" — and getting
// there means dispatching real commands, because there is no lawful way
// to put an order into a state except by transitioning it. Writing the
// row directly with SQL would defeat the purpose: the state would exist
// without the `order_event` history, SLA intervals and version that the
// commands under test read.
//
// `advanceOrderTo` therefore replays the real spine, stopping where
// asked. It is the same sequence `golden-path-commands.test.ts` asserts
// step by step; that file proves the walk is correct, and this one
// reuses it as a means to an end.

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

import { actingAs, newIdempotencyKey } from "./bus-harness.js";

import type { CommandFixture } from "./fixtures.js";
import type { Client } from "pg";

/**
 * States `advanceOrderTo` can stop at.
 *
 * A subset of `OrderStatus`, listing only the primary-path states the
 * spine walks through. Exception states are reached by their own
 * commands and are not reachable by "advancing".
 */
export type SpineStop =
  | "RECEIVED"
  | "TYPING_IN_PROGRESS"
  | "TYPED_READY_FOR_PV1"
  | "PV1_IN_PROGRESS"
  | "PV1_APPROVED_READY_FOR_FILL"
  | "FILL_IN_PROGRESS"
  | "FILL_COMPLETED_READY_FOR_FINAL"
  | "FINAL_VERIFICATION_IN_PROGRESS"
  | "FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP"
  | "READY_TO_SHIP"
  | "SHIPPED";

/** Order the spine visits its stops in. Used to decide when to halt. */
const SPINE_ORDER: ReadonlyArray<SpineStop> = [
  "RECEIVED",
  "TYPING_IN_PROGRESS",
  "TYPED_READY_FOR_PV1",
  "PV1_IN_PROGRESS",
  "PV1_APPROVED_READY_FOR_FILL",
  "FILL_IN_PROGRESS",
  "FILL_COMPLETED_READY_FOR_FINAL",
  "FINAL_VERIFICATION_IN_PROGRESS",
  "FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP",
  "READY_TO_SHIP",
  "SHIPPED",
];

export interface SpineOrder {
  readonly prescriptionId: string;
  readonly orderId: string;
  readonly orderLineId: string;
}

/** Create a prescription and an order sitting in RECEIVED. */
export async function createSpineOrder(fixture: CommandFixture): Promise<SpineOrder> {
  const rx = await actingAs(
    { organizationId: fixture.organizationId, userId: fixture.typistUserId },
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
        { idempotencyKey: newIdempotencyKey("rx") }
      )
  );

  const order = await actingAs(
    {
      organizationId: fixture.organizationId,
      userId: fixture.typistUserId,
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
          lines: [{ prescriptionId: rx.prescriptionId, quantityToFill: 30, daysSupplyToFill: 30 }],
        },
        { idempotencyKey: newIdempotencyKey("order") }
      )
  );

  const orderLineId = order.orderLineIds[0];
  if (orderLineId === undefined) {
    throw new Error("spine: CreateOrder returned no order line");
  }
  return { prescriptionId: rx.prescriptionId, orderId: order.orderId, orderLineId };
}

/**
 * Advance `order` until its status is `stop`.
 *
 * `owner` is a raw connection used only to read the persisted screening
 * findings that the PV1 acknowledgement gate requires — see
 * `golden-path-commands.test.ts` for why that gate is genuine and not
 * something to bypass.
 */
export async function advanceOrderTo(
  fixture: CommandFixture,
  order: SpineOrder,
  stop: SpineStop,
  owner: Client
): Promise<void> {
  const target = SPINE_ORDER.indexOf(stop);
  if (target < 0) throw new Error(`spine: unknown stop ${stop}`);
  // True when `state` is at-or-past the requested stop, i.e. the walk
  // should not take the step that leaves `state`.
  const done = (state: SpineStop): boolean => SPINE_ORDER.indexOf(state) >= target;

  const { orderId, orderLineId } = order;
  const as =
    (userId: string, workstation = false) =>
    <T>(fn: () => Promise<T>): Promise<T> =>
      actingAs(
        {
          organizationId: fixture.organizationId,
          userId,
          siteId: fixture.siteId,
          ...(workstation ? { workstationId: fixture.workstationId } : {}),
        },
        fn
      );
  const asTypist = as(fixture.typistUserId);
  const asPharmacist = as(fixture.pharmacistUserId);
  const asPharmacist2 = as(fixture.pharmacist2UserId);
  const asTechnician = as(fixture.technicianUserId, true);

  if (done("RECEIVED")) return;
  await asTypist(() =>
    executeCommand(StartTyping, { orderId }, { idempotencyKey: newIdempotencyKey("typing") })
  );

  if (done("TYPING_IN_PROGRESS")) return;
  await asTypist(() =>
    executeCommand(
      CompleteTypingReview,
      { orderId },
      { idempotencyKey: newIdempotencyKey("typed") }
    )
  );

  if (done("TYPED_READY_FOR_PV1")) return;
  await asPharmacist(() =>
    executeCommand(StartPV1, { orderId }, { idempotencyKey: newIdempotencyKey("pv1") })
  );

  if (done("PV1_IN_PROGRESS")) return;
  await acknowledgeOutstandingFindings(fixture, orderId, owner, asPharmacist);
  await asPharmacist(() =>
    executeCommand(ApprovePV1, { orderId }, { idempotencyKey: newIdempotencyKey("pv1ok") })
  );

  if (done("PV1_APPROVED_READY_FOR_FILL")) return;
  await asTechnician(() =>
    executeCommand(StartFill, { orderId }, { idempotencyKey: newIdempotencyKey("fill") })
  );

  if (done("FILL_IN_PROGRESS")) return;
  await asTechnician(() =>
    executeCommand(
      AssignLot,
      { orderId, orderLineId, lotId: fixture.lotId },
      { idempotencyKey: newIdempotencyKey("lot") }
    )
  );
  const printed = await asTechnician(() =>
    executeCommand(
      PrintVialLabel,
      { orderId, orderLineId, printerId: fixture.printerId },
      { idempotencyKey: newIdempotencyKey("label") }
    )
  );
  await asTechnician(() =>
    executeCommand(
      ConfirmVialLabelPrint,
      { printJobId: printed.printJobId, status: "COMPLETED" },
      { idempotencyKey: newIdempotencyKey("printok") }
    )
  );
  await asTechnician(() =>
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
  );

  if (done("FILL_COMPLETED_READY_FOR_FINAL")) return;
  await asPharmacist2(() =>
    executeCommand(
      StartFinalVerification,
      { orderId },
      { idempotencyKey: newIdempotencyKey("final") }
    )
  );

  if (done("FINAL_VERIFICATION_IN_PROGRESS")) return;
  await asPharmacist2(() =>
    executeCommand(
      ApproveFinalVerification,
      { orderId },
      { idempotencyKey: newIdempotencyKey("finalok") }
    )
  );

  if (done("FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP")) return;
  await asPharmacist2(() =>
    executeCommand(ReleaseToShip, { orderId }, { idempotencyKey: newIdempotencyKey("release") })
  );

  if (done("READY_TO_SHIP")) return;
  await asPharmacist2(() =>
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
  );
  await asPharmacist2(() =>
    executeCommand(ConfirmShipment, { orderId }, { idempotencyKey: newIdempotencyKey("shipped") })
  );
}

/**
 * Acknowledge every finding the PV1 gate requires, as the pharmacist
 * who will approve.
 *
 * Acknowledgements are per-pharmacist, so this must run as the same
 * actor that dispatches `ApprovePV1`.
 */
async function acknowledgeOutstandingFindings(
  fixture: CommandFixture,
  orderId: string,
  owner: Client,
  as: <T>(fn: () => Promise<T>) => Promise<T>
): Promise<void> {
  const { rows } = await owner.query<{ fingerprint: string }>(
    `SELECT DISTINCT fingerprint FROM order_screening_finding
      WHERE "organizationId" = $1 AND "orderId" = $2
        AND disposition = 'REQUIRES_ACKNOWLEDGEMENT'`,
    [fixture.organizationId, orderId]
  );
  for (const { fingerprint } of rows) {
    await as(() =>
      executeCommand(
        AcknowledgePV1ScreeningFinding,
        { orderId, fingerprint },
        { idempotencyKey: newIdempotencyKey("ack") }
      )
    );
  }
}
