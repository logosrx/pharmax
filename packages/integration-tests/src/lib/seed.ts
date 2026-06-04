// Seed helpers for integration tests.
//
// Each test gets its own organization with a randomized slug so
// concurrent test runs (and concurrent dev work on the same DB)
// don't collide. The seeder uses raw SQL — not Prisma — so it
// can run as the `owner` role (BYPASSRLS) regardless of which
// role the test under test is using.
//
// PHI columns are filled with PLACEHOLDER values:
//   - `*Enc` columns get `'{"v": "placeholder", "alg": "test"}'::jsonb`.
//     The integration tests do NOT exercise crypto correctness;
//     that's covered by `@pharmax/crypto` unit tests. We only
//     need the column to satisfy NOT NULL.
//   - `*Bi` columns get the empty string. Likewise placeholder.
//
// PII rule: the placeholder values are NOT decryptable and are
// not derived from any real PHI. They satisfy the schema's NOT
// NULL constraints without leaking anything.

import { randomBytes, randomUUID } from "node:crypto";

import { CommandStatus, IntakeSourceKind, OrderPriority, OrderStatus } from "@pharmax/database";

import type { Client } from "pg";

// Enum values for workflow-critical columns are sourced from the
// Prisma-generated client (re-exported by `@pharmax/database` for
// "ergonomic value-side usage in commands/seeds"). They are bound
// as parameters with an explicit `::"EnumType"` cast — matching
// the pattern in `verification-record.test.ts` — so a rename of an
// enum value in `schema.prisma` surfaces as a TS compile error in
// this file BEFORE the integration suite ever talks to Postgres.
//
// Status literals on the tenant scaffolding (`'ACTIVE'`,
// `'WORKFLOW'`) are intentionally left as bare strings: they are
// shared across multiple low-churn enums and importing one symbol
// per literal would add noise without materially reducing drift
// risk.

const PHI_PLACEHOLDER_JSON = JSON.stringify({ v: "placeholder", alg: "test" });

/** Result of seeding a tenant. All ids the test will need. */
export interface SeededTenant {
  readonly organizationId: string;
  readonly siteId: string;
  readonly clinicId: string;
  readonly bucketId: string;
  readonly workflowPolicyId: string;
  readonly workflowPolicyVersion: number;
  readonly adminUserId: string;
}

/**
 * Seed the bare minimum tenant scaffolding so a verification
 * record can be written:
 *   organization → workflow_policy → pharmacy_site → clinic
 *               → bucket
 *               → user
 *
 * Returns the ids the caller will need to assemble the rest of
 * the chain (patient, order, command_log).
 */
export async function seedTenant(client: Client): Promise<SeededTenant> {
  const tag = randomUUID().slice(0, 8);
  const organizationId = randomUUID();
  const siteId = randomUUID();
  const clinicId = randomUUID();
  const bucketId = randomUUID();
  const workflowPolicyId = randomUUID();
  const adminUserId = randomUUID();

  await client.query(
    `INSERT INTO organization (id, slug, name, status, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, 'ACTIVE', now(), now())`,
    [organizationId, `it-${tag}`, `IT Tenant ${tag}`]
  );

  await client.query(
    `INSERT INTO workflow_policy (
       id, "organizationId", code, version, status, description, definition,
       "publishedAt", "createdAt", "updatedAt"
     )
     VALUES ($1, $2, 'order.standard', 1, 'ACTIVE', 'IT policy', $3::jsonb, now(), now(), now())`,
    [workflowPolicyId, organizationId, JSON.stringify({ states: [], transitions: [] })]
  );

  await client.query(
    `INSERT INTO pharmacy_site (id, "organizationId", code, name, timezone, status, "createdAt", "updatedAt")
     VALUES ($1, $2, 'MAIN', 'IT Site', 'America/New_York', 'ACTIVE', now(), now())`,
    [siteId, organizationId]
  );

  await client.query(
    `INSERT INTO clinic (id, "organizationId", code, name, status, "createdAt", "updatedAt")
     VALUES ($1, $2, 'DEMO', 'IT Clinic', 'ACTIVE', now(), now())`,
    [clinicId, organizationId]
  );

  await client.query(
    `INSERT INTO bucket (
       id, "organizationId", "siteId", code, name, kind, "sortOrder", "isSystem",
       "createdAt", "updatedAt"
     )
     VALUES ($1, $2, $3, 'INBOX', 'Inbox', 'WORKFLOW', 10, true, now(), now())`,
    [bucketId, organizationId, siteId]
  );

  await client.query(
    `INSERT INTO "user" (
       id, "organizationId", email, "displayName", status, "createdAt", "updatedAt"
     )
     VALUES ($1, $2, $3, 'IT Admin', 'ACTIVE', now(), now())`,
    [adminUserId, organizationId, `admin-${tag}@example.test`]
  );

  return {
    organizationId,
    siteId,
    clinicId,
    bucketId,
    workflowPolicyId,
    workflowPolicyVersion: 1,
    adminUserId,
  };
}

