// Outbox handler for `shipment.tracking.recorded.v1` events that
// move the related order into the EMERGENCY bucket when the
// recorded tracking event represents a delivery failure
// (EXCEPTION / FAILED_DELIVERY / RETURN_TO_SENDER).
//
// Why an outbox handler and not a downstream call inside
// `RecordShipmentTrackingEvent`:
//   - The tracking-event command runs in the per-org tenancy of the
//     shipment owner; that's the right place to write the ledger
//     row. But it should NOT take an order lock or write order_event
//     in the same tx — that's a second aggregate with its own CAS
//     and audit chain, and conflating them turns one webhook into
//     an order-bucket-CAS retry storm under load.
//   - Splitting via the outbox keeps each command "single aggregate,
//     single tx" and lets the bus / retry policy handle escalation
//     independently. A failed escalation does NOT roll back the
//     tracking-event ledger entry (and it shouldn't — the carrier
//     state is durable even if internal bucket routing has to retry).
//
// Idempotency:
//   - The bus's idempotency cache is keyed on
//     `"escalate:{shipmentId}:{externalEventId}"`, so a redelivery
//     of the same outbox row short-circuits before hitting the DB.
//   - The command itself is also idempotent at the row level (the
//     "already in EMERGENCY" branch writes audit but no mutation).
//
// PHI: no PHI is read here. The outbox payload is non-PHI by
// design (tracking event ledger + bucket routing); we project a
// narrow set of fields out of it and call the command.

import { executeCommand } from "@pharmax/command-bus";
import type { PrismaClient } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import {
  ESCALATION_REASONS,
  EscalateOrderToEmergencyBucket,
  type EscalationReason,
} from "@pharmax/shipping";
import { getMeter } from "@pharmax/telemetry";
import { buildTenancyContext, withSystemContext, withTenancyContext } from "@pharmax/tenancy";
import { ulid } from "ulid";

import type { OutboxEventHandler } from "./outbox-handlers.js";

const meter = getMeter("@pharmax/worker.shipping");

const shippingEscalationsCreatedCounter = meter.createCounter(
  "pharmax_shipping_escalations_created_total",
  {
    description:
      "Orders moved into the EMERGENCY bucket via EscalateOrderToEmergencyBucket. Excludes idempotent re-escalations (`alreadyEscalated=true`).",
  }
);

export interface CreateEscalateOnShipmentExceptionHandlerOptions {
  readonly client: PrismaClient;
  /**
   * Local part of the per-org service-user email
   * (`<emailLocalPart>@<org-slug>.test`). Defaults to
   * `"shipping-webhook"` to match the seed convention. A future
   * production tenant-scoped role (see Phase 4 remaining items)
   * will narrow the permission scope of this user.
   */
  readonly emailLocalPart?: string;
}

const KIND_TO_REASON: Readonly<Record<string, EscalationReason>> = Object.freeze({
  EXCEPTION: "EXCEPTION",
  FAILED_DELIVERY: "FAILED_DELIVERY",
  RETURN_TO_SENDER: "RETURN_TO_SENDER",
});

function isEscalationKind(kind: unknown): kind is keyof typeof KIND_TO_REASON {
  return typeof kind === "string" && ESCALATION_REASONS.includes(kind as EscalationReason);
}

function readString(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Resolve the per-org service user for an escalation dispatch.
 *
 * The escalation command runs in the org's tenancy; we need an
 * actor user id to populate `ctx.actor.userId` on the command.
 * Uses the same `shipping-webhook@<org-slug>.test` service user
 * the EasyPost target resolver uses — keeps escalations and
 * tracking-event records under one consistent actor for the
 * order timeline.
 */
async function resolveActorUserId(input: {
  client: PrismaClient;
  organizationId: string;
  emailLocalPart: string;
}): Promise<string | null> {
  return withSystemContext("worker-drain:escalate-actor-resolve", async () => {
    const org = await input.client.organization.findUnique({
      where: { id: input.organizationId },
      select: { slug: true },
    });
    if (org === null) {
      return null;
    }
    const user = await input.client.user.findFirst({
      where: {
        organizationId: input.organizationId,
        email: `${input.emailLocalPart}@${org.slug}.test`,
      },
      select: { id: true },
    });
    return user?.id ?? null;
  });
}

export function createEscalateOnShipmentExceptionHandler(
  options: CreateEscalateOnShipmentExceptionHandlerOptions
): OutboxEventHandler {
  const { client } = options;
  const emailLocalPart = options.emailLocalPart ?? "shipping-webhook";

  return async (row, ctx): Promise<void> => {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const kind = payload["kind"];
    if (!isEscalationKind(kind)) {
      // Not a failure kind — escalation does not apply. Return
      // normally so the drainer marks the row DISPATCHED.
      return;
    }

    const organizationId = readString(payload, "organizationId") ?? row.organizationId;
    const orderId = readString(payload, "orderId");
    const shipmentId = readString(payload, "shipmentId") ?? row.aggregateId;
    const trackingEventId = readString(payload, "trackingEventId");
    const externalEventId = readString(payload, "externalEventId");
    const carrierStatus = readString(payload, "carrierStatus");
    const occurredAt = readString(payload, "occurredAt");

    if (
      orderId === null ||
      shipmentId === null ||
      trackingEventId === null ||
      externalEventId === null ||
      carrierStatus === null ||
      occurredAt === null
    ) {
      // The producer (`RecordShipmentTrackingEvent`) emits all of
      // these; a missing field means a malformed / legacy outbox
      // row. Surface loudly rather than silently dropping the
      // escalation.
      throw new errors.InternalError({
        code: "ESCALATE_HANDLER_PAYLOAD_INCOMPLETE",
        message:
          "shipment.tracking.recorded.v1 payload is missing one or more required escalation fields.",
        metadata: {
          outboxId: row.id,
          present: {
            orderId: orderId !== null,
            shipmentId: shipmentId !== null,
            trackingEventId: trackingEventId !== null,
            externalEventId: externalEventId !== null,
            carrierStatus: carrierStatus !== null,
            occurredAt: occurredAt !== null,
          },
        },
      });
    }

    const actorUserId = await resolveActorUserId({
      client,
      organizationId,
      emailLocalPart,
    });
    if (actorUserId === null) {
      // No service user means RBAC will reject the command anyway;
      // surface the misconfiguration loudly so an operator wires
      // the service user (see `prisma/seed.ts`).
      throw new errors.InternalError({
        code: "ESCALATE_HANDLER_NO_SERVICE_USER",
        message: `No service user "${emailLocalPart}@<org-slug>.test" found for organization "${organizationId}".`,
        metadata: { organizationId, outboxId: row.id },
      });
    }

    const reason = KIND_TO_REASON[kind];
    const tenancy = buildTenancyContext({
      organizationId,
      actor: { userId: actorUserId, correlationId: ulid() },
    });

    const result = await withTenancyContext(tenancy, async () =>
      executeCommand(
        EscalateOrderToEmergencyBucket,
        {
          orderId,
          shipmentId,
          trackingEventId,
          externalEventId,
          reason,
          carrierStatus,
          occurredAt,
        },
        { idempotencyKey: `escalate:${shipmentId}:${externalEventId}` }
      )
    );

    if (!result.alreadyEscalated) {
      shippingEscalationsCreatedCounter.add(1);
    }

    ctx.logger.info("outbox.shipment.tracking.recorded.v1 escalated", {
      outboxId: row.id,
      organizationId,
      orderId,
      shipmentId,
      reason,
      alreadyEscalated: result.alreadyEscalated,
      previousBucketId: result.previousBucketId,
    });
  };
}
