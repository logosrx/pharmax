// Prisma-backed `NotificationDeliveryStore`.
//
// Lives in apps/worker (not @pharmax/notifications, not
// @pharmax/database) because it needs BOTH Prisma + the tenancy
// GUC helpers, and `@pharmax/tenancy` already depends on
// `@pharmax/database` — a store in the database package would
// invert that edge into a cycle. The composition root wires this
// into `PersistentNotificationChannel` at boot.
//
// All writes run under `withSystemContext`: the worker's notify
// handler fans out cross-tenant (it processes runs for many orgs
// in one outbox tick) and has no per-request tenancy frame. The
// `organizationId` is carried explicitly on every call, so the
// rows land tenant-scoped even though the GUC is in system mode
// (RLS WITH CHECK still validates the column is non-null).
//
// Idempotency: `recordQueued` upserts on the unique
// (organizationId, idempotencyKey). A retried send re-enters the
// SAME row (status reset to QUEUED) rather than duplicating —
// mirrors the transport's own idempotency-key dedupe and the
// outbox drainer's at-least-once delivery.

import type { PrismaClient } from "@pharmax/database";
import type {
  NotificationDeliveryMarkFailedInput,
  NotificationDeliveryMarkSentInput,
  NotificationDeliveryRecordQueuedInput,
  NotificationDeliveryStore,
} from "@pharmax/notifications";
import { withSystemContext } from "@pharmax/tenancy";

export interface PrismaNotificationDeliveryStoreOptions {
  readonly prisma: PrismaClient;
}

export class PrismaNotificationDeliveryStore implements NotificationDeliveryStore {
  private readonly prisma: PrismaClient;

  constructor(options: PrismaNotificationDeliveryStoreOptions) {
    this.prisma = options.prisma;
  }

  async recordQueued(input: NotificationDeliveryRecordQueuedInput): Promise<void> {
    await withSystemContext("worker:notification-delivery:record-queued", async () => {
      await this.prisma.notificationDelivery.upsert({
        where: {
          organizationId_idempotencyKey: {
            organizationId: input.organizationId,
            idempotencyKey: input.idempotencyKey,
          },
        },
        create: {
          organizationId: input.organizationId,
          idempotencyKey: input.idempotencyKey,
          template: input.template,
          channelName: input.channelName,
          recipientKind: input.recipientKind,
          recipientAddress: input.recipientAddress,
          status: "QUEUED",
          ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
        },
        update: {
          // A retried send: reset to QUEUED, clear any prior
          // failure, refresh the descriptive columns (template /
          // recipient can't change for a given key, but keeping
          // the update total avoids partial rows).
          status: "QUEUED",
          failureReason: null,
          template: input.template,
          channelName: input.channelName,
          recipientKind: input.recipientKind,
          recipientAddress: input.recipientAddress,
          ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
        },
      });
    });
  }

  async markSent(input: NotificationDeliveryMarkSentInput): Promise<void> {
    await withSystemContext("worker:notification-delivery:mark-sent", async () => {
      await this.prisma.notificationDelivery.update({
        where: {
          organizationId_idempotencyKey: {
            organizationId: input.organizationId,
            idempotencyKey: input.idempotencyKey,
          },
        },
        data: {
          status: "SENT",
          providerMessageId: input.providerMessageId,
        },
      });
    });
  }

  async markFailed(input: NotificationDeliveryMarkFailedInput): Promise<void> {
    await withSystemContext("worker:notification-delivery:mark-failed", async () => {
      await this.prisma.notificationDelivery.update({
        where: {
          organizationId_idempotencyKey: {
            organizationId: input.organizationId,
            idempotencyKey: input.idempotencyKey,
          },
        },
        data: {
          status: "FAILED",
          failureReason: input.failureReason,
        },
      });
    });
  }
}
