// Per-tick logic for the outbound webhook delivery drain (ADR-0032).
//
// Each tick:
//   1. Atomically claims + leases up to `batchSize` eligible
//      `webhook_delivery` rows (PENDING/FAILED whose backoff/lease
//      has passed).
//   2. Loads each row's subscription (url + encrypted secret) in a
//      system-context frame. A DISABLED subscription DEAD-letters
//      the delivery immediately — a tenant disabling an endpoint
//      (e.g. after a compromise) must stop egress, not merely stop
//      new fan-out.
//   3. Decrypts the signing secret, POSTs the signed envelope, and
//      marks SENT / FAILED-with-backoff / DEAD via completion writes
//      FENCED on the claim's `attempts` token (same lease-loss
//      semantics as the outbox drainer).
//
// PHI: payloads are phi-safe by construction (registry-gated at
// fan-out). Logs carry ids + statuses, never payloads or secrets.

import { decryptField } from "@pharmax/crypto";
import type { PrismaClient, WebhookDeliveryStatus } from "@pharmax/database";
import {
  attemptWebhookDelivery,
  webhookSecretBinding,
  type AttemptWebhookDeliveryResult,
} from "@pharmax/partner-api";
import type { logger as loggerContract } from "@pharmax/platform-core";
import {
  applySystemSessionGuc,
  withSystemContext,
  type SessionGucExecutor,
} from "@pharmax/tenancy";
import { getMeter, withSpan } from "@pharmax/telemetry";

import {
  claimWebhookDeliveries,
  type ClaimWebhookDeliveriesOptions,
  type ClaimedWebhookDeliveryRow,
  type WebhookDeliveryClaimClient,
} from "./claim-webhook-deliveries.js";

const meter = getMeter("@pharmax/worker.webhook-delivery");

const deliveryCounter = meter.createCounter("pharmax_webhook_delivery_total", {
  description:
    "Webhook delivery attempts per tick. Outcome is one of sent | fail | dead | lease_lost.",
});

type Logger = loggerContract.Logger;

export interface WebhookDeliveryDrainerDeps {
  readonly client: WebhookDeliveryClaimClient & Pick<PrismaClient, "$transaction">;
  readonly logger: Logger;
  readonly maxAttempts?: number;
  readonly clock?: () => Date;
  readonly computeNextAttemptAt?: (attempt: number, now: Date) => Date | null;
  /** Injectable transport for tests. Defaults to the real HTTP attempt. */
  readonly attempt?: typeof attemptWebhookDelivery;
  /** Injectable secret decryptor for tests. */
  readonly decryptSecret?: (input: {
    readonly envelope: unknown;
    readonly organizationId: string;
    readonly subscriptionId: string;
  }) => Promise<string>;
}

export type WebhookDeliveryDrainerOptions = ClaimWebhookDeliveriesOptions;

export interface WebhookDeliveryDrainerTickResult {
  readonly claimed: number;
  readonly sent: number;
  readonly failed: number;
  readonly dead: number;
  readonly leaseLost: number;
}

const DEFAULT_MAX_ATTEMPTS = 8;

function defaultBackoff(attempt: number, now: Date): Date | null {
  // Exponential backoff: 30s, 1m, 2m, 4m, 8m, 16m, 32m, 64m.
  if (attempt >= DEFAULT_MAX_ATTEMPTS) {
    return null;
  }
  const seconds = 30 * 2 ** (attempt - 1);
  return new Date(now.getTime() + seconds * 1000);
}

async function defaultDecryptSecret(input: {
  readonly envelope: unknown;
  readonly organizationId: string;
  readonly subscriptionId: string;
}): Promise<string> {
  return decryptField({
    envelope: input.envelope,
    binding: webhookSecretBinding({
      organizationId: input.organizationId,
      subscriptionId: input.subscriptionId,
    }),
  });
}

interface SubscriptionRow {
  readonly url: string;
  readonly secretEnc: unknown;
  readonly status: "ACTIVE" | "DISABLED";
}

