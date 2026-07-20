// Stale label-purchase reconciler.
//
// `PurchaseShipmentLabel` spends REAL MONEY inside its transaction:
// the carrier buy is an external HTTP call, and the saga
// compensation only covers failures the process lives to see. If
// the worker/web process CRASHES between the carrier charging the
// card and the transaction committing (or between commit and the
// post-commit command_log status update), the durable evidence is a
// `command_log` row stuck in RUNNING — the reconciliation
// breadcrumb the command's header documents.
//
// This drain is the consumer of that breadcrumb. Each tick it finds
// PurchaseShipmentLabel command_log rows that have been RUNNING for
// longer than any legitimate transaction could live
// (`staleAfterMs`, default 15 min) and disposition each one:
//
//   - A shipment row EXISTS for the (org, order): the purchase
//     transaction committed and only the post-commit SUCCEEDED
//     update was lost. Flip the row to SUCCEEDED — the label is
//     real, the money matched, nothing is owed.
//
//   - NO shipment row: the transaction never committed, but the
//     carrier MAY have charged (crash after buy, before commit —
//     unknowable from our side). Flip the row to FAILED with
//     `PURCHASE_LABEL_RECONCILIATION_REQUIRED` so (a) the operator
//     can retry the purchase (the FAILED status re-opens the
//     idempotency key), and (b) billing has a queryable worklist of
//     purchases needing a carrier-dashboard check for an orphaned
//     label to void. The OTel counter below is the alerting hook.
//
// Both writes are FENCED on `status = RUNNING` so a slow-but-alive
// transaction that completes between our read and our write wins —
// the reconciler never overwrites a legitimate outcome.
//
// Cross-tenant by construction (crashes don't respect tenancy), so
// reads run in system context like every other drain. PHI: the only
// payload field read is `orderId` (the request's address fields are
// redacted at write time by the bus).

import type { Prisma, PrismaClient } from "@pharmax/database";
import { CommandStatus } from "@pharmax/database";
import type { clock as clockContract, logger as loggerContract } from "@pharmax/platform-core";
import { getMeter } from "@pharmax/telemetry";
import { withSystemContext } from "@pharmax/tenancy";

type Logger = loggerContract.Logger;
type Clock = clockContract.Clock;

const meter = getMeter("@pharmax/worker.label-purchase-reconciler");

const reconciledCounter = meter.createCounter("pharmax_label_purchase_reconciled_total", {
  description:
    "Stale PurchaseShipmentLabel command_log rows dispositioned by the reconciler. " +
    "outcome is one of committed (shipment exists; marked SUCCEEDED) | " +
    "needs_carrier_check (no shipment; marked FAILED for manual void) | lost_race.",
});

export const PURCHASE_LABEL_RECONCILIATION_REQUIRED = "PURCHASE_LABEL_RECONCILIATION_REQUIRED";

const PURCHASE_COMMAND_NAME = "PurchaseShipmentLabel";

export interface ReconcileStaleLabelPurchasesDeps {
  readonly client: Pick<PrismaClient, "commandLog" | "shipment">;
  readonly logger: Logger;
  readonly clock: Clock;
}

export interface ReconcileStaleLabelPurchasesOptions {
  /** Max rows dispositioned per tick. */
  readonly batchSize: number;
  /**
   * How long a PurchaseShipmentLabel command_log row may sit in
   * RUNNING before it is considered crashed. Must comfortably
   * exceed the longest legitimate purchase transaction (carrier
   * HTTP call + commit — seconds, not minutes).
   */
  readonly staleAfterMs: number;
}

export interface ReconcileStaleLabelPurchasesResult {
  readonly scanned: number;
  /** Rows whose shipment committed — flipped to SUCCEEDED. */
  readonly committed: number;
  /** Rows with no shipment — flipped to FAILED for manual carrier check. */
  readonly needsCarrierCheck: number;
  /** Rows that completed on their own between our read and write. */
  readonly lostRace: number;
}

export interface StaleLabelPurchaseReconciler {
  tick(): Promise<ReconcileStaleLabelPurchasesResult>;
}

