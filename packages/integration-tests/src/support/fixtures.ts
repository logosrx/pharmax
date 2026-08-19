// Fixtures for the command-bus integration harness.
//
// `lib/seed.ts` seeds the scaffolding needed to INSERT rows directly:
// organization, workflow_policy, pharmacy_site, clinic, bucket, user.
// Running real commands needs considerably more, because a command
// checks its preconditions before it writes anything:
//
//   RBAC          permission (global) + role + role_permission + user_role
//                 — without these every dispatch stops at the
//                   permission check and nothing downstream is exercised
//   clinic_site   CreateOrder requires the clinic to be linked to the site
//   provider      CreatePrescription requires an ACTIVE prescriber
//   product       CreatePrescription resolves the controlled-substance
//                 schedule from the catalog and REFUSES if absent
//   lot           AssignLot needs an unexpired, unheld lot at the site
//   label printer PrintVialLabel needs an ACTIVE printer with VIAL stock
//
// Everything is written with raw `pg` on an owner connection, mirroring
// production's split: bootstrap runs privileged, runtime runs as
// `pharmax_app`. Seeding through the app role would require a tenancy
// GUC to already be set for an organization that does not exist yet.
//
// ## Why permissions are granted wholesale
//
// `grantAllPermissions` inserts every code in `PERMISSIONS` and grants
// the lot to one role. Enumerating per command was the alternative and
// it is worse: the list would silently rot every time a command's
// `permission:` changed, and a fixture that under-grants fails as
// "PERMISSION_DENIED" — which reads like the command is broken rather
// than the fixture. RBAC's own refusal semantics are unit-tested; here
// the grant exists so the rest of the command can be reached.
// `seedUserWithoutPermissions` provides the negative case.

import { randomUUID } from "node:crypto";

import { PERMISSIONS } from "@pharmax/rbac";

import { cleanupTenant, seedTenant, type SeededTenant } from "../lib/seed.js";

import type { Client } from "pg";

const PHI_PLACEHOLDER_JSON = JSON.stringify({ v: "placeholder", alg: "test" });

/**
 * A tenant with everything a golden-path dispatch needs.
 *
 * Extends `SeededTenant` rather than replacing it so the existing
 * DB-edge tests and this harness share one definition of "a tenant".
 */
export interface CommandFixture extends SeededTenant {
  readonly roleId: string;
  readonly patientId: string;
  readonly providerId: string;
  readonly productId: string;
  readonly productNdc: string;
  readonly lotId: string;
  readonly lotNumber: string;
  readonly printerId: string;
}

/**
 * Seed a tenant plus the full command prerequisite set.
 *
 * The caller owns teardown: `await cleanupCommandFixture(client, f)`.
 */
export async function seedCommandFixture(client: Client): Promise<CommandFixture> {
  const tenant = await seedTenant(client);
  const tag = randomUUID().slice(0, 8);

  const roleId = await grantAllPermissions(client, tenant);
  await linkClinicToSite(client, tenant);

  const patientId = await seedPatient(client, tenant);
  const providerId = await seedProvider(client, tenant);
  const { productId, productNdc } = await seedProduct(client, tenant, tag);
  const { lotId, lotNumber } = await seedLot(client, tenant, productId, tag);
  const printerId = await seedLabelPrinter(client, tenant, tag);

  return {
    ...tenant,
    roleId,
    patientId,
    providerId,
    productId,
    productNdc,
    lotId,
    lotNumber,
    printerId,
  };
}

/**
 * Insert every `PERMISSIONS` code, create a role holding all of them,
 * and grant that role to the tenant's admin user.
 *
 * `permission` is a GLOBAL table (no `organizationId`, RLS-exempt), so
 * rows are shared across tenants and inserted `ON CONFLICT DO NOTHING`
 * — a concurrent fixture or a prior `pnpm db:seed` may already have
 * them, and that is fine.
 */
async function grantAllPermissions(client: Client, tenant: SeededTenant): Promise<string> {
  const codes = Object.values(PERMISSIONS);

  await client.query(
    `INSERT INTO permission (id, code, description, "isSystem", "createdAt")
     SELECT gen_random_uuid(), code, 'integration fixture', true, now()
       FROM unnest($1::text[]) AS code
     ON CONFLICT (code) DO NOTHING`,
    [codes]
  );

  const roleId = randomUUID();
  await client.query(
    `INSERT INTO role (id, "organizationId", code, name, scope, "isSystem", "createdAt", "updatedAt")
     VALUES ($1, $2, 'IT_ALL', 'IT All Permissions', 'ORGANIZATION', false, now(), now())`,
    [roleId, tenant.organizationId]
  );

  await client.query(
    `INSERT INTO role_permission (id, "roleId", "permissionId", "createdAt")
     SELECT gen_random_uuid(), $1, p.id, now()
       FROM permission p
      WHERE p.code = ANY($2::text[])
     ON CONFLICT ("roleId", "permissionId") DO NOTHING`,
    [roleId, codes]
  );

  await client.query(
    `INSERT INTO user_role (id, "userId", "roleId", "organizationId", "createdAt")
     VALUES (gen_random_uuid(), $1, $2, $3, now())`,
    [tenant.adminUserId, roleId, tenant.organizationId]
  );

  return roleId;
}

