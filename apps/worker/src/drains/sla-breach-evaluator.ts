// SLA breach evaluator — per-tick logic.
//
// Each tick:
//   1. Claim up to `batchSize` orders past their `slaDeadlineAt`
//      that are non-terminal and NOT already in EMERGENCY, in
//      system context (cross-tenant), via SELECT FOR UPDATE SKIP
//      LOCKED.
//   2. For each order, enter the org's tenancy under the per-org
//      `shipping-webhook@<org-slug>.test` machine identity (the
//      same identity that runs the shipment-exception escalation;
//      it holds `orders.escalate_sla` via the WebhookService role)
//      and dispatch `EscalateOrderForSlaBreach`.
//   3. Per-order failures are isolated. A missing service user is
//      a config error → SKIPPED; a command throw → FAILED. Neither
//      blocks the rest of the batch.
//
// Why no per-order "advance" step (unlike report-scheduler): an
// order doesn't carry a next-fire cursor. Once escalated it leaves
// the claim result set (its bucket is now EMERGENCY), so it won't
// be re-claimed. The idempotency key guards the brief
// claim→dispatch race.
//
// Why the dispatcher isn't itself a bus command: it's pure worker
// infrastructure that mutates nothing until the inner
// EscalateOrderForSlaBreach tx commits (which writes its own
// audit/outbox). An outer command would add a pointless tx layer.

import { executeCommand } from "@pharmax/command-bus";
import type { PrismaClient } from "@pharmax/database";
import { errors, ids } from "@pharmax/platform-core";
import type { logger as loggerContract } from "@pharmax/platform-core";
import { EscalateOrderForSlaBreach } from "@pharmax/orders";
import { intervalKindForOrderState } from "@pharmax/sla";
import { getMeter } from "@pharmax/telemetry";
import type { OrderState } from "@pharmax/workflow";
import { buildTenancyContext, withSystemContext, withTenancyContext } from "@pharmax/tenancy";

import {
  claimBreachedOrders,
  type BreachedOrderClaimClient,
  type BreachedOrderRow,
} from "./claim-breached-orders.js";

type Logger = loggerContract.Logger;

const meter = getMeter("@pharmax/worker.sla");

// Counts orders that crossed their end-to-end SLA deadline and were
// newly escalated into the EMERGENCY bucket. `stage` is the canonical
// SLA interval kind the order occupied at breach time (e.g.
// TYPING_ACTIVE, WAIT_BEFORE_PV1) — NOT the raw workflow status — so
// the series aligns with `pharmax_workflow_stage_duration_seconds`.
// No PHI in labels: stage is a closed enum, never an order/patient id.
const slaBreachesCounter = meter.createCounter("pharmax_workflow_sla_breaches_total", {
  description:
    "Orders that breached their end-to-end SLA deadline and were newly escalated to EMERGENCY, labelled by the SLA stage occupied at breach time.",
});

// Maps the order's workflow status at breach time to the stage label.
// Terminal states are excluded by the claim query, so a null mapping
// only happens for an unrecognized status — bucket it as "UNKNOWN"
// rather than dropping the breach from the count.
function breachStageLabel(currentStatus: string): string {
  const kind = intervalKindForOrderState(currentStatus as OrderState);
  return kind ?? "UNKNOWN";
}

export interface SlaBreachEvaluatorDeps {
  readonly client: PrismaClient & BreachedOrderClaimClient;
  readonly logger: Logger;
  /**
   * Local-part of the per-org machine identity used to enter
   * tenancy. Defaults to `shipping-webhook` (the WebhookService
   * role holds `orders.escalate_sla`). Full email is
   * `${actorEmailLocalPart}@${org.slug}.test`.
   */
  readonly actorEmailLocalPart?: string;
}

export interface SlaBreachEvaluatorOptions {
  readonly batchSize: number;
}

export interface SlaBreachEvaluatorTickResult {
  readonly claimed: number;
  readonly escalated: number;
  readonly alreadyEscalated: number;
  readonly failed: number;
  readonly skipped: number;
}

