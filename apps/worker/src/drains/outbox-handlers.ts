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

import type { logger as loggerContract } from "@pharmax/platform-core";

import {
  dispatchVialPrintJob,
  noopVialPrintDelivery,
  type PrintJobClient,
  type VialPrintDeliveryPort,
} from "./dispatch-vial-print-job.js";
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
  readonly client: PrintJobClient;
  readonly delivery?: VialPrintDeliveryPort;
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

function createVialPrintOutboxHandler(deps: OutboxHandlerDeps): OutboxEventHandler {
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
  const vialPrintHandler = createVialPrintOutboxHandler(deps);
  return {
    "organization.created.v1": handleOrganizationCreatedV1,
    "labels.vial_print.requested.v1": vialPrintHandler,
    "labels.vial_print.reprint_requested.v1": vialPrintHandler,
  };
}