/**
 * A second user in the same tenant holding NO role.
 *
 * The positive fixture grants everything, which cannot demonstrate that
 * the permission check is load-bearing. This user can.
 */
export async function seedUserWithoutPermissions(
  client: Client,
  tenant: SeededTenant
): Promise<string> {
  const userId = randomUUID();
  await client.query(
    `INSERT INTO "user" (id, "organizationId", email, "displayName", status, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, 'IT No Perms', 'ACTIVE', now(), now())`,
    [userId, tenant.organizationId, `noperms-${randomUUID().slice(0, 8)}@example.test`]
  );
  return userId;
}

/** CreateOrder rejects a clinic that is not served by the site. */
async function linkClinicToSite(client: Client, tenant: SeededTenant): Promise<void> {
  await client.query(
    `INSERT INTO clinic_site (id, "clinicId", "siteId", "isPrimary", "createdAt")
     VALUES (gen_random_uuid(), $1, $2, true, now())
     ON CONFLICT ("clinicId", "siteId") DO NOTHING`,
    [tenant.clinicId, tenant.siteId]
  );
}

/**
 * Patient with placeholder PHI ciphertext.
 *
 * Verified against the spine: none of the fourteen commands decrypts a
 * patient field, so non-decryptable placeholders are sufficient and keep
 * the fixture independent of KMS configuration. If a future command in
 * the spine starts reading patient name — a label renderer, most
 * likely — this has to switch to real `encryptField` output with the
 * `{tenantId, table, column, recordId}` binding, and the failure will be
 * an explicit decrypt error rather than silent wrong data.
 */
async function seedPatient(client: Client, tenant: SeededTenant): Promise<string> {
  const patientId = randomUUID();
  await client.query(
    `INSERT INTO patient (
       id, "organizationId", "clinicId",
       "firstNameEnc", "lastNameEnc", "dateOfBirthEnc",
       "lastNameBi", "firstNameBi", "dobBi", "dobYearMonthBi",
       status, "createdAt", "updatedAt"
     )
     VALUES ($1, $2, $3, $4::jsonb, $4::jsonb, $4::jsonb,
             $5, $6, $7, $8, 'ACTIVE', now(), now())`,
    [
      patientId,
      tenant.organizationId,
      tenant.clinicId,
      PHI_PLACEHOLDER_JSON,
      `bi-last-${patientId}`,
      `bi-first-${patientId}`,
      `bi-dob-${patientId}`,
      `bi-dob-ym-${patientId}`,
    ]
  );
  return patientId;
}

/** ACTIVE prescriber. DEA number present so a CS path is reachable. */
async function seedProvider(client: Client, tenant: SeededTenant): Promise<string> {
  const providerId = randomUUID();
  await client.query(
    `INSERT INTO provider (
       id, "organizationId", npi, "deaNumber", "firstName", "lastName",
       credential, status, "createdAt", "updatedAt"
     )
     VALUES ($1, $2, $3, 'AB1234563', 'Ada', 'Prescriber', 'MD', 'ACTIVE', now(), now())`,
    [providerId, tenant.organizationId, randomNpi()]
  );
  return providerId;
}

/**
 * Catalog product.
 *
 * `CreatePrescription` looks this up by `(organizationId, ndc)` and
 * refuses with `PRESCRIPTION_PRODUCT_NOT_FOUND` when it is absent —
 * dispensing a drug the catalog does not know is not something to
 * default through. NON_CONTROLLED keeps the spine off the
 * controlled-substance authorisation path, which has its own tests.
 */
async function seedProduct(
  client: Client,
  tenant: SeededTenant,
  tag: string
): Promise<{ productId: string; productNdc: string }> {
  const productId = randomUUID();
  const productNdc = `00000-${tag.slice(0, 4)}-01`;
  // Columns are the NOT NULL set read from the live schema: `product`
  // has no `status`, and `controlledSubstanceSchedule` carries a
  // default. Listing only what is required keeps this fixture from
  // breaking every time an optional column is added.
  await client.query(
    `INSERT INTO product (
       id, "organizationId", ndc, name, strength, form,
       "controlledSubstanceSchedule", "updatedAt"
     )
     VALUES ($1, $2, $3, 'Integration Tablet', '10 mg', 'tablet',
             'NON_CONTROLLED', now())`,
    [productId, tenant.organizationId, productNdc]
  );
  return { productId, productNdc };
}

