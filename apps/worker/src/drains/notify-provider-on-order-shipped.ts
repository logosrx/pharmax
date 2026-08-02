// Outbox handler: prescriber shipment notification (ADR-0033,
// slice 3). Consumes `order.shipped.v1` ALONGSIDE the billing
// materializer (composed in `createOutboxHandlers`) and emails every
// prescriber who (a) wrote a prescription on the shipped order and
// (b) holds an ACTIVE provider-portal account.
//
// Portal enrollment is the opt-in: providers without a portal
// account are silently skipped — no address book exists for them,
// and mailing un-enrolled prescribers would be unsolicited.
//
// Idempotency: per-recipient key
// `portal-ship-notify:{outboxRowId}:{portalAccountId}` — a retried
// row re-sends with the same keys and the channel dedupes. Combined
// with the billing materializer's own idempotency, the composed
// handler is safe to retry as a unit.
//
// PHI: the context carries the order's external number, the
// prescriber's OWN rx numbers, the tracking number, and an ISO
// timestamp — no patient fields. The channel's PHI sentinel gate is
// the structural backstop.

import type { PrismaClient } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { getNotificationChannel, NOTIFICATIONS_NOT_CONFIGURED } from "@pharmax/notifications";
import { withSystemContext } from "@pharmax/tenancy";

import type { OutboxEventHandler } from "./outbox-handlers.js";

export interface CreateNotifyProviderOnOrderShippedHandlerOptions {
  readonly client: PrismaClient;
}

interface ProviderRecipient {
  readonly portalAccountId: string;
  readonly email: string;
  readonly rxNumbers: ReadonlyArray<string>;
}

export function createNotifyProviderOnOrderShippedHandler(
  options: CreateNotifyProviderOnOrderShippedHandlerOptions
): OutboxEventHandler {
  return async (row, ctx) => {
    const payload = (row.payload ?? {}) as Record<string, unknown>;

    // SKIP gate — notifications not configured (dev environments).
    let channel: ReturnType<typeof getNotificationChannel>;
    try {
      channel = getNotificationChannel();
    } catch (cause) {
      const code =
        cause instanceof errors.PharmaxError ? cause.code : "NOTIFICATION_CHANNEL_RESOLVE_FAILED";
      if (code === NOTIFICATIONS_NOT_CONFIGURED) {
        ctx.logger.info("outbox.notify_provider_shipped.skipped_no_channel", {
          outboxId: row.id,
          orderId: row.aggregateId,
        });
        return;
      }
      throw cause;
    }

    const orderId = String(payload["orderId"] ?? row.aggregateId);
    const trackingNumber =
      typeof payload["trackingNumber"] === "string" ? payload["trackingNumber"] : null;
    const occurredAt = typeof payload["occurredAt"] === "string" ? payload["occurredAt"] : null;

    // Resolve the order + the prescriber recipients in system context
    // (this drain runs cross-tenant; org scoping is explicit on every
    // query).
    const resolved = await withSystemContext(
      "worker-drain:notify-provider-shipped.load-recipients",
      async () => {
        const order = await options.client.order.findFirst({
          where: { id: orderId, organizationId: row.organizationId },
          select: {
            id: true,
            externalOrderNumber: true,
            shippedAt: true,
            orderLines: {
              select: {
                prescription: {
                  select: {
                    rxNumber: true,
                    providerId: true,
                    provider: {
                      select: {
                        portalAccount: {
                          select: { id: true, email: true, status: true },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        });
        return { order };
      }
    );

    if (resolved.order === null) {
      // Poison payload (order deleted / cross-org id). Log + drop —
      // retrying cannot succeed.
      ctx.logger.error("outbox.notify_provider_shipped.order_not_found", {
        outboxId: row.id,
        orderId,
      });
      return;
    }

    // Group rx numbers by ACTIVE portal account. Providers without a
    // portal account (or with a PENDING_SETUP/DISABLED one) are
    // skipped — portal enrollment is the notification opt-in.
    const byAccount = new Map<string, { email: string; rxNumbers: string[] }>();
    for (const line of resolved.order.orderLines) {
      const account = line.prescription.provider.portalAccount;
      if (account === null || account.status !== "ACTIVE") continue;
      const entry = byAccount.get(account.id) ?? { email: account.email, rxNumbers: [] };
      if (!entry.rxNumbers.includes(line.prescription.rxNumber)) {
        entry.rxNumbers.push(line.prescription.rxNumber);
      }
      byAccount.set(account.id, entry);
    }
    const recipients: ProviderRecipient[] = [...byAccount.entries()].map(
      ([portalAccountId, entry]) => ({
        portalAccountId,
        email: entry.email,
        rxNumbers: entry.rxNumbers,
      })
    );

    if (recipients.length === 0) {
      ctx.logger.info("outbox.notify_provider_shipped.no_enrolled_recipients", {
        outboxId: row.id,
        orderId,
      });
      return;
    }

    const orderExternalNumber = resolved.order.externalOrderNumber ?? resolved.order.id;
    const shippedAtIso =
      occurredAt ?? resolved.order.shippedAt?.toISOString() ?? new Date().toISOString();

    let succeeded = 0;
    const failures: Array<{ code: string }> = [];

    for (const recipient of recipients) {
      try {
        await channel.send({
          to: { kind: "email", address: recipient.email },
          template: "PORTAL_ORDER_SHIPPED_V1",
          context: {
            orderExternalNumber,
            rxNumbers: recipient.rxNumbers.join(", "),
            shippedAtIso,
            ...(trackingNumber === null ? {} : { trackingNumber }),
          },
          idempotencyKey: `portal-ship-notify:${row.id}:${recipient.portalAccountId}`,
          organizationId: row.organizationId,
          correlationId: row.id,
        });
        succeeded += 1;
      } catch (cause) {
        const code =
          cause instanceof errors.PharmaxError ? cause.code : "NOTIFICATION_TRANSPORT_ERROR";
        failures.push({ code });
        // Portal account id only — never the email address — in logs.
        ctx.logger.warn("outbox.notify_provider_shipped.recipient_failed", {
          outboxId: row.id,
          orderId,
          portalAccountId: recipient.portalAccountId,
          code,
          error: cause,
        });
      }
    }

    if (failures.length > 0) {
      // ANY failed recipient → throw so the drainer retries with
      // backoff. Successes replay as `deduplicated` on retry (per-
      // recipient idempotency keys), and the composed billing
      // materializer is idempotent by contract, so retrying the row
      // as a unit is safe.
      throw new errors.InternalError({
        code:
          succeeded === 0
            ? "PROVIDER_SHIP_NOTIFY_ALL_RECIPIENTS_FAILED"
            : "PROVIDER_SHIP_NOTIFY_SOME_RECIPIENTS_FAILED",
        message: `Prescriber shipment notification failed for ${failures.length} of ${failures.length + succeeded} recipient(s); retrying (successes dedupe).`,
        metadata: {
          outboxId: row.id,
          orderId,
          succeeded,
          failed: failures.length,
          firstFailureCode: failures[0]?.code,
        },
      });
    }

    ctx.logger.info("outbox.notify_provider_shipped.dispatched", {
      outboxId: row.id,
      orderId,
      recipients: recipients.length,
    });
  };
}
