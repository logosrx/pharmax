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

import { executeCommand } from "@pharmax/command-bus";
import { DEFAULT_VIAL_TEMPLATE_CODE } from "@pharmax/labels";
import { RegisterPatient } from "@pharmax/patients";
import { PERMISSIONS } from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";
import { BUCKET_CODE_FOR_EXCEPTION_STATE, BUCKET_CODE_FOR_STATUS } from "@pharmax/workflow";

import { cleanupTenant, seedTenant, type SeededTenant } from "../lib/seed.js";

import type { Client } from "pg";

/**
 * A tenant with everything a golden-path dispatch needs.
 *
 * Extends `SeededTenant` rather than replacing it so the existing
 * DB-edge tests and this harness share one definition of "a tenant".
 */
export interface CommandFixture extends SeededTenant {
  readonly roleId: string;
  /**
   * Four distinct operators, because segregation of duties is enforced
   * and the golden path cannot be walked by one person.
   *
   * `SOD_RULES` in `packages/rbac/src/separation-of-duties.ts` forbids
   * three same-actor combinations on one order:
   *
   *   - `PV1_APPROVE` after `TYPING_COMPLETE`
   *   - `FINAL_APPROVE` after `PV1_APPROVE`
   *   - `FINAL_APPROVE` after `FILL_COMPLETE`
   *
   * So the minimum viable cast is a typist, a first pharmacist, a
   * technician, and a second pharmacist. The unit tests never had to
   * model this — they configure the check away — which is exactly the
   * sort of production rule an integration harness exists to surface.
   */
  readonly typistUserId: string;
  readonly pharmacistUserId: string;
  readonly technicianUserId: string;
  readonly pharmacist2UserId: string;
  readonly patientId: string;
  readonly providerId: string;
  readonly productId: string;
  readonly productNdc: string;
  readonly lotId: string;
  readonly lotNumber: string;
  readonly printerId: string;
  /**
   * Paired workstation.
   *
   * `PrintVialLabel` refuses with "can only be dispatched from a paired
   * workstation" unless the tenancy context carries a `workstationId`.
   * That is a real control — a label print is a physical act and the
   * audit record is worth little without the bench it happened at — so
   * the fixture provides one rather than the test working around it.
   */
  readonly workstationId: string;
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
  await seedWorkflowBuckets(client, tenant);

  const [typistUserId, pharmacistUserId, technicianUserId, pharmacist2UserId] = await Promise.all([
    seedOperator(client, tenant, roleId, "typist"),
    seedOperator(client, tenant, roleId, "rph1"),
    seedOperator(client, tenant, roleId, "tech"),
    seedOperator(client, tenant, roleId, "rph2"),
  ]);

  // Dispatched as a real command, so it must follow the RBAC grant.
  const patientId = await seedPatient(tenant, typistUserId);
  const providerId = await seedProvider(client, tenant);
  const { productId, productNdc } = await seedProduct(client, tenant, tag);
  const { lotId, lotNumber } = await seedLot(client, tenant, productId, tag);
  await seedVialPrintTemplate(client, tenant);
  const workstationId = await seedWorkstation(client, tenant, tag);
  const printerId = await seedLabelPrinter(client, tenant, tag, workstationId);

