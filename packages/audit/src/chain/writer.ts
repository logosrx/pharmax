// Append-only audit chain writer.
//
// Contract:
//
//   For every audit_log insert, the writer:
//
//     1. Acquires a per-tenant Postgres advisory transaction lock
//        via `pg_advisory_xact_lock(audit_chain_lock_key(orgId))`.
//        Concurrent inserts in the SAME tenant serialize; concurrent
//        inserts in DIFFERENT tenants do not interact. The lock
//        releases on tx commit/rollback automatically.
//
//     2. Reads the tenant's current chain head from
//        `audit_chain_state` (NULL row → genesis insert; seq starts
//        at 1).
//
//     3. Computes the next entry's hash via
//        `computeAuditEntryHash`, linking `prevHash = head.latestHash`.
//
//     4. Inserts the audit_log row INSIDE the caller's tx, with
//        prevHash, entryHash, and seq populated.
//
//     5. Upserts audit_chain_state with the new head.
//
//   The whole sequence is atomic with the caller's domain mutation:
//   if the caller's tx rolls back, the chain head is unchanged and
//   no audit row is persisted — the next insert simply re-uses the
//   prior head. The advisory lock prevents two concurrent inserts
//   from computing the same seq.
//
// Why pg_advisory_xact_lock instead of `SELECT ... FOR UPDATE` on
// audit_chain_state:
//
//   - The genesis insert has no existing row to lock. `FOR UPDATE`
//     on a non-existent row is a no-op; two concurrent genesis
//     inserts would both compute seq=1 and race the unique index.
//     The advisory lock serializes them regardless of row existence.
//
//   - Advisory locks are tx-scoped, so no manual release is needed.
//
//   - The `audit_chain_lock_key(uuid)` SQL function is defined in
//     the audit_chain migration; it derives a stable BIGINT key
//     from the org UUID with a 0x6175646974636861 ('auditcha')
//     salt to avoid collision with other advisory-lock callers
//     (e.g. Prisma's migration lock).

import { computeAuditEntryHash } from "./encoder.js";

/**
 * Minimal Prisma tx interface — avoids a build-time dependency on
 * @pharmax/database that would create a cycle (database → audit →
 * database). The caller passes Prisma's tx client, which structurally
 * satisfies this shape.
 */
export interface AuditChainTxClient {
  $executeRaw(template: TemplateStringsArray, ...values: ReadonlyArray<unknown>): Promise<number>;

  auditLog: {
    create(args: { data: AuditLogCreateData }): Promise<{ id: string }>;
  };

  auditChainState: {
    findUnique(args: { where: { organizationId: string } }): Promise<AuditChainStateRow | null>;
    upsert(args: {
      where: { organizationId: string };
      create: AuditChainStateUpsertData;
      update: Omit<AuditChainStateUpsertData, "organizationId">;
    }): Promise<AuditChainStateRow>;
  };
}

interface AuditLogCreateData {
  readonly organizationId: string;
  readonly actorUserId: string | null;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId?: string;
  readonly scope: unknown;
  readonly metadata: unknown;
  readonly prevHash: Buffer | null;
  readonly entryHash: Buffer;
  readonly seq: bigint;
}

interface AuditChainStateUpsertData {
  readonly organizationId: string;
  readonly latestHash: Buffer;
  readonly latestSeq: bigint;
}

interface AuditChainStateRow {
  readonly organizationId: string;
  readonly latestHash: Buffer;
  readonly latestSeq: bigint;
}

export interface WriteAuditLogInput {
  readonly organizationId: string;
  readonly actorUserId: string | null;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId?: string;
  /** Tenant scope snapshot (siteId, clinicId, etc.). */
  readonly scope: unknown;
  /** PHI-redacted contextual metadata (commandLogId is typical). */
  readonly metadata: unknown;
  /** When the audit-worthy event occurred; defaults to now() on the DB. */
  readonly occurredAt: Date;
}

export interface WriteAuditLogOutput {
  readonly entryHash: Buffer;
  readonly seq: bigint;
}

/**
 * Insert an audit_log row + advance the chain head atomically inside
 * the caller's transaction. ONLY supported audit insert path — the
 * command bus calls this; handlers and route code must NOT bypass it.
 */
export async function writeAuditLogInTx(
  tx: AuditChainTxClient,
  input: WriteAuditLogInput
): Promise<WriteAuditLogOutput> {
  // 1. Per-tenant advisory lock. Holds for the remainder of the tx.
  //    The cast to uuid is required because $executeRaw binds the
  //    organizationId as text; the audit_chain_lock_key signature
  //    expects uuid.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(audit_chain_lock_key(${input.organizationId}::uuid))`;

  // 2. Read the current chain head.
  const head = await tx.auditChainState.findUnique({
    where: { organizationId: input.organizationId },
  });

  const prevHash = head ? Buffer.from(head.latestHash) : null;
  const seq = (head?.latestSeq ?? 0n) + 1n;

  // 3. Compute the new entry's hash.
  const entryHashBytes = computeAuditEntryHash({
    prevHash,
    organizationId: input.organizationId,
    seq,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId ?? null,
    actorUserId: input.actorUserId,
    scope: input.scope,
    metadata: input.metadata,
    occurredAt: input.occurredAt,
  });
  const entryHash = Buffer.from(entryHashBytes);

  // 4. Insert the audit_log row.
  await tx.auditLog.create({
    data: {
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: input.action,
      resourceType: input.resourceType,
      ...(input.resourceId === undefined ? {} : { resourceId: input.resourceId }),
      scope: input.scope,
      metadata: input.metadata,
      prevHash,
      entryHash,
      seq,
    },
  });

  // 5. Upsert the chain head.
  await tx.auditChainState.upsert({
    where: { organizationId: input.organizationId },
    create: {
      organizationId: input.organizationId,
      latestHash: entryHash,
      latestSeq: seq,
    },
    update: {
      latestHash: entryHash,
      latestSeq: seq,
    },
  });

  return { entryHash, seq };
}
