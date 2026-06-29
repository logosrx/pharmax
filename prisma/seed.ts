// Pharmax seed.
//
// Idempotent. Safe to run repeatedly. Populates:
//   1. The system-wide permission vocabulary (codes only).
//   2. A demo organization "acme" with built-in roles (per-org clones of
//      the system templates), one site, one clinic, one team, the
//      standard workflow buckets, one workstation, one invited admin
//      user, and the v1 `order.standard` workflow policy stub.
//
// Synthetic data only. NEVER add real patients, providers, or clinic
// names here. The demo organization is clearly marked "(DEMO)" in
// display strings and uses an obviously non-routable email domain.

/* eslint-disable no-console */

import process from "node:process";

import {
  BucketKind,
  LabelPrinterConnection,
  LabelPrinterProtocol,
  LabelPrinterStatus,
  LabelPrinterVendor,
  LabelStockKind,
  LotStatus,
  OrganizationStatus,
  SiteStatus,
  TeamStatus,
  UserStatus,
  WorkflowPolicyStatus,
  WorkstationStatus,
  prisma,
} from "@pharmax/database";
import {
  DEFAULT_VIAL_TEMPLATE_CODE,
  DEFAULT_VIAL_TEMPLATE_VERSION,
  DEFAULT_VIAL_ZPL_TEMPLATE,
} from "@pharmax/labels";
import { ROLE_TEMPLATES } from "@pharmax/rbac";
import { withSystemContext } from "@pharmax/tenancy";

// ---------------------------------------------------------------------------
// 1. System permission vocabulary
// ---------------------------------------------------------------------------