  return {
    ...tenant,
    roleId,
    typistUserId,
    pharmacistUserId,
    technicianUserId,
    pharmacist2UserId,
    patientId,
    providerId,
    productId,
    productNdc,
    lotId,
    lotNumber,
    printerId,
    workstationId,
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
 * An operator holding the all-permissions role.
 *
 * Identity is what matters here, not capability: the SoD check compares
 * `actorUserId` against prior acts on the same order, so four users with
 * identical grants are sufficient to walk the path lawfully.
 */
async function seedOperator(
  client: Client,
  tenant: SeededTenant,
  roleId: string,
  label: string
): Promise<string> {
  const userId = randomUUID();
  await client.query(
    `INSERT INTO "user" (id, "organizationId", email, "displayName", status, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, 'ACTIVE', now(), now())`,
    [
      userId,
      tenant.organizationId,
      `${label}-${randomUUID().slice(0, 8)}@example.test`,
      `IT ${label}`,
    ]
  );
  await client.query(
    `INSERT INTO user_role (id, "userId", "roleId", "organizationId", "createdAt")
     VALUES (gen_random_uuid(), $1, $2, $3, now())`,
    [userId, roleId, tenant.organizationId]
  );
  return userId;
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

/**
 * Seed one bucket per canonical workflow bucket code.
 *
 * The workflow engine moves an order into the bucket for its new state
 * on every transition, and refuses with e.g.
 * `TYPING_BUCKET_NOT_CONFIGURED` when the target is missing — a
 * misconfigured org is treated as an internal error rather than
 * something to route around.
 *
 * The codes are DERIVED from `BUCKET_CODE_FOR_STATUS` and
 * `BUCKET_CODE_FOR_EXCEPTION_STATE` rather than hand-listed, for the
 * same reason `ROUTABLE_ORDER_STATES` is derived in
 * `packages/workflow/src/bucket-routing.ts`: a state that gains a
 * canonical bucket becomes seedable on the commit that adds it. A
 * hand-maintained copy of `["INBOX", "TYPING", …]` would drift, and the
 * failure mode of that drift is a golden-path test that starts failing
 * several stages in, naming a bucket nobody remembers is required.
 *
 * `INBOX` already exists from `seedTenant`, so this is an upsert.
 */
async function seedWorkflowBuckets(client: Client, tenant: SeededTenant): Promise<void> {
  const codes = [
    ...new Set([
      ...Object.values(BUCKET_CODE_FOR_STATUS),
      ...Object.values(BUCKET_CODE_FOR_EXCEPTION_STATE).filter(
        (code): code is string => typeof code === "string"
      ),
    ]),
  ];

  await client.query(
    `INSERT INTO bucket (
       id, "organizationId", "siteId", code, name, kind, "sortOrder",
       "isSystem", "createdAt", "updatedAt"
     )
     SELECT gen_random_uuid(), $1, $2, code, code, 'WORKFLOW',
            (10 + ordinality * 10)::int, true, now(), now()
       FROM unnest($3::text[]) WITH ORDINALITY AS t(code, ordinality)
     ON CONFLICT ("organizationId", code) DO NOTHING`,
    [tenant.organizationId, tenant.siteId, codes]
  );
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
 * Patient, registered through the REAL `RegisterPatient` command.
 *
 * The first draft inserted placeholder ciphertext with raw SQL, on the
 * apparent evidence that no spine command decrypts a patient field. That
 * was wrong, and the way it was wrong is instructive: `PrintVialLabel`
 * does not decrypt anything itself, but the label renderer it calls
 * does, so grepping the command file found nothing and the walk failed
 * several stages later with "Ciphertext envelope is malformed:
 * unsupported version placeholder; expected 1".
 *
 * Dispatching the real command is the better fix regardless. It produces
 * correctly-bound envelopes — AAD over `(tenantId, "patient", column,
 * patientId)` — and correct blind indexes, without this fixture
 * duplicating crypto logic that would then drift from the production
 * path it is standing in for.
 *
 * REQUIRES `configureHarness()` to have run first, since it dispatches
 * through the bus. `seedCommandFixture` documents that ordering.
 */
async function seedPatient(tenant: SeededTenant, actorUserId: string): Promise<string> {
  const out = await withTenancyContext(
    buildTenancyContext({
      organizationId: tenant.organizationId,
      clinicId: tenant.clinicId,
      actor: { userId: actorUserId, correlationId: randomUUID() },
    }),
    () =>
      executeCommand(
        RegisterPatient,
        {
          clinicId: tenant.clinicId,
          firstName: "Ada",
          lastName: "Integration",
          dateOfBirth: "1980-01-15",
        },
        { idempotencyKey: `fixture-patient-${randomUUID()}` }
      )
  );
  return out.patientId;
}

/** ACTIVE prescriber. DEA number present so a CS path is reachable. */
async function seedProvider(client: Client, tenant: SeededTenant): Promise<string> {
  const providerId = randomUUID();
  await client.query(
    `INSERT INTO provider (
       id, "organizationId", npi, "deaNumber", "firstName", "lastName",
       credential, status, "updatedAt"
     )
     VALUES ($1, $2, $3, 'AB1234563', 'Ada', 'Prescriber', 'MD', 'ACTIVE', now())`,
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
  // Stored in ALREADY-NORMALIZED form: 11 digits, no separators.
  //
  // `CreatePrescription` runs `normalizeNdc(input.drugNdc)` before the
  // catalog lookup, using the same function the barcode scanner uses so
  // a transcribed NDC and a scanned NDC are comparable strings. A
  // fixture that stored a hyphenated 10-digit NDC would therefore never
  // match its own input, and the command would refuse with
  // `RX_SCHEDULE_REQUIRED_FOR_UNKNOWN_NDC` — which reads as a catalog
  // problem rather than a fixture one.
  const productNdc = `0${tag.replace(/\D/g, "").padEnd(10, "0").slice(0, 10)}`;
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
       "expirationDate", status, "updatedAt"
     )
     VALUES ($1, $2, $3, $4, $5, (now() + interval '365 days')::date,
             'ACTIVE', now())`,
    [lotId, tenant.organizationId, tenant.siteId, productId, lotNumber]
  );
  return { lotId, lotNumber };
}

/**
 * Seed an extra lot with a caller-chosen status and expiry, for the
 * refusal tests.
 *
 * There is deliberately no `EXPIRED` status in the union because there
 * is none in `LotStatus` — expiry is derived from `expirationDate`
 * rather than stored as state. So the expired-lot refusal is driven by a
 * negative `expiresInDays`, and a held lot is `ON_HOLD`.
 */
export async function seedLotWithState(
  client: Client,
  tenant: SeededTenant,
  productId: string,
  state: {
    readonly status: "ACTIVE" | "ON_HOLD" | "DEPLETED";
    readonly expiresInDays: number;
  }
): Promise<{ lotId: string; lotNumber: string }> {
  const lotId = randomUUID();
  const lotNumber = `LOT-${randomUUID().slice(0, 8)}`;
  await client.query(
    `INSERT INTO lot (
       id, "organizationId", "siteId", "productId", "lotNumber",
       "expirationDate", status, "updatedAt"
     )
     VALUES ($1, $2, $3, $4, $5, (now() + ($6::text || ' days')::interval)::date,
             $7::"LotStatus", now())`,
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

/**
 * ACTIVE vial print template.
 *
 * `PrintVialLabel` resolves the template by code and refuses with
 * "Active vial print template not found" when none exists — a label
 * cannot be rendered without one. The code matches
 * `DEFAULT_VIAL_TEMPLATE_CODE` in `@pharmax/labels`, which is the
 * command's input default.
 *
 * The ZPL body is a minimal valid document rather than the production
 * template: this suite asserts that a print job is recorded, not that
 * the label renders correctly, which belongs to `@pharmax/labels`.
 */
async function seedVialPrintTemplate(client: Client, tenant: SeededTenant): Promise<void> {
  await client.query(
    `INSERT INTO print_template (
       id, "organizationId", code, version, "labelStock", "zplBody",
       "isActive", "updatedAt"
     )
     VALUES (gen_random_uuid(), $1, $2, 1, 'VIAL', $3, true, now())
     ON CONFLICT ("organizationId", code, version) DO NOTHING`,
    [tenant.organizationId, DEFAULT_VIAL_TEMPLATE_CODE, "^XA^FO20,20^A0N,30,30^FDintegration^FS^XZ"]
  );
}

/**
 * ACTIVE workstation at the tenant's site.
 *
 * The bench a technician stands at. Commands that represent a physical
 * act require one in the tenancy context.
 */
async function seedWorkstation(client: Client, tenant: SeededTenant, tag: string): Promise<string> {
  const workstationId = randomUUID();
  await client.query(
    `INSERT INTO workstation (
       id, "organizationId", "siteId", code, name, status, "updatedAt"
     )
     VALUES ($1, $2, $3, $4, 'IT Bench', 'ACTIVE', now())`,
    [workstationId, tenant.organizationId, tenant.siteId, `WS-${tag}`]
  );
  return workstationId;
}

/** ACTIVE vial-stock printer at the tenant's site, on the workstation. */
async function seedLabelPrinter(
  client: Client,
  tenant: SeededTenant,
  tag: string,
  workstationId: string
): Promise<string> {
  const printerId = randomUUID();
  await client.query(
    `INSERT INTO label_printer (
       id, "organizationId", "siteId", "workstationId", code, name, vendor,
       protocol, connection, "labelStock", "networkAddress", status, "updatedAt"
     )
     VALUES ($1, $2, $3, $4, $5, 'IT Vial Printer', 'ZEBRA', 'ZPL',
             'NETWORK_RAW', 'VIAL', '127.0.0.1:9100', 'ACTIVE', now())`,
    [printerId, tenant.organizationId, tenant.siteId, workstationId, `IT-${tag}`]
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

  // Strict leaf-first order. FKs default to RESTRICT, so a wrong order
  // surfaces as 23503 rather than silently leaving rows behind.
  //
  // The ordering constraint that is easy to get wrong: `prescription`
  // and `order_line` reference `provider`, `product` and `lot`, and
  // `cleanupTenant` deletes prescriptions in its own sweep. So the
  // catalog rows CANNOT simply be appended to a list that runs before
  // `cleanupTenant` — the orders and prescriptions must go first, then
  // the catalog, then `cleanupTenant` handles the remainder.
  //
  // Table names verified against the live schema: the SLA table is
  // `order_stage_interval`, not `sla_interval`.
  const deleteOrder = [
    // Tier 1 — everything that references `command_log` or `"order"`.
    // Taken from the live FK graph rather than from what the golden path
    // happens to write today, so a command added later that writes one
    // of these does not silently start leaking rows.
    // The labelling tables form a genuine FK CYCLE:
    //
    //   order_line.vialLabelId      -> vial_label
    //   vial_label.activePrintJobId -> print_job   (NOT NULL)
    //   print_job.orderLineId       -> order_line
    //
    // No delete order alone satisfies all three, so the single UPDATE
    // above nulls `order_line.vialLabelId`; the rest then unwinds
    // child-first. The cycle is not a schema mistake — a line points at
    // its current label and a label at the print that produced it, and
    // `activePrintJobId` is rightly NOT NULL because a label with no
    // print never existed.
    "lot_assignment",
    "inventory_transaction",
    "vial_label",
    "print_job",
    "order_line",
    "shipment_tracking_event",
    "shipment",
    "order_stage_interval",
    "verification_record",
    "order_screening_finding",
    "order_screening_acknowledgement",
    "patient_screening_acknowledgement",
    "order_event",
    "order_cancellation",
    "order_correction_reopen",
    "order_hold",
    "controlled_substance_dispensing",
    "compounding_record",
    "package_photo",
    "invoice_line",
    "typing_suggestion",
    "typing_suggestion_run",

    // Tier 2 — `command_log` references `"order"`, so it has to go
    // before the order but after everything above that references it.
    // This is the ordering the first draft got wrong: deleting the order
    // first fails on `command_log_targetOrderId_fkey`.
    "command_log",

    // Tier 3 — the order, then the prescription it was built from.
    '"order"',
    "prescription",
    "rx_number_sequence",

    // Tier 4 — catalog and devices, now unreferenced by any order.
    // These MUST precede `cleanupTenant`, which finishes by deleting the
    // organization they point at.
    "print_template",
    "label_printer",
    "workstation",
    "lot",
    "product",
    "provider",
  ];
  // Break the order_line / vial_label / print_job cycle described above
  // by nulling the two nullable edges. Both are scoped to this tenant, so
  // a concurrent fixture is unaffected.
  // Only ONE edge needs nulling. `print_job.orderLineId` is nullable but
  // carries a `print_job_exactly_one_target` CHECK — a job must point at
  // exactly one target — so nulling it is refused, and correctly so.
  // Deleting the job (the child) before the line satisfies the FK
  // without touching the constraint.
  await client.query(`UPDATE order_line SET "vialLabelId" = NULL WHERE "organizationId" = $1`, [
    organizationId,
  ]);

  for (const table of deleteOrder) {
    const tableSql = table.startsWith('"') ? table : `"${table}"`;
    await client.query(`DELETE FROM ${tableSql} WHERE "organizationId" = $1`, [organizationId]);
  }

  // No organizationId on these two — delete through the parents.
  await client.query(`DELETE FROM clinic_site WHERE "clinicId" = $1`, [fixture.clinicId]);
  await client.query(`DELETE FROM role_permission WHERE "roleId" = $1`, [fixture.roleId]);
  await client.query(`DELETE FROM user_role WHERE "organizationId" = $1`, [organizationId]);
  await client.query(`DELETE FROM role WHERE "organizationId" = $1`, [organizationId]);

  await cleanupTenant(client, organizationId);
}
