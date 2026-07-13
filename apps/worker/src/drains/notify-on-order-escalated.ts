// Outbox handler for emergency-bucket escalations:
//
//   - `order.escalated_to_emergency.v1`  (shipment exception path)
//   - `order.sla_breach_escalated.v1`    (SLA breach path)
//
// Both events mean "an order just landed in the EMERGENCY bucket
// and a human must look at it". Before this handler existed the
// events were produced but nothing consumed them — the drainer
// marked the rows DISPATCHED and the alert silently never fired,
// which is the single worst failure mode for an emergency queue.
//
// Recipients (v1): every ACTIVE user holding the org-wide
// `OrgAdmin` role. There is no per-org "ops lead" recipient
// configuration yet; when that surface ships, this resolver is the
// one place to swap. Deliveries go out as email (the production
// channel transport); each recipient is isolated the same way the
// scheduled-report fan-out is — one bounce does not abort the
// rest, and the handler throws (→ outbox retry/backoff) only when
// EVERY recipient failed.
//
// Idempotency: per-recipient key `escalation-notify:{outboxRowId}:
// {recipient}` — a retried outbox row re-sends with the same keys
// and the channel dedupes. Reaffirmed escalations are separate
// outbox rows and legitimately notify again.
//
// PHI: context carries the internal/external order number, reason
// codes, and ISO timestamps only. The channel's PHI sentinel gate
// is the structural backstop.

import type { PrismaClient } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import {
  getNotificationChannel,
  NOTIFICATIONS_NOT_CONFIGURED,
  type NotificationTemplateId,
} from "@pharmax/notifications";
import { withSystemContext } from "@pharmax/tenancy";

import type { OutboxEventHandler } from "./outbox-handlers.js";

export interface CreateNotifyOnOrderEscalatedHandlerOptions {
  readonly client: PrismaClient;
}

const OPS_ALERT_ROLE_CODE = "OrgAdmin";

export function createNotifyOnOrderEscalatedHandler(
  options: CreateNotifyOnOrderEscalatedHandlerOptions
): OutboxEventHandler {
  return async (row, ctx) => {
    const payload = (row.payload ?? {}) as Record<string, unknown>;

    // SKIP gate — notifications not configured (dev environments).
    // Same benign-skip contract as the scheduled-report handler.
    let channel: ReturnType<typeof getNotificationChannel>;
    try {
      channel = getNotificationChannel();
    } catch (cause) {
      const code =
        cause instanceof errors.PharmaxError ? cause.code : "NOTIFICATION_CHANNEL_RESOLVE_FAILED";
      if (code === NOTIFICATIONS_NOT_CONFIGURED) {
        ctx.logger.info("outbox.notify_escalation.skipped_no_channel", {
          outboxId: row.id,
          eventType: row.eventType,
          orderId: row.aggregateId,
        });
        return;
      }
      throw cause;
    }

    const orderId = String(payload["orderId"] ?? row.aggregateId);

    // Resolve the order's display number + the alert recipients in
    // system context (this drain runs cross-tenant; org scoping is
    // explicit on every query).
    const resolved = await withSystemContext(
      "worker-drain:notify-escalation.load-order-and-recipients",
      async () => {
        const order = await options.client.order.findFirst({
          where: { id: orderId, organizationId: row.organizationId },
          select: { id: true, externalOrderNumber: true },
        });
        const admins = await options.client.user.findMany({
          where: {
            organizationId: row.organizationId,
            status: "ACTIVE",
            userRoles: {
              some: {
                organizationId: row.organizationId,
                role: { code: OPS_ALERT_ROLE_CODE },
              },
            },
          },
          select: { id: true, email: true },
        });
        return { order, admins };
      }
    );

    if (resolved.order === null) {
      // Poison payload (order deleted / cross-org id). Log + drop —
      // retrying cannot succeed.
      ctx.logger.error("outbox.notify_escalation.order_not_found", {
        outboxId: row.id,
        eventType: row.eventType,
        orderId,
      });
      return;
    }
    if (resolved.admins.length === 0) {
      ctx.logger.warn("outbox.notify_escalation.no_recipients", {
        outboxId: row.id,
        eventType: row.eventType,
        orderId,
        roleCode: OPS_ALERT_ROLE_CODE,
      });
      return;
    }

    const orderExternalNumber = resolved.order.externalOrderNumber ?? resolved.order.id;
    const { template, context } = composeTemplate(row.eventType, orderExternalNumber, payload);

    let succeeded = 0;
    const failures: Array<{ code: string; message: string }> = [];

    for (const admin of resolved.admins) {
      try {
        await channel.send({
          to: { kind: "email", address: admin.email },
          template,
          context,
          idempotencyKey: `escalation-notify:${row.id}:${admin.id}`,
          organizationId: row.organizationId,
          correlationId: row.id,
        });
        succeeded += 1;
      } catch (cause) {
        const code =
          cause instanceof errors.PharmaxError ? cause.code : "NOTIFICATION_TRANSPORT_ERROR";
        const message = cause instanceof Error ? cause.message : "Notification send failed.";
        failures.push({ code, message });
        // Recipient user id only — not the email address — in logs.
        ctx.logger.warn("outbox.notify_escalation.recipient_failed", {
          outboxId: row.id,
          eventType: row.eventType,
          orderId,
          recipientUserId: admin.id,
          code,
          error: cause,
        });
      }
    }

    if (failures.length > 0) {
      // ANY failed recipient → throw so the drainer retries with
      // backoff. Safe for the recipients that already succeeded:
      // the per-recipient idempotency key means the retry replays
      // them as `deduplicated` and only failed recipients re-send.
      // An emergency alert that missed even one ops lead must not
      // be marked dispatched.
      throw new errors.InternalError({
        code:
          succeeded === 0
            ? "ESCALATION_NOTIFY_ALL_RECIPIENTS_FAILED"
            : "ESCALATION_NOTIFY_SOME_RECIPIENTS_FAILED",
        message: `Emergency escalation notification failed for ${failures.length} of ${failures.length + succeeded} recipient(s); retrying (successes dedupe).`,
        metadata: {
          outboxId: row.id,
          eventType: row.eventType,
          orderId,
          succeeded,
          failed: failures.length,
          firstFailureCode: failures[0]?.code,
        },
      });
    }

    ctx.logger.info("outbox.notify_escalation.dispatched", {
      outboxId: row.id,
      eventType: row.eventType,
      orderId,
      recipients: resolved.admins.length,
      succeeded,
      failed: failures.length,
    });
  };
}

function composeTemplate(
  eventType: string,
  orderExternalNumber: string,
  payload: Record<string, unknown>
): { template: NotificationTemplateId; context: Readonly<Record<string, unknown>> } {
  if (eventType === "order.sla_breach_escalated.v1") {
    return {
      template: "ORDER_SLA_BREACH_ESCALATED_V1",
      context: {
        orderExternalNumber,
        slaDeadlineAtIso: String(payload["slaDeadlineAt"] ?? ""),
        breachedAtIso: String(payload["breachedAt"] ?? ""),
      },
    };
  }
  return {
    template: "SHIPMENT_ESCALATED_V1",
    context: {
      orderExternalNumber,
      escalationReason: String(payload["reason"] ?? "UNKNOWN"),
      lastTrackingStatus: String(payload["carrierStatus"] ?? "UNKNOWN"),
    },
  };
}
