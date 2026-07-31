// Outbox → webhook_delivery fan-out (ADR-0032).
//
// Called from the worker's outbox drainer for every webhook-eligible
// event row. Semantics:
//
//   - Registry-validated only: the payload is validated against the
//     event registry BEFORE any delivery row is created. An invalid
//     payload means a producer bug; delivering unvalidated data to a
//     partner is worse than not delivering, so the row is logged and
//     SKIPPED (never thrown — a fan-out skip must not fail the
//     underlying domain handler's dispatch).
//   - Idempotent under outbox retries: `createMany` with
//     `skipDuplicates` against the (subscriptionId, outboxEventId)
//     unique pair.
//   - Runs in a system-context frame (the worker owns no tenancy);
//     the WHERE is explicitly org-scoped, and later reads of the
//     ledger are RLS + auto-filter protected.
//
// PHI: eligible events are phi-safe by construction; this module
// never logs payload contents.

import type { PrismaClient } from "@pharmax/database";
import { getEventDefinition } from "@pharmax/events";
import type { logger as loggerContract } from "@pharmax/platform-core";
import { currentTraceparent } from "@pharmax/telemetry";
import {
  applySystemSessionGuc,
  withSystemContext,
  type SessionGucExecutor,
} from "@pharmax/tenancy";

import { isWebhookEligibleEventType } from "./eligible-events.js";

type Logger = loggerContract.Logger;

/** Structural slice of a claimed outbox row — no worker import. */
export interface FanOutSourceEvent {
  readonly id: string;
  readonly organizationId: string;
  readonly eventType: string;
  readonly payload: unknown;
}

export type FanOutClient = Pick<PrismaClient, "$transaction">;

export interface FanOutResult {
  readonly created: number;
  readonly skippedReason: "not_eligible" | "invalid_payload" | "no_subscriptions" | null;
}

export async function fanOutWebhookDeliveries(input: {
  readonly client: FanOutClient;
  readonly event: FanOutSourceEvent;
  readonly logger: Logger;
}): Promise<FanOutResult> {
  const { event, logger } = input;

  if (!isWebhookEligibleEventType(event.eventType)) {
    return Object.freeze({ created: 0, skippedReason: "not_eligible" as const });
  }

  const definition = getEventDefinition(event.eventType);
  const parsed = definition?.schema.safeParse(event.payload);
  if (definition === undefined || parsed === undefined || !parsed.success) {
    // Producer bug: the payload does not match its registered schema.
    // Never egress unvalidated data; skip and surface loudly.
    logger.error("webhook.fan_out.payload_failed_registry_validation", {
      outboxEventId: event.id,
      eventType: event.eventType,
      organizationId: event.organizationId,
    });
    return Object.freeze({ created: 0, skippedReason: "invalid_payload" as const });
  }

  const reason = "@pharmax/partner-api:webhook-fan-out";
  // Fan-out runs inside the outbox drainer's consumer span, so the
  // active trace context here already links back to the producing
  // command. Persisting it lets the delivery drainer resume the same
  // trace across the second DB-backed hop.
  const traceparent = currentTraceparent();
  const created = await withSystemContext(reason, () =>
    input.client.$transaction(async (tx) => {
      await applySystemSessionGuc(tx as unknown as SessionGucExecutor, reason);

      const subscriptions = await tx.webhookSubscription.findMany({
        where: {
          organizationId: event.organizationId,
          status: "ACTIVE",
          eventTypes: { has: event.eventType },
        },
        select: { id: true },
      });
      if (subscriptions.length === 0) {
        return 0;
      }

      const result = await tx.webhookDelivery.createMany({
        data: subscriptions.map((s) => ({
          organizationId: event.organizationId,
          subscriptionId: s.id,
          outboxEventId: event.id,
          eventType: event.eventType,
          payload: parsed.data as object,
          traceparent,
        })),
        skipDuplicates: true,
      });
      return result.count;
    })
  );

  if (created > 0) {
    logger.info("webhook.fan_out.deliveries_created", {
      outboxEventId: event.id,
      eventType: event.eventType,
      organizationId: event.organizationId,
      created,
    });
  }

  return Object.freeze({
    created,
    skippedReason: created === 0 ? ("no_subscriptions" as const) : null,
  });
}
