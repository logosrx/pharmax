// Domain handlers for outbox events.
//
// Handler contract:
//   - Idempotent: the worker may retry on transient failure. Use
//     external-idempotency tokens (e.g. message ids in downstream
//     calls) where the downstream supports it.
//   - Side-effect bounded: a handler may publish to email/SMS/push,
//     write to read models, fire downstream HTTP calls. It MUST NOT
//     mutate workflow state — that is the command bus's job and would
//     bypass the audit/event/outbox chain.
//   - Throwing => drainer marks the row FAILED and reschedules with
//     exponential backoff.
//   - Returning normally => drainer marks the row DISPATCHED.
//   - NEVER log PHI; the payload field is best treated as opaque
//     and only specific non-PHI fields should be projected into
//     logs.
//
// Adding a new handler:
//   1. Implement a small named function in this file (or a sibling
//      `*.handler.ts` if it grows beyond ~30 lines).
//   2. Wire its entry into the `outboxHandlers` map keyed by the
//      versioned event name (e.g. `order.shipped.v1`).
//   3. Add a unit test that drives a fake `ClaimedOutboxEventRow`
//      through it.

import type { PrismaClient } from "@pharmax/database";
import { fanOutWebhookDeliveries, WEBHOOK_ELIGIBLE_EVENT_TYPES } from "@pharmax/partner-api";
import type { logger as loggerContract } from "@pharmax/platform-core";

import type { StripeInvoicePort } from "@pharmax/billing";
import type { TypingModelPort } from "@pharmax/typing-assist";

import {
  dispatchVialPrintJob,
  noopVialPrintDelivery,
  type PrintJobClient,
  type VialPrintDeliveryPort,
} from "./dispatch-vial-print-job.js";
import { createEscalateOnShipmentExceptionHandler } from "./escalate-on-shipment-exception.js";
import { createGenerateTypingSuggestionsHandler } from "./generate-typing-suggestions.js";
import { createMaterializeBillingOnOrderShippedHandler } from "./materialize-billing-on-order-shipped.js";
import { createNotifyOnOrderEscalatedHandler } from "./notify-on-order-escalated.js";
import { createNotifyProviderOnOrderShippedHandler } from "./notify-provider-on-order-shipped.js";
import { createNotifyOnReportRunCompletedHandler } from "./notify-on-report-run-completed.js";
import { createPushInvoiceToStripeHandler } from "./push-invoice-to-stripe.js";
import type { ClaimedOutboxEventRow } from "./row-types.js";

type Logger = loggerContract.Logger;

export interface OutboxHandlerContext {
  readonly logger: Logger;
  readonly receivedAt: Date;
}

export type OutboxEventHandler = (
  row: ClaimedOutboxEventRow,
  context: OutboxHandlerContext
) => Promise<void>;

export type OutboxHandlerMap = Readonly<Partial<Record<string, OutboxEventHandler>>>;

/**
 * Event types whose side effect is LOAD-BEARING: a row of one of
 * these types with no registered handler is a FAILURE (retry →
 * DEAD, visible in the dead-letter dashboard), never a silent
 * success. Every other event type without a handler is a benign
 * no-op (many workflow events exist for future consumers).
 *
 * Keep this in lock-step with `createOutboxHandlers` — every key
 * here MUST have a handler wired there. The registry-contract test
 * asserts that invariant so a typo cannot silently re-open the
 * "emergency alert marked DISPATCHED with no consumer" hole this
 * set exists to close.
 */
export const REQUIRED_HANDLER_EVENT_TYPES: ReadonlySet<string> = new Set([
  "labels.vial_print.requested.v1",
  "labels.vial_print.reprint_requested.v1",
  // Compound stock labels ride the same handoff. Without a registered
  // handler the job would sit PENDING forever and the print agent —
  // which only claims SENT — would never see it: a label that silently
  // never prints, which is the hole this set exists to close.
  "labels.compound_label.requested.v1",
  "shipment.tracking.recorded.v1",
  "order.shipped.v1",
  "billing.invoice.finalized.v1",
  "reporting.run.completed.v1",
  "order.escalated_to_emergency.v1",
  "order.sla_breach_escalated.v1",
  // A typing-suggestion run is created PENDING_MODEL and only this
  // handler settles it — with no consumer, runs would sit pending
  // forever and the technician's panel would silently show nothing.
  "ai.typing_suggestion_run.requested.v1",
]);