/**
 * Unexpired, ACTIVE lot at the tenant's site.
 *
 * Expiry is a year out so the golden path is not date-fragile. The
 * expired-lot refusal test seeds its own lot with a past date rather
 * than mutating this one, so the two cannot interfere.
 */
async function seedLot(
  client: Client,
  tenant: SeededTenant,
  productId: string,
  tag: string
): Promise<{ lotId: string; lotNumber: string }> {
  const lotId = randomUUID();
  const lotNumber = `LOT-${tag}`;
  await client.query(
    `INSERT INTO lot (
       id, "organizationId", "siteId", "productId", "lotNumber",
       "expirationDate", status, "createdAt", "updatedAt"
     )
     VALUES ($1, $2, $3, $4, $5, (now() + interval '365 days')::date,
             'ACTIVE', now(), now())`,
    [lotId, tenant.organizationId, tenant.siteId, productId, lotNumber]
  );
  return { lotId, lotNumber };
}

/** Seed an extra lot with a caller-chosen status/expiry for refusal tests. */
export async function seedLotWithState(
  client: Client,
  tenant: SeededTenant,
  productId: string,
  state: {
    readonly status: "ACTIVE" | "QUARANTINED" | "EXPIRED" | "DEPLETED";
    readonly expiresInDays: number;
  }
): Promise<{ lotId: string; lotNumber: string }> {
  const lotId = randomUUID();
  const lotNumber = `LOT-${randomUUID().slice(0, 8)}`;
  await client.query(
    `INSERT INTO lot (
       id, "organizationId", "siteId", "productId", "lotNumber",
       "expirationDate", status, "createdAt", "updatedAt"
     )
     VALUES ($1, $2, $3, $4, $5, (now() + ($6::text || ' days')::interval)::date,
             $7::"LotStatus", now(), now())`,
    [
      lotId,
      tenant.organizationId,
      tenant.siteId,
      productId,
      lotNumber,
      String(state.expiresInDays),
      state.status,
    ]
  );
  return { lotId, lotNumber };
}

/** ACTIVE vial-stock printer at the tenant's site. */
async function seedLabelPrinter(
  client: Client,
  tenant: SeededTenant,
  tag: string
): Promise<string> {
  const printerId = randomUUID();
  await client.query(
    `INSERT INTO label_printer (
       id, "organizationId", "siteId", code, name, vendor, protocol,
       connection, "labelStock", "networkAddress", status,
       "createdAt", "updatedAt"
     )
     VALUES ($1, $2, $3, $4, 'IT Vial Printer', 'ZEBRA', 'ZPL',
             'NETWORK', 'VIAL', '127.0.0.1:9100', 'ACTIVE', now(), now())`,
    [printerId, tenant.organizationId, tenant.siteId, `IT-${tag}`]
  );
  return printerId;
}

/** 10 digits. Not validated against the NPI check digit by the fixture path. */
function randomNpi(): string {
  return String(Math.floor(1_000_000_000 + Math.random() * 8_999_999_999));
}

/**
 * Tear down a command fixture.
 *
 * `cleanupTenant` in `lib/seed.ts` deletes by `organizationId`, which
 * covers most tables but cannot cover two cases this fixture creates:
 *
 *   - `clinic_site` and `role_permission` have NO `organizationId`
 *     column, so they must be deleted via their parent ids.
 *   - `permission` rows are global and deliberately NOT deleted. They
 *     are shared, `ON CONFLICT DO NOTHING` on insert, and removing them
 *     would break a concurrently running fixture.
 *
 * Order matters: FKs are `RESTRICT` by default, so leaves go first.
 */
export async function cleanupCommandFixture(
  client: Client,
  fixture: CommandFixture
): Promise<void> {
  const { organizationId } = fixture;

  // Rows the command run creates that `cleanupTenant` does not list.
  for (const table of [
    "print_job",
    "label_printer",
    "shipment_tracking_event",
    "shipment",
    "lot_assignment",
    "inventory_transaction",
    "sla_interval",
    "lot",
    "product",
    "provider",
  ]) {
    await client.query(`DELETE FROM "${table}" WHERE "organizationId" = $1`, [organizationId]);
  }

  // No organizationId on these two — delete through the parents.
  await client.query(`DELETE FROM clinic_site WHERE "clinicId" = $1`, [fixture.clinicId]);
  await client.query(`DELETE FROM role_permission WHERE "roleId" = $1`, [fixture.roleId]);
  await client.query(`DELETE FROM user_role WHERE "organizationId" = $1`, [organizationId]);
  await client.query(`DELETE FROM role WHERE "organizationId" = $1`, [organizationId]);

  await cleanupTenant(client, organizationId);
}