function readOrderId(requestPayload: Prisma.JsonValue): string | null {
  if (requestPayload === null || typeof requestPayload !== "object") return null;
  const orderId = (requestPayload as Record<string, unknown>)["orderId"];
  return typeof orderId === "string" && orderId.length > 0 ? orderId : null;
}

export function createStaleLabelPurchaseReconciler(
  deps: ReconcileStaleLabelPurchasesDeps,
  options: ReconcileStaleLabelPurchasesOptions
): StaleLabelPurchaseReconciler {
  const log = deps.logger.child({ component: "label-purchase-reconciler" });

  return {
    async tick(): Promise<ReconcileStaleLabelPurchasesResult> {
      const now = deps.clock.now();
      const staleBefore = new Date(now.getTime() - options.staleAfterMs);

      return withSystemContext("worker:label-purchase-reconciler:sweep", async () => {
        const stale = await deps.client.commandLog.findMany({
          where: {
            commandName: PURCHASE_COMMAND_NAME,
            status: CommandStatus.RUNNING,
            startedAt: { lte: staleBefore },
          },
          select: {
            id: true,
            organizationId: true,
            requestPayload: true,
            startedAt: true,
          },
          orderBy: { startedAt: "asc" },
          take: options.batchSize,
        });

        let committed = 0;
        let needsCarrierCheck = 0;
        let lostRace = 0;

        for (const row of stale) {
          const orderId = readOrderId(row.requestPayload);
          const rowLog = log.child({
            commandLogId: row.id,
            organizationId: row.organizationId,
            orderId,
            startedAt: row.startedAt.toISOString(),
          });

          const shipment =
            orderId === null
              ? null
              : await deps.client.shipment.findFirst({
                  where: { organizationId: row.organizationId, orderId },
                  select: { id: true },
                });

          if (shipment !== null) {
            // Purchase committed; only the bookkeeping update was
            // lost. Fence on RUNNING so a live process finishing
            // right now wins.
            const updated = await deps.client.commandLog.updateMany({
              where: { id: row.id, status: CommandStatus.RUNNING },
              data: { status: CommandStatus.SUCCEEDED, completedAt: now },
            });
            if (updated.count === 1) {
              committed += 1;
              reconciledCounter.add(1, { outcome: "committed" });
              rowLog.info("label-purchase-reconciler.committed", {
                shipmentId: shipment.id,
                detail: "shipment row exists; post-commit status update was lost in a crash",
              });
            } else {
              lostRace += 1;
              reconciledCounter.add(1, { outcome: "lost_race" });
            }
            continue;
          }

          // No shipment row — the transaction never committed. The
          // carrier may still have charged; only their dashboard
          // knows. Mark FAILED so the operator can retry AND so the
          // row lands on billing's reconciliation worklist.
          const updated = await deps.client.commandLog.updateMany({
            where: { id: row.id, status: CommandStatus.RUNNING },
            data: {
              status: CommandStatus.FAILED,
              completedAt: now,
              errorCode: PURCHASE_LABEL_RECONCILIATION_REQUIRED,
              errorMessage:
                "Process crashed mid-purchase and no shipment row was committed. The carrier " +
                "MAY have issued (and charged for) a label: check the carrier dashboard for a " +
                `label bought for this order around ${row.startedAt.toISOString()} and void it ` +
                "before retrying the purchase.",
            },
          });
          if (updated.count === 1) {
            needsCarrierCheck += 1;
            reconciledCounter.add(1, { outcome: "needs_carrier_check" });
            rowLog.warn("label-purchase-reconciler.needs_carrier_check", {
              detail:
                "no shipment row committed for a stale RUNNING purchase; possible orphaned carrier charge",
            });
          } else {
            lostRace += 1;
            reconciledCounter.add(1, { outcome: "lost_race" });
          }
        }

        if (stale.length > 0) {
          log.info("label-purchase-reconciler.tick", {
            scanned: stale.length,
            committed,
            needsCarrierCheck,
            lostRace,
          });
        }

        return Object.freeze({ scanned: stale.length, committed, needsCarrierCheck, lostRace });
      });
    },
  };
}