type OutboxHandlerDeps = {
  /**
   * Narrow slice for the vial-print handler — `print_job` /
   * `label_printer` reads + updates. Kept narrow so the unit
   * tests can fake just these tables without standing up a
   * full PrismaClient mock.
   */
  readonly client: PrintJobClient;
  /**
   * Full Prisma client for handlers that need cross-tenant reads
   * in system context plus the command bus (notably the
   * shipment-exception escalation handler). The split keeps the
   * vial-print fake small while the escalation handler gets the
   * real client surface it needs.
   */
  readonly prisma: PrismaClient;
  readonly delivery?: VialPrintDeliveryPort;
  /**
   * Production Stripe port. When `null`, the
   * `billing.invoice.finalized.v1` handler logs + no-ops (no retry
   * storm against an unconfigured Stripe). Wired only in
   * environments that have `STRIPE_SECRET_KEY` set.
   */
  readonly stripePort?: StripeInvoicePort | null;
  /**
   * Base URL of the operator console used by the scheduled-report
   * notification handler to build deep-link "open in Pharmax"
   * buttons. Defaults to "http://localhost:3000" in dev — set
   * `OPS_CONSOLE_BASE_URL` in production.
   */
  readonly opsConsoleBaseUrl?: string;
  /**
   * Bedrock port for the typing-suggestion model stage. When `null`
   * (no BEDROCK_TYPING_MODEL_ID configured), the handler still
   * settles each run — as FAILED("MODEL_NOT_CONFIGURED") — so the
   * gap is visible on the run row rather than a stuck PENDING_MODEL.
   */
  readonly typingModelPort?: TypingModelPort | null;
};

/**
 * organization.created.v1
 *
 * Emitted by the CreateOrganization system command after a new
 * organization, its system role clones, its admin user, and the v1
 * workflow policy are persisted. Phase 1 only LOGS the event —
 * proving that the bus → outbox → drainer → handler path works
 * end-to-end. Future work (Phase 2+):
 *   - send the admin's invitation email via @pharmax/notifications
 *   - register the organization with the billing provider (Stripe)
 *   - seed default buckets via a follow-up command
 */
const handleOrganizationCreatedV1: OutboxEventHandler = async (row, ctx) => {
  // PHI-safe projection: only org id + non-PHI metadata. We
  // intentionally avoid logging the admin's email even though it
  // is technically not protected health information — defense in
  // depth: keep account identifiers out of logs by default.
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  ctx.logger.info("outbox.organization.created.v1 dispatched", {
    outboxId: row.id,
    organizationId: row.organizationId,
    aggregateId: row.aggregateId,
    slug: typeof payload["slug"] === "string" ? payload["slug"] : undefined,
    occurredAt: typeof payload["occurredAt"] === "string" ? payload["occurredAt"] : undefined,
  });
};

interface VialPrintOutboxHandlerDeps {
  readonly client: PrintJobClient;
  readonly delivery?: VialPrintDeliveryPort;
}

function createVialPrintOutboxHandler(deps: VialPrintOutboxHandlerDeps): OutboxEventHandler {
  const delivery = deps.delivery ?? noopVialPrintDelivery;

  return async (row, ctx) => {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const printJobId =
      typeof payload["printJobId"] === "string" ? payload["printJobId"] : row.aggregateId;
    const contentHashHex =
      typeof payload["contentHashHex"] === "string" ? payload["contentHashHex"] : undefined;

    await dispatchVialPrintJob({
      client: deps.client,
      delivery,
      logger: ctx.logger,
      organizationId: row.organizationId,
      printJobId,
      ...(contentHashHex !== undefined ? { contentHashHex } : {}),
    });
  };
}

/** Default registry for unit tests that do not need DB-backed handlers. */
export const outboxHandlers: OutboxHandlerMap = {
  "organization.created.v1": handleOrganizationCreatedV1,
};

/**
 * Post-handler hook signature the outbox drainer runs for EVERY
 * claimed row (after the domain handler, inside the same try) —
 * see `OutboxDrainerDeps.postHandlerHook`.
 */
export type OutboxPostHandlerHook = (
  row: ClaimedOutboxEventRow,
  context: OutboxHandlerContext
) => Promise<void>;

