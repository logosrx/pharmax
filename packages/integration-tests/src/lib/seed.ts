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

import { randomUUID } from "node:crypto";

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
       "idempotencyKey", "requestHash", status, "createdAt"
     )
     VALUES ($1, $2, 'ApprovePV1', $3, $4, $5, $6::"CommandStatus", now())`,
    [
      commandLogId,
      tenant.organizationId,
      tenant.adminUserId,
      `it-${randomUUID()}`,
      `req-${randomUUID()}`,
      CommandStatus.SUCCEEDED,
    ]
  );

  return { patientId, orderId, commandLogId };
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