const PERMISSIONS: ReadonlyArray<{ code: string; description: string }> = [
  { code: "orgs.read", description: "Read organization details" },
  { code: "users.manage", description: "Create / suspend / restore users" },
  { code: "roles.manage", description: "Create / edit roles" },
  {
    code: "org.manage_sites",
    description:
      "Edit pharmacy site profile and ship-from address used by the carrier auto-purchase flow",
  },
  { code: "patients.create", description: "Register a new patient at a clinic" },
  { code: "patients.read", description: "Read patient identity (PHI access)" },
  {
    code: "patients.update",
    description:
      "Edit patient identity, contact, address, or MRN (re-encrypts and re-indexes touched columns)",
  },
  {
    code: "patients.crypto_shred",
    description:
      "Crypto-shred a patient: render PHI permanently unreadable (right-to-be-forgotten)",
  },
  { code: "providers.create", description: "Register a new prescribing provider" },
  { code: "providers.read", description: "Read provider directory" },
  {
    code: "providers.update",
    description:
      "Edit provider directory entry (name, credential, DEA, contact, address). NPI is immutable; status changes require DeactivateProvider",
  },
  {
    code: "providers.deactivate",
    description:
      "Deactivate a provider (ACTIVE -> INACTIVE) with a reason code. Blocks new orders against the prescriber",
  },
  {
    code: "providers.reactivate",
    description:
      "Reactivate a provider (INACTIVE -> ACTIVE) with a reason code. Re-enables new orders against the prescriber",
  },
  { code: "orders.create", description: "Create new orders" },
  { code: "orders.read", description: "View orders within scope" },
  {
    code: "orders.add_prescription",
    description: "Attach an additional prescription to an in-flight order",
  },
  {
    code: "orders.cancel",
    description: "Cancel an order before shipment (terminal disposition)",
  },
  {
    code: "orders.place_hold",
    description: "Place an order on hold while a blocker is resolved (reversible)",
  },
  {
    code: "orders.release_hold",
    description: "Release a held order back into the workflow",
  },
  {
    code: "orders.reopen_for_correction",
    description: "Reopen a rejected order for correction at an earlier stage",
  },
  { code: "typing.start", description: "Start typing on an order" },
  { code: "typing.complete", description: "Complete typing review" },
  {
    code: "typing.mark_missing_info",
    description:
      "Pause typing on an order with a structured missing-info reason; parks the order in TYPING_PENDING_MISSING_INFO until ResumeTyping is dispatched",
  },
  { code: "pv1.start", description: "Start PV1 verification" },
  { code: "pv1.approve", description: "Approve PV1" },
  { code: "pv1.reject", description: "Reject PV1" },
  { code: "fill.start", description: "Start fill" },
  { code: "fill.assign_lot", description: "Assign inventory lot during fill" },
  { code: "fill.print_vial_label", description: "Print vial label to thermal printer" },
  { code: "fill.reprint_vial_label", description: "Reprint vial label with reason code" },
  { code: "fill.complete", description: "Complete fill" },
  { code: "labels.confirm_print", description: "Confirm thermal print job from workstation agent" },
  { code: "final.start", description: "Start final verification" },
  { code: "final.approve", description: "Approve final verification" },
  { code: "final.reject", description: "Reject final verification" },
  { code: "ship.release", description: "Release order to shipping" },
  { code: "ship.create", description: "Create carrier shipment record" },
  { code: "ship.confirm", description: "Confirm shipment handoff" },
  {
    code: "ship.purchase_label",
    description:
      "Purchase a shipping label from a carrier (EasyPost), spending real funds on the org's account",
  },
  {
    code: "ship.record_tracking_event",
    description:
      "Record an inbound carrier tracking event against a shipment (system / webhook ingestion)",
  },
  {
    code: "ship.manage_carrier_credentials",
    description:
      "Register, rotate, or disable per-organization carrier API credentials (EasyPost / FedEx / UPS)",
  },
  {
    code: "ship.escalate_to_emergency",
    description:
      "Move an order into the EMERGENCY bucket (worker dispatch on shipment exception / failed delivery / return-to-sender)",
  },
  {
    code: "ship.resolve_escalation",
    description:
      "Disposition an order out of the EMERGENCY bucket back into a workflow bucket (operator action after carrier exception triage)",
  },
  {
    code: "ship.capture_package_photo",
    description:
      "Capture a pre-shipment package photo at the dock and link it to the matched order/patient (writes a PackagePhoto row via CapturePackagePhoto)",
  },
  {
    code: "ship.resolve_package_photo_match",
    description:
      "Resolve an unmatched PackagePhoto by linking it to a specific order (operator triage of dock captures that did not auto-match)",
  },
  {
    code: "ship.archive_package_photo",
    description:
      "Archive a PackagePhoto out of the triage bucket and order timeline with a disposition reason (test capture, duplicate, captured in error, or unresolvable)",
  },
  { code: "billing.read", description: "View billing data" },
  {
    code: "billing.finalize_invoice",
    description:
      "Finalize a DRAFT invoice (DRAFT → OPEN), locking it for further line appends and triggering downstream Stripe push",
  },
  {
    code: "billing.manage_pricing",
    description:
      "Create, update, or supersede per-(org, clinic, product) pricing rules that determine invoice-line unit amounts",
  },
  {
    code: "billing.credit_invoice",
    description:
      "Apply a manual credit / discount / adjustment to an invoice (negative-amount line; preserves the original line audit trail)",
  },
  {
    code: "billing.issue_refund",
    description:
      "Issue a Stripe refund against a paid invoice; writes the corresponding negative-amount line on the Pharmax ledger",
  },
  { code: "billing.manage", description: "Manage invoices and pricing" },
  { code: "audit.read", description: "Read audit log" },
  {
    code: "reports.run",
    description:
      "Run a registered report on-demand and download CSV; writes a report_run row for SOC-2 traceability",
  },
  {
    code: "reports.manage_schedule",
    description:
      "Create, edit, pause, or disable scheduled report executions; the worker tick dispatches the report under a per-org service identity",
  },
  {
    code: "notifications.read",
    description:
      "View outbound notification delivery health (per-recipient delivery status from the Resend webhook); read-only operator metadata",
  },
  {
    code: "orders.escalate_sla",
    description:
      "Route an SLA-breached order into the EMERGENCY bucket; held by the machine SLA-evaluator identity (worker breach-evaluator tick)",
  },
  {
    code: "workflow.overlay.manage",
    description:
      "Create, update, or deactivate per-tenant workflow policy overlays (tighten-only refinements of the base policy; see ADR-0019)",
  },
  {
    code: "compliance.access_review.view",
    description:
      "View persisted SOC 2 access-review snapshots (read-only); gates the operator console's compliance browse surface without exposing user/role mutation permissions",
  },
  {
    code: "compliance.access_review.record",
    description:
      "Dispatch RecordAccessReviewSnapshot to freeze an immutable, digest-sealed (user → role → permission) snapshot for SOC 2 CC6.2 evidence",
  },
];