/**
 * Partner webhook fan-out as a drainer post-handler hook (ADR-0032).
 *
 * Runs for every outbox row and SELF-FILTERS: non-eligible event
 * types (anything not registered phi-safe) return immediately with
 * no DB work, so this is not registered per-event-type in the
 * handler map — the map stays a pure domain-handler registry (the
 * registry-contract test pins that) while every phi-safe event
 * still fans out to matching ACTIVE subscriptions.
 *
 * Ordering + retry semantics: a hook throw routes the row through
 * the drainer's FAILED/backoff path. Fan-out is idempotent on
 * (subscriptionId, outboxEventId) via `skipDuplicates`, and domain
 * handlers are idempotent by contract, so a retry after either
 * side's failure is safe in both directions.
 */
export function createWebhookFanOutHook(
  client: Pick<PrismaClient, "$transaction">
): OutboxPostHandlerHook {
  return async (row, ctx) => {
    if (!WEBHOOK_ELIGIBLE_EVENT_TYPES.has(row.eventType)) {
      return;
    }
    await fanOutWebhookDeliveries({
      client,
      event: {
        id: row.id,
        organizationId: row.organizationId,
        eventType: row.eventType,
        payload: row.payload,
      },
      logger: ctx.logger,
    });
  };
}

/**
 * Run several handlers for ONE event type, in order. Used when an
 * event has more than one load-bearing consumer (e.g.
 * `order.shipped.v1` → billing materialization + prescriber
 * notification). A throw from ANY constituent routes the row through
 * the drainer's FAILED/backoff path and re-runs ALL of them —
 * every constituent must therefore be idempotent (which the handler
 * contract already requires).
 */
function composeOutboxHandlers(...handlers: ReadonlyArray<OutboxEventHandler>): OutboxEventHandler {
  return async (row, context) => {
    for (const handler of handlers) {
      await handler(row, context);
    }
  };
}

/** Production registry wired from apps/worker main with Prisma + delivery port. */
export function createOutboxHandlers(deps: OutboxHandlerDeps): OutboxHandlerMap {
  const vialPrintHandler = createVialPrintOutboxHandler({
    client: deps.client,
    ...(deps.delivery !== undefined ? { delivery: deps.delivery } : {}),
  });
  const escalationHandler = createEscalateOnShipmentExceptionHandler({ client: deps.prisma });
  const billingMaterializationHandler = createMaterializeBillingOnOrderShippedHandler();
  const stripePushHandler = createPushInvoiceToStripeHandler({
    client: deps.prisma,
    stripePort: deps.stripePort ?? null,
  });
  const reportRunNotifyHandler = createNotifyOnReportRunCompletedHandler({
    client: deps.prisma,
    opsConsoleBaseUrl: deps.opsConsoleBaseUrl ?? "http://localhost:3000",
  });
  const escalationNotifyHandler = createNotifyOnOrderEscalatedHandler({ client: deps.prisma });
  const providerShipNotifyHandler = createNotifyProviderOnOrderShippedHandler({
    client: deps.prisma,
  });
  const typingSuggestionsHandler = createGenerateTypingSuggestionsHandler({
    client: deps.prisma,
    modelPort: deps.typingModelPort ?? null,
  });
  return {
    "organization.created.v1": handleOrganizationCreatedV1,
    "labels.vial_print.requested.v1": vialPrintHandler,
    "labels.vial_print.reprint_requested.v1": vialPrintHandler,
    // Same PENDING → SENT handoff: the dispatcher keys off the print
    // job row, which already knows what it is labelling.
    "labels.compound_label.requested.v1": vialPrintHandler,
    "shipment.tracking.recorded.v1": escalationHandler,
    // Billing materialization first (financial truth), then the
    // prescriber portal notification — composed because both are
    // load-bearing consumers of the same event.
    "order.shipped.v1": composeOutboxHandlers(
      billingMaterializationHandler,
      providerShipNotifyHandler
    ),
    "billing.invoice.finalized.v1": stripePushHandler,
    "reporting.run.completed.v1": reportRunNotifyHandler,
    // Emergency-bucket alerts. Both events were previously produced
    // with NO consumer, so escalations never notified anyone.
    "order.escalated_to_emergency.v1": escalationNotifyHandler,
    "order.sla_breach_escalated.v1": escalationNotifyHandler,
    "ai.typing_suggestion_run.requested.v1": typingSuggestionsHandler,
  };
}