export function createWebhookDeliveryDrainer(
  deps: WebhookDeliveryDrainerDeps,
  options: WebhookDeliveryDrainerOptions
): { tick: () => Promise<WebhookDeliveryDrainerTickResult> } {
  const log = deps.logger.child({ component: "webhook-delivery-drainer" });
  const clock = deps.clock ?? (() => new Date());
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const computeNextAttemptAt = deps.computeNextAttemptAt ?? defaultBackoff;
  const attempt = deps.attempt ?? attemptWebhookDelivery;
  const decryptSecret = deps.decryptSecret ?? defaultDecryptSecret;

  async function loadSubscription(row: ClaimedWebhookDeliveryRow): Promise<SubscriptionRow | null> {
    const reason = "apps/worker:webhook-delivery-subscription-load";
    return withSystemContext(reason, () =>
      deps.client.$transaction(async (tx) => {
        await applySystemSessionGuc(tx as unknown as SessionGucExecutor, reason);
        return tx.webhookSubscription.findUnique({
          where: { id: row.subscriptionId },
          select: { url: true, secretEnc: true, status: true },
        });
      })
    );
  }

  async function markOutcome(input: {
    readonly row: ClaimedWebhookDeliveryRow;
    readonly status: Extract<WebhookDeliveryStatus, "SENT" | "FAILED" | "DEAD">;
    readonly responseStatus: number | null;
    readonly lastError: string | null;
    readonly nextAttemptAt: Date | null;
    readonly deliveredAt: Date | null;
  }): Promise<boolean> {
    const reason = "apps/worker:webhook-delivery-completion";
    const count = await withSystemContext(reason, () =>
      deps.client.$transaction(async (tx) => {
        await applySystemSessionGuc(tx as unknown as SessionGucExecutor, reason);
        // Fenced on the claim's attempts token (lease-loss semantics
        // identical to the outbox drainer).
        const result = await tx.webhookDelivery.updateMany({
          where: { id: input.row.id, attempts: input.row.attempts },
          data: {
            status: input.status,
            responseStatus: input.responseStatus,
            lastError: input.lastError,
            nextAttemptAt: input.nextAttemptAt,
            deliveredAt: input.deliveredAt,
          },
        });
        return result.count;
      })
    );
    return count === 1;
  }

  return {
    async tick(): Promise<WebhookDeliveryDrainerTickResult> {
      const claimed = await claimWebhookDeliveries(deps.client, options);
      if (claimed.length === 0) {
        log.debug("webhook_delivery.idle");
        return { claimed: 0, sent: 0, failed: 0, dead: 0, leaseLost: 0 };
      }

      let sent = 0;
      let failed = 0;
      let dead = 0;
      let leaseLost = 0;

      for (const row of claimed) {
        const rowLog = log.child({
          deliveryId: row.id,
          subscriptionId: row.subscriptionId,
          eventType: row.eventType,
          attempts: row.attempts,
        });
        const label = { event_type: row.eventType };

        let outcome: AttemptWebhookDeliveryResult;
        let terminalOverride = false;

        const subscription = await loadSubscription(row);
        if (subscription === null) {
          // Subscription row gone (cascade delete). Nothing to
          // deliver to — terminal.
          outcome = { ok: false, responseStatus: null, error: "Subscription no longer exists" };
          terminalOverride = true;
        } else if (subscription.status === "DISABLED") {
          // A disabled endpoint must stop egress immediately (a
          // tenant may be cutting off a compromised receiver).
          outcome = { ok: false, responseStatus: null, error: "Subscription disabled" };
          terminalOverride = true;
        } else {
          try {
            // Consumer span resuming the trace persisted at fan-out.
            // While this span is active, the instrumented fetch inside
            // `attempt` produces a client child span AND injects the
            // outbound `traceparent` header, so partners can correlate
            // their receipt with our delivery attempt. Attributes are
            // ids + statuses only — never payloads or secrets.
            outcome = await withSpan(
              {
                tracerName: "@pharmax/worker.webhook-delivery",
                spanName: `webhook.deliver ${row.eventType}`,
                kind: "consumer",
                parentTraceparent: row.traceparent,
                attributes: {
                  "pharmax.delivery_id": row.id,
                  "pharmax.subscription_id": row.subscriptionId,
                  "pharmax.event_type": row.eventType,
                  "pharmax.organization_id": row.organizationId,
                  "pharmax.attempts": row.attempts,
                },
              },
              async (span) => {
                const secret = await decryptSecret({
                  envelope: subscription.secretEnc,
                  organizationId: row.organizationId,
                  subscriptionId: row.subscriptionId,
                });
                const result = await attempt({
                  url: subscription.url,
                  secret,
                  deliveryId: row.id,
                  eventType: row.eventType,
                  payload: row.payload,
                  occurredAt: row.createdAt,
                });
                span.setAttribute("pharmax.delivery.ok", result.ok);
                if (result.responseStatus !== null) {
                  span.setAttribute("http.response.status_code", result.responseStatus);
                }
                return result;
              }
            );
          } catch (cause) {
            outcome = {
              ok: false,
              responseStatus: null,
              error: cause instanceof Error ? `${cause.name}: ${cause.message}` : "Unknown error",
            };
          }
        }

        const now = clock();
        if (outcome.ok) {
          const fenced = await markOutcome({
            row,
            status: "SENT",
            responseStatus: outcome.responseStatus,
            lastError: null,
            nextAttemptAt: null,
            deliveredAt: now,
          });
          if (!fenced) {
            leaseLost += 1;
            deliveryCounter.add(1, { ...label, outcome: "lease_lost" });
            rowLog.warn("webhook_delivery.lease_lost");
            continue;
          }
          sent += 1;
          deliveryCounter.add(1, { ...label, outcome: "sent" });
          rowLog.info("webhook_delivery.sent", { responseStatus: outcome.responseStatus });
          continue;
        }

        const nextAttemptAt =
          terminalOverride || row.attempts >= maxAttempts
            ? null
            : computeNextAttemptAt(row.attempts, now);
        const terminal = nextAttemptAt === null;
        const fenced = await markOutcome({
          row,
          status: terminal ? "DEAD" : "FAILED",
          responseStatus: outcome.responseStatus,
          lastError: outcome.error,
          nextAttemptAt,
          deliveredAt: null,
        });
        if (!fenced) {
          leaseLost += 1;
          deliveryCounter.add(1, { ...label, outcome: "lease_lost" });
          rowLog.warn("webhook_delivery.lease_lost");
          continue;
        }
        if (terminal) {
          dead += 1;
          deliveryCounter.add(1, { ...label, outcome: "dead" });
          rowLog.error("webhook_delivery.dead", { errorMessage: outcome.error });
        } else {
          failed += 1;
          deliveryCounter.add(1, { ...label, outcome: "fail" });
          rowLog.warn("webhook_delivery.failed", {
            errorMessage: outcome.error,
            willRetry: true,
          });
        }
      }

      log.info("webhook_delivery.tick.complete", {
        claimed: claimed.length,
        sent,
        failed,
        dead,
        leaseLost,
      });
      return { claimed: claimed.length, sent, failed, dead, leaseLost };
    },
  };
}

export type { ClaimedWebhookDeliveryRow };