export function createSlaBreachEvaluator(
  deps: SlaBreachEvaluatorDeps,
  options: SlaBreachEvaluatorOptions
): { tick: () => Promise<SlaBreachEvaluatorTickResult> } {
  const log = deps.logger.child({ component: "sla-breach-evaluator" });
  const actorEmailLocalPart = deps.actorEmailLocalPart ?? "shipping-webhook";

  return {
    async tick(): Promise<SlaBreachEvaluatorTickResult> {
      const dueRows = await withSystemContext(
        "worker:sla-breach-evaluator:claim",
        async () => await claimBreachedOrders(deps.client, { batchSize: options.batchSize })
      );

      if (dueRows.length === 0) {
        return Object.freeze({
          claimed: 0,
          escalated: 0,
          alreadyEscalated: 0,
          failed: 0,
          skipped: 0,
        });
      }
      log.info("sla-breach-evaluator.claimed", { claimed: dueRows.length });

      let escalated = 0;
      let alreadyEscalated = 0;
      let failed = 0;
      let skipped = 0;

      for (const row of dueRows) {
        const outcome = await processOrder({ ...deps, actorEmailLocalPart, log }, row);
        switch (outcome) {
          case "ESCALATED":
            escalated += 1;
            break;
          case "ALREADY_ESCALATED":
            alreadyEscalated += 1;
            break;
          case "FAILED":
            failed += 1;
            break;
          case "SKIPPED":
            skipped += 1;
            break;
        }
      }

      return Object.freeze({
        claimed: dueRows.length,
        escalated,
        alreadyEscalated,
        failed,
        skipped,
      });
    },
  };
}

type Outcome = "ESCALATED" | "ALREADY_ESCALATED" | "FAILED" | "SKIPPED";

async function processOrder(
  deps: {
    readonly client: PrismaClient;
    readonly log: Logger;
    readonly actorEmailLocalPart: string;
  },
  row: BreachedOrderRow
): Promise<Outcome> {
  const now = new Date();

  const resolved = await withSystemContext(
    "worker:sla-breach-evaluator:resolve-actor",
    async () => {
      const org = await deps.client.organization.findUnique({
        where: { id: row.organizationId },
        select: { slug: true },
      });
      if (org === null) return null;
      const actor = await deps.client.user.findFirst({
        where: {
          organizationId: row.organizationId,
          email: `${deps.actorEmailLocalPart}@${org.slug}.test`,
        },
        select: { id: true },
      });
      return actor === null ? null : { actorUserId: actor.id };
    }
  );

  if (resolved === null) {
    deps.log.warn("sla-breach-evaluator.skipped_no_actor", {
      event: "sla-breach-evaluator.skipped_no_actor",
      orderId: row.id,
      organizationId: row.organizationId,
    });
    return "SKIPPED";
  }

  const tenancy = buildTenancyContext({
    organizationId: row.organizationId,
    actor: { userId: resolved.actorUserId, correlationId: ids.generateUlid() },
  });

  try {
    const out = await withTenancyContext(tenancy, () =>
      executeCommand(
        EscalateOrderForSlaBreach,
        {
          orderId: row.id,
          slaDeadlineAt: row.slaDeadlineAt.toISOString(),
          breachedAt: now.toISOString(),
        },
        {
          // Keyed on (order, deadline) so re-ticks during the brief
          // claim→commit race are bus-level no-ops, while a future
          // re-deadlined breach (different deadline) re-escalates.
          idempotencyKey: `sla-escalate:${row.id}:${row.slaDeadlineAt.getTime()}`,
        }
      )
    );
    if (out.alreadyEscalated) {
      return "ALREADY_ESCALATED";
    }
    // Count only genuine first-time escalations. Idempotent re-ticks
    // during the claim→commit race return early above, so the counter
    // tracks distinct breaches, not claim attempts.
    slaBreachesCounter.add(1, { stage: breachStageLabel(row.currentStatus) });
    deps.log.info("sla-breach-evaluator.escalated", {
      event: "sla-breach-evaluator.escalated",
      orderId: row.id,
      organizationId: row.organizationId,
      previousBucketId: out.previousBucketId,
    });
    return "ESCALATED";
  } catch (cause) {
    const code =
      cause instanceof errors.PharmaxError ? cause.code : "SLA_BREACH_EVALUATOR_DISPATCH_FAILED";
    deps.log.error("sla-breach-evaluator.dispatch_failed", {
      event: "sla-breach-evaluator.dispatch_failed",
      orderId: row.id,
      organizationId: row.organizationId,
      code,
      error: cause,
    });
    return "FAILED";
  }
}
