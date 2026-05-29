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
import type { logger as loggerContract } from "@pharmax/platform-core";

import type { StripeInvoicePort } from "@pharmax/billing";

import {
  dispatchVialPrintJob,
  noopVialPrintDelivery,
  type PrintJobClient,
  type VialPrintDeliveryPort,
} from "./dispatch-vial-print-job.js";
import { createEscalateOnShipmentExceptionHandler } from "./escalate-on-shipment-exception.js";
import { createMaterializeBillingOnOrderShippedHandler } from "./materialize-billing-on-order-shipped.js";
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
  return {
    "organization.created.v1": handleOrganizationCreatedV1,
    "labels.vial_print.requested.v1": vialPrintHandler,
    "labels.vial_print.reprint_requested.v1": vialPrintHandler,
    "shipment.tracking.recorded.v1": escalationHandler,
    "order.shipped.v1": billingMaterializationHandler,
    "billing.invoice.finalized.v1": stripePushHandler,
    "reporting.run.completed.v1": reportRunNotifyHandler,
  };
}