// ---------------------------------------------------------------------------
// 2. Built-in role templates are imported from @pharmax/rbac so the
//    seed and the CreateOrganization command agree by construction.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 3. Demo workflow buckets
// ---------------------------------------------------------------------------

const BUCKETS: ReadonlyArray<{
  code: string;
  name: string;
  kind: BucketKind;
  sortOrder: number;
}> = [
  { code: "INBOX", name: "Inbox", kind: BucketKind.WORKFLOW, sortOrder: 10 },
  { code: "TYPING", name: "Typing", kind: BucketKind.WORKFLOW, sortOrder: 20 },
  { code: "PV1", name: "PV1", kind: BucketKind.WORKFLOW, sortOrder: 30 },
  { code: "FILL", name: "Fill", kind: BucketKind.WORKFLOW, sortOrder: 40 },
  { code: "FINAL", name: "Final Verification", kind: BucketKind.WORKFLOW, sortOrder: 50 },
  { code: "SHIPPING", name: "Shipping", kind: BucketKind.WORKFLOW, sortOrder: 60 },
  { code: "EMERGENCY", name: "Emergency", kind: BucketKind.EMERGENCY, sortOrder: 100 },
];

// ---------------------------------------------------------------------------

async function seedPermissions(): Promise<void> {
  for (const perm of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { code: perm.code },
      update: { description: perm.description },
      create: { code: perm.code, description: perm.description, isSystem: true },
    });
  }
  console.log(`✓ ${PERMISSIONS.length} permissions seeded`);
}

const DEMO_PRODUCT_NDC = "99999000001";

async function seedFillDemoStack(input: {
  organizationId: string;
  siteId: string;
  workstationId: string;
}): Promise<void> {
  await prisma.printTemplate.upsert({
    where: {
      organizationId_code_version: {
        organizationId: input.organizationId,
        code: DEFAULT_VIAL_TEMPLATE_CODE,
        version: DEFAULT_VIAL_TEMPLATE_VERSION,
      },
    },
    update: { zplBody: DEFAULT_VIAL_ZPL_TEMPLATE, isActive: true },
    create: {
      organizationId: input.organizationId,
      code: DEFAULT_VIAL_TEMPLATE_CODE,
      version: DEFAULT_VIAL_TEMPLATE_VERSION,
      labelStock: LabelStockKind.VIAL,
      zplBody: DEFAULT_VIAL_ZPL_TEMPLATE,
      isActive: true,
    },
  });

  await prisma.labelPrinter.upsert({
    where: {
      organizationId_siteId_code: {
        organizationId: input.organizationId,
        siteId: input.siteId,
        code: "VIAL-ZPL-01",
      },
    },
    update: {
      name: "Zebra Vial Printer (DEMO)",
      status: LabelPrinterStatus.ACTIVE,
      workstationId: input.workstationId,
    },
    create: {
      organizationId: input.organizationId,
      siteId: input.siteId,
      workstationId: input.workstationId,
      code: "VIAL-ZPL-01",
      name: "Zebra Vial Printer (DEMO)",
      vendor: LabelPrinterVendor.ZEBRA,
      protocol: LabelPrinterProtocol.ZPL,
      connection: LabelPrinterConnection.WORKSTATION_AGENT,
      labelStock: LabelStockKind.VIAL,
      status: LabelPrinterStatus.ACTIVE,
    },
  });

  const product = await prisma.product.upsert({
    where: {
      organizationId_ndc: { organizationId: input.organizationId, ndc: DEMO_PRODUCT_NDC },
    },
    update: {
      name: "Demo Testosterone Cypionate (DEMO)",
      strength: "200mg/mL",
      form: "INJECTABLE",
    },
    create: {
      organizationId: input.organizationId,
      ndc: DEMO_PRODUCT_NDC,
      name: "Demo Testosterone Cypionate (DEMO)",
      strength: "200mg/mL",
      form: "INJECTABLE",
    },
  });

  await prisma.lot.upsert({
    where: {
      organizationId_siteId_productId_lotNumber: {
        organizationId: input.organizationId,
        siteId: input.siteId,
        productId: product.id,
        lotNumber: "LOT-DEMO-01",
      },
    },
    update: {
      expirationDate: new Date("2028-12-31T00:00:00.000Z"),
      status: LotStatus.ACTIVE,
    },
    create: {
      organizationId: input.organizationId,
      siteId: input.siteId,
      productId: product.id,
      lotNumber: "LOT-DEMO-01",
      expirationDate: new Date("2028-12-31T00:00:00.000Z"),
      status: LotStatus.ACTIVE,
    },
  });

  console.log("✓ Fill demo stack seeded (vial template, Zebra printer, product, lot)");
}

