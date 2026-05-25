// Database writers used by the executor.
//
// Each writer is small and pure: it takes a Prisma client/tx +
// typed input + returns the row id (when relevant). The executor
// composes them. Keeping them in one file makes the contract that
// "every critical command writes command_log + audit_log +
// event_outbox" auditable in ONE place.

import type { Prisma, PrismaClient, CommandStatus, OutboxStatus } from "@pharmax/database";
import { writeAuditLogInTx, type AuditChainTxClient } from "@pharmax/audit";

import type { AuditEntryDraft, OutboxEventDraft, PrismaTxClient } from "./types.js";

export interface CreateCommandLogInput {
  readonly id: string;
  readonly organizationId: string;
  readonly commandName: string;
  readonly idempotencyKey: string;
  readonly actorUserId: string | null;
  readonly workstationId: string | null;
  readonly requestPayload: Record<string, unknown>;
  readonly status: CommandStatus;
  readonly targetOrderId?: string;
}

/**
 * Insert the initial command_log row. Called PRE-TX for tenant
 * commands (visible even if the tx crashes) and INSIDE the tx for
 * system commands (the org id isn't known until the handler runs).
 */
export async function createCommandLog(
  client: PrismaClient | PrismaTxClient,
  input: CreateCommandLogInput
): Promise<void> {
  await client.commandLog.create({
    data: {
      id: input.id,
      organizationId: input.organizationId,
      commandName: input.commandName,
      idempotencyKey: input.idempotencyKey,
      actorUserId: input.actorUserId,
      workstationId: input.workstationId,
      requestPayload: input.requestPayload as Prisma.InputJsonValue,
      status: input.status,
      ...(input.targetOrderId === undefined ? {} : { targetOrderId: input.targetOrderId }),
    },
  });
}

export interface UpdateCommandLogStatusInput {
  readonly id: string;
  readonly status: CommandStatus;
  readonly responsePayload?: Record<string, unknown>;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly completedAt: Date;
}

export async function updateCommandLogStatus(
  client: PrismaClient | PrismaTxClient,
  input: UpdateCommandLogStatusInput
): Promise<void> {
  await client.commandLog.update({
    where: { id: input.id },
    data: {
      status: input.status,
      completedAt: input.completedAt,
      ...(input.responsePayload === undefined
        ? {}
        : { responsePayload: input.responsePayload as Prisma.InputJsonValue }),
      ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
      ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
    },
  });
}

export interface CreateAuditLogInput {
  readonly organizationId: string;
  readonly actorUserId: string | null;
  readonly audit: AuditEntryDraft;
  readonly scope: Record<string, unknown>;
  readonly commandLogId: string;
}

/**
 * Insert an audit_log row inside the same tx as the domain mutation.
 * Bus-only — handlers MUST NOT call this directly; they declare
 * the audit shape via `HandlerResult.audit`.
 *
 * Delegates to @pharmax/audit's chain writer so every insert links
 * to the prior row's hash under a per-tenant advisory lock. The
 * caller's tx already has the tenancy session GUC applied (RLS
 * enforces tenant isolation on both audit_log and audit_chain_state).
 */
export async function createAuditLogInTx(
  tx: PrismaTxClient,
  input: CreateAuditLogInput
): Promise<void> {
  const baseMetadata: Record<string, unknown> = {
    commandLogId: input.commandLogId,
    ...(input.audit.metadata ?? {}),
  };
  // Structural cast: the Prisma tx client satisfies AuditChainTxClient.
  await writeAuditLogInTx(tx as unknown as AuditChainTxClient, {
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: input.audit.action,
    resourceType: input.audit.resourceType,
    ...(input.audit.resourceId === undefined ? {} : { resourceId: input.audit.resourceId }),
    scope: input.audit.scope ?? input.scope,
    metadata: baseMetadata,
    occurredAt: new Date(),
  });
}

export interface CreateOutboxEventsInput {
  readonly organizationId: string;
  readonly events: ReadonlyArray<OutboxEventDraft>;
  readonly initialStatus: OutboxStatus;
}

/**
 * Insert a batch of event_outbox rows inside the same tx as the
 * domain mutation. The drainer picks them up after commit.
 *
 * We use `createMany` for efficiency; rows go in as PENDING so the
 * existing claim query (`UPDATE … FROM (SELECT … FOR UPDATE SKIP
 * LOCKED) WHERE status = 'PENDING' AND nextAttemptAt IS NULL OR
 * nextAttemptAt <= now`) picks them up on the next tick.
 */
export async function createOutboxEventsInTx(
  tx: PrismaTxClient,
  input: CreateOutboxEventsInput
): Promise<void> {
  if (input.events.length === 0) return;
  await tx.eventOutbox.createMany({
    data: input.events.map((e) => ({
      organizationId: input.organizationId,
      eventType: e.eventType,
      aggregateType: e.aggregateType,
      aggregateId: e.aggregateId,
      payload: e.payload as Prisma.InputJsonValue,
      status: input.initialStatus,
    })),
  });
}