export interface SeededOrder {
  readonly patientId: string;
  readonly orderId: string;
  readonly commandLogId: string;
}

/**
 * Extend a seeded tenant with the parent chain needed to insert
 * a `verification_record`:
 *
 *   patient → order  →  command_log
 *
 * The order is created in `PV1_IN_PROGRESS` status so an
 * ApprovePV1-style verification_record is a valid foreign key.
 * Returns the ids the verification_record write needs.
 */
export async function seedOrderChain(client: Client, tenant: SeededTenant): Promise<SeededOrder> {
  const patientId = randomUUID();
  const orderId = randomUUID();
  const commandLogId = randomUUID();

  await client.query(
    `INSERT INTO patient (
       id, "organizationId", "clinicId",
       "firstNameEnc", "lastNameEnc", "dateOfBirthEnc",
       "lastNameBi", "firstNameBi", "dobBi", "dobYearMonthBi",
       status, "createdAt", "updatedAt"
     )
     VALUES (
       $1, $2, $3,
       $4::jsonb, $4::jsonb, $4::jsonb,
       'bi-last', 'bi-first', 'bi-dob', 'bi-dob-ym',
       'ACTIVE', now(), now()
     )`,
    [patientId, tenant.organizationId, tenant.clinicId, PHI_PLACEHOLDER_JSON]
  );

  await client.query(
    `INSERT INTO "order" (
       id, "organizationId", "clinicId", "siteId", "patientId",
       "currentStatus", "currentBucketId",
       "workflowPolicyId", "workflowPolicyVersion",
       version, priority, "intakeSourceKind", "receivedAt",
       "createdAt", "updatedAt"
     )
     VALUES (
       $1, $2, $3, $4, $5,
       $6::"OrderStatus", $7,
       $8, $9,
       1, $10::"OrderPriority", $11::"IntakeSourceKind", now(),
       now(), now()
     )`,
    [
      orderId,
      tenant.organizationId,
      tenant.clinicId,
      tenant.siteId,
      patientId,
      OrderStatus.PV1_IN_PROGRESS,
      tenant.bucketId,
      tenant.workflowPolicyId,
      tenant.workflowPolicyVersion,
      OrderPriority.NORMAL,
      IntakeSourceKind.API,
    ]
  );

  await client.query(
    `INSERT INTO command_log (
       id, "organizationId", "commandName", "actorUserId",
       "idempotencyKey", "requestPayload", status, "startedAt"
     )
     VALUES ($1, $2, 'ApprovePV1', $3, $4, $5::jsonb, $6::"CommandStatus", now())`,
    [
      commandLogId,
      tenant.organizationId,
      tenant.adminUserId,
      `it-${randomUUID()}`,
      // command_log carries a PHI-redacted JSON request snapshot
      // (`requestPayload`), not a hash. Placeholder is sufficient —
      // the integration suite pins DB-edge invariants, not payload
      // shape.
      "{}",
      CommandStatus.SUCCEEDED,
    ]
  );

  return { patientId, orderId, commandLogId };
}

/**
 * Insert a single `audit_log` row for `tenant`.
 *
 * This helper deliberately writes a SELF-CONSISTENT but otherwise
 * meaningless chain row (random `entryHash`, monotonic `seq` via
 * a `MAX(seq)+1` read) instead of going through the production
 * `writeAuditChain` writer in `@pharmax/audit`. Reasons:
 *
 *   - The integration tests pin DATABASE-edge invariants (RLS,
 *     GRANT, UNIQUE, CHECK). Chain ENCODING correctness is the
 *     job of `packages/audit/src/chain/encoder.test.ts`.
 *
 *   - The production writer needs a Prisma tx client. Importing
 *     Prisma here would defeat the purpose of using `pg` directly
 *     for explicit role / GUC control.
 *
 * `prevHash` is set to the previous tenant row's `entryHash` so
 * the chain-linkage assertion (`row[N+1].prevHash == row[N].entryHash`)
 * remains meaningful even with synthetic hashes.
 */