async function seedDemoOrganization(): Promise<{ orgId: string }> {
  const org = await prisma.organization.upsert({
    where: { slug: "acme" },
    update: { name: "Acme Pharmacy (DEMO)" },
    create: {
      slug: "acme",
      name: "Acme Pharmacy (DEMO)",
      status: OrganizationStatus.ACTIVE,
    },
  });

  // Roles + role-permission grants
  for (const tmpl of ROLE_TEMPLATES) {
    const role = await prisma.role.upsert({
      where: { organizationId_code: { organizationId: org.id, code: tmpl.code } },
      update: { scope: tmpl.scope, name: tmpl.name, description: tmpl.description },
      create: {
        organizationId: org.id,
        code: tmpl.code,
        name: tmpl.name,
        description: tmpl.description,
        scope: tmpl.scope,
        isSystem: true,
      },
    });

    for (const permCode of tmpl.permissions) {
      const perm = await prisma.permission.findUniqueOrThrow({ where: { code: permCode } });
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: { roleId: role.id, permissionId: perm.id },
        },
        update: {},
        create: { roleId: role.id, permissionId: perm.id },
      });
    }
  }

  // Site
  const site = await prisma.pharmacySite.upsert({
    where: { organizationId_code: { organizationId: org.id, code: "MAIN" } },
    update: { name: "Main Site (DEMO)", status: SiteStatus.ACTIVE },
    create: {
      organizationId: org.id,
      code: "MAIN",
      name: "Main Site (DEMO)",
      timezone: "America/New_York",
    },
  });

  // Clinic
  const clinic = await prisma.clinic.upsert({
    where: { organizationId_code: { organizationId: org.id, code: "DEMO" } },
    update: { name: "Demo Clinic" },
    create: { organizationId: org.id, code: "DEMO", name: "Demo Clinic" },
  });

  await prisma.clinicSite.upsert({
    where: { clinicId_siteId: { clinicId: clinic.id, siteId: site.id } },
    update: { isPrimary: true },
    create: { clinicId: clinic.id, siteId: site.id, isPrimary: true },
  });

  // Team
  const team = await prisma.team.upsert({
    where: { siteId_code: { siteId: site.id, code: "TYPING" } },
    update: { name: "Typing Day Shift", status: TeamStatus.ACTIVE },
    create: {
      organizationId: org.id,
      siteId: site.id,
      code: "TYPING",
      name: "Typing Day Shift",
    },
  });

  // Buckets
  for (const def of BUCKETS) {
    await prisma.bucket.upsert({
      where: { organizationId_code: { organizationId: org.id, code: def.code } },
      update: { name: def.name, kind: def.kind, sortOrder: def.sortOrder },
      create: {
        organizationId: org.id,
        siteId: site.id,
        code: def.code,
        name: def.name,
        kind: def.kind,
        sortOrder: def.sortOrder,
        isSystem: true,
      },
    });
  }

  // Workstation
  const workstation = await prisma.workstation.upsert({
    where: { siteId_code: { siteId: site.id, code: "WS-01" } },
    update: { name: "Workstation 01 (DEMO)", status: WorkstationStatus.ACTIVE },
    create: {
      organizationId: org.id,
      siteId: site.id,
      code: "WS-01",
      name: "Workstation 01 (DEMO)",
    },
  });

  // Invited demo admin user (no password is seeded; password is set by
  // the invite-acceptance flow when auth lands).
  const user = await prisma.user.upsert({
    where: {
      organizationId_email: {
        organizationId: org.id,
        email: "owner@acme.test",
      },
    },
    update: { displayName: "Acme Owner (DEMO)" },
    create: {
      organizationId: org.id,
      email: "owner@acme.test",
      displayName: "Acme Owner (DEMO)",
      status: UserStatus.INVITED,
    },
  });

  // OrgAdmin grant. UserRole's composite unique includes nullable scope
  // columns, so upsert can't address it; use findFirst + create.
  const orgAdminRole = await prisma.role.findUniqueOrThrow({
    where: { organizationId_code: { organizationId: org.id, code: "OrgAdmin" } },
  });
  const existingGrant = await prisma.userRole.findFirst({
    where: {
      userId: user.id,
      roleId: orgAdminRole.id,
      siteId: null,
      clinicId: null,
      teamId: null,
    },
  });
  if (!existingGrant) {
    await prisma.userRole.create({
      data: {
        userId: user.id,
        roleId: orgAdminRole.id,
        organizationId: org.id,
      },
    });
  }

  // Shipping webhook service identity. Used by apps/worker's EasyPost
  // drain to enter per-org tenancy and execute
  // `RecordShipmentTrackingEvent` with the bus's RBAC + idempotency +
  // audit + outbox guarantees. Granted `ship.record_tracking_event`
  // org-wide. No password; this identity never logs into the UI.
  const shippingWebhookUser = await prisma.user.upsert({
    where: {
      organizationId_email: {
        organizationId: org.id,
        email: `shipping-webhook@${org.slug}.test`,
      },
    },
    update: { displayName: "Shipping Webhook (DEMO)" },
    create: {
      organizationId: org.id,
      email: `shipping-webhook@${org.slug}.test`,
      displayName: "Shipping Webhook (DEMO)",
      status: UserStatus.ACTIVE,
    },
  });
  // Grant via the dedicated `WebhookService` role. Replaces the
  // prior `OrgAdmin` shortcut — least-privilege for the machine
  // identity that handles inbound carrier traffic. The role
  // template grants exactly `ship.record_tracking_event` +
  // `ship.escalate_to_emergency`; a compromised webhook signing
  // secret can record telemetry and route to EMERGENCY, nothing
  // else (no PHI exposure, no terminal-state writes).
  const webhookServiceRole = await prisma.role.findUniqueOrThrow({
    where: { organizationId_code: { organizationId: org.id, code: "WebhookService" } },
  });
  const existingShippingWebhookGrant = await prisma.userRole.findFirst({
    where: {
      userId: shippingWebhookUser.id,
      roleId: webhookServiceRole.id,
      siteId: null,
      clinicId: null,
      teamId: null,
    },
  });
  if (!existingShippingWebhookGrant) {
    await prisma.userRole.create({
      data: {
        userId: shippingWebhookUser.id,
        roleId: webhookServiceRole.id,
        organizationId: org.id,
      },
    });
  }

  // Reports scheduler service identity. Used by the worker's
  // `report-scheduler` poll loop to enter per-org tenancy and
  // dispatch `RunReport` for due `report_schedule` rows. The
  // operator can't grant this identity any permission outside of
  // `reports.run` because we hardcode the `ReportsScheduler` role
  // template — least-privilege for the machine identity that
  // unattended-runs reports across pharmacy data.
  const reportsSchedulerUser = await prisma.user.upsert({
    where: {
      organizationId_email: {
        organizationId: org.id,
        email: `reports-scheduler@${org.slug}.test`,
      },
    },
    update: { displayName: "Reports Scheduler (DEMO)" },
    create: {
      organizationId: org.id,
      email: `reports-scheduler@${org.slug}.test`,
      displayName: "Reports Scheduler (DEMO)",
      status: UserStatus.ACTIVE,
    },
  });
  const reportsSchedulerRole = await prisma.role.findUniqueOrThrow({
    where: { organizationId_code: { organizationId: org.id, code: "ReportsScheduler" } },
  });
  const existingReportsSchedulerGrant = await prisma.userRole.findFirst({
    where: {
      userId: reportsSchedulerUser.id,
      roleId: reportsSchedulerRole.id,
      siteId: null,
      clinicId: null,
      teamId: null,
    },
  });
  if (!existingReportsSchedulerGrant) {
    await prisma.userRole.create({
      data: {
        userId: reportsSchedulerUser.id,
        roleId: reportsSchedulerRole.id,
        organizationId: org.id,
      },
    });
  }

  // NPI sync worker service identity. Used by the worker's
  // `npi-sync-scheduler` poll loop to enter per-org tenancy and
  // dispatch `UpdateProvider` / `DeactivateProvider` for providers
  // whose CMS-side data has drifted (or whose CMS status has moved
  // to INACTIVE). Granted via the dedicated `NpiSyncWorker` role
  // template — the operator can't bolt other permissions onto this
  // identity; it carries exactly `providers.update` +
  // `providers.deactivate`, the two commands the diff engine
  // produces for non-review-item outcomes.
  const npiSyncWorkerUser = await prisma.user.upsert({
    where: {
      organizationId_email: {
        organizationId: org.id,
        email: `npi-sync@${org.slug}.test`,
      },
    },
    update: { displayName: "NPI Sync Worker (DEMO)" },
    create: {
      organizationId: org.id,
      email: `npi-sync@${org.slug}.test`,
      displayName: "NPI Sync Worker (DEMO)",
      status: UserStatus.ACTIVE,
    },
  });
  const npiSyncWorkerRole = await prisma.role.findUniqueOrThrow({
    where: { organizationId_code: { organizationId: org.id, code: "NpiSyncWorker" } },
  });
  const existingNpiSyncWorkerGrant = await prisma.userRole.findFirst({
    where: {
      userId: npiSyncWorkerUser.id,
      roleId: npiSyncWorkerRole.id,
      siteId: null,
      clinicId: null,
      teamId: null,
    },
  });
  if (!existingNpiSyncWorkerGrant) {
    await prisma.userRole.create({
      data: {
        userId: npiSyncWorkerUser.id,
        roleId: npiSyncWorkerRole.id,
        organizationId: org.id,
      },
    });
  }

  // Workstation print agent service identity (no password; used by
  // apps/print-agent polling loop to confirm thermal print jobs).
  const printAgentUser = await prisma.user.upsert({
    where: {
      organizationId_email: {
        organizationId: org.id,
        email: "print-agent@acme.test",
      },
    },
    update: { displayName: "Print Agent (DEMO)" },
    create: {
      organizationId: org.id,
      email: "print-agent@acme.test",
      displayName: "Print Agent (DEMO)",
      status: UserStatus.ACTIVE,
    },
  });

  const techRole = await prisma.role.findUniqueOrThrow({
    where: { organizationId_code: { organizationId: org.id, code: "PharmacyTechnician" } },
  });
  const existingPrintAgentGrant = await prisma.userRole.findFirst({
    where: {
      userId: printAgentUser.id,
      roleId: techRole.id,
      siteId: site.id,
      clinicId: null,
      teamId: team.id,
    },
  });
  if (!existingPrintAgentGrant) {
    await prisma.userRole.create({
      data: {
        userId: printAgentUser.id,
        roleId: techRole.id,
        organizationId: org.id,
        siteId: site.id,
        teamId: team.id,
      },
    });
  }

  // v1 workflow policy stub. The transition graph and SLA defaults will
  // be authored when @pharmax/workflow lands; the row exists now so
  // verification records can carry workflowPolicyId + version.
  await prisma.workflowPolicy.upsert({
    where: {
      organizationId_code_version: {
        organizationId: org.id,
        code: "order.standard",
        version: 1,
      },
    },
    update: {},
    create: {
      organizationId: org.id,
      code: "order.standard",
      version: 1,
      status: WorkflowPolicyStatus.ACTIVE,
      description: "Default order workflow (Phase 1 stub).",
      definition: {
        states: [
          "RECEIVED",
          "TYPING_IN_PROGRESS",
          "TYPED_READY_FOR_PV1",
          "PV1_IN_PROGRESS",
          "PV1_APPROVED_READY_FOR_FILL",
          "FILL_IN_PROGRESS",
          "FILL_COMPLETED_READY_FOR_FINAL",
          "FINAL_VERIFICATION_IN_PROGRESS",
          "FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP",
          "READY_TO_SHIP",
          "SHIPPED",
        ],
        transitions: [],
      },
      publishedAt: new Date(),
    },
  });

  await seedFillDemoStack({
    organizationId: org.id,
    siteId: site.id,
    workstationId: workstation.id,
  });

  console.log(
    `✓ Demo organization "${org.slug}" seeded (site, clinic, team, ${BUCKETS.length} buckets, workstation, fill stack, users, workflow policy)`
  );

  return { orgId: org.id };
}

async function main(): Promise<void> {
  // The tenancy Prisma extension fail-closes any tenant-scoped query
  // outside a tenancy frame. The seed is a system-tier operation by
  // definition (it creates the org the frames would scope to), so it
  // runs inside an explicit system context — same posture as
  // scripts/bootstrap-org.ts.
  await withSystemContext("seed:demo-data", async () => {
    await seedPermissions();
    await seedDemoOrganization();
  });
  console.log("✓ Seed complete");
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