export interface InsertAuditLogRowArgs {
  readonly client: Client;
  readonly organizationId: string;
  readonly actorUserId: string | null;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId?: string | null;
}

export interface InsertedAuditLogRow {
  readonly id: string;
  readonly seq: bigint;
  readonly entryHash: Buffer;
  readonly prevHash: Buffer | null;
}

export async function insertAuditLogRow(args: InsertAuditLogRowArgs): Promise<InsertedAuditLogRow> {
  // SHA-256 has 32-byte hashes; we generate a random 32-byte
  // Buffer so the row's column types (`bytea`) are exercised
  // exactly as the production writer would.
  const entryHash = randomBytes32();

  const headRow = await args.client.query<{
    latest_hash: Buffer | null;
    latest_seq: string | null;
  }>(
    `SELECT "latestHash" AS latest_hash, "latestSeq"::text AS latest_seq
       FROM audit_chain_state
      WHERE "organizationId" = $1`,
    [args.organizationId]
  );
  const head = headRow.rows[0];
  const prevHash: Buffer | null = head?.latest_hash ?? null;
  const nextSeq = head?.latest_seq == null ? 1n : BigInt(head.latest_seq) + 1n;

  const inserted = await args.client.query<{ id: string }>(
    `INSERT INTO audit_log (
       id, "organizationId", "actorUserId", action, "resourceType", "resourceId",
       "prevHash", "entryHash", seq, "occurredAt"
     )
     VALUES (
       gen_random_uuid(), $1, $2, $3, $4, $5,
       $6, $7, $8::bigint, now()
     )
     RETURNING id`,
    [
      args.organizationId,
      args.actorUserId,
      args.action,
      args.resourceType,
      args.resourceId ?? null,
      prevHash,
      entryHash,
      nextSeq.toString(),
    ]
  );

  // Upsert the chain head so the NEXT call to this helper for the
  // same tenant computes `nextSeq = current + 1` and `prevHash =
  // entryHash`. Mirrors the production writer's atomic chain-head
  // advance.
  await args.client.query(
    `INSERT INTO audit_chain_state ("organizationId", "latestHash", "latestSeq", "updatedAt")
       VALUES ($1, $2, $3::bigint, now())
     ON CONFLICT ("organizationId")
       DO UPDATE SET "latestHash" = EXCLUDED."latestHash",
                     "latestSeq"  = EXCLUDED."latestSeq",
                     "updatedAt"  = now()`,
    [args.organizationId, entryHash, nextSeq.toString()]
  );

  const id = inserted.rows[0]?.id;
  if (id == null) {
    throw new Error("insertAuditLogRow: INSERT ... RETURNING id returned no row");
  }
  return { id, seq: nextSeq, entryHash, prevHash };
}

function randomBytes32(): Buffer {
  return randomBytes(32);
}

/**
 * Delete the seeded tenant + everything the seeder created off
 * it. Used by `afterEach` to keep the integration DB tidy
 * between tests.
 *
 * Order matters: leaf tables first, then walk back to the
 * organization. Some FKs use `ON DELETE RESTRICT` (the safe
 * default) so a wrong order surfaces as 23503. We list only the
 * tables the seeder writes plus the tables a test might write
 * (`verification_record`, `order_event`, `audit_log`,
 * `audit_chain_state`, `event_outbox`).
 *
 * NOT cleaned up here: roles / role_permissions / user_roles /
 * clinic_site. The seeder doesn't create them; a test that does
 * is responsible for its own teardown.
 */
export async function cleanupTenant(client: Client, organizationId: string): Promise<void> {
  // All tables the seeder + test surface uses, in leaf-first
  // order. Each table carries `organizationId`, so a single
  // WHERE clause works.
  const tablesInDeleteOrder = [
    "verification_record",
    "order_event",
    "command_log",
    "audit_log",
    "audit_chain_state",
    "event_outbox",
    "idempotency_key",
    "order_line",
    '"order"',
    "prescription",
    "patient",
    "bucket",
    '"user"',
    "clinic",
    "pharmacy_site",
    "workflow_policy",
  ];
  for (const table of tablesInDeleteOrder) {
    const tableSql = table.startsWith('"') ? table : `"${table}"`;
    await client.query(`DELETE FROM ${tableSql} WHERE "organizationId" = $1`, [organizationId]);
  }
  await client.query(`DELETE FROM organization WHERE id = $1`, [organizationId]);
}
