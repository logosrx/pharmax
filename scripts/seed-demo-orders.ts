#!/usr/bin/env tsx
// scripts/seed-demo-orders.ts
//
// Populates the demo "acme" organization with SYNTHETIC patients,
// prescriptions, and orders so the operator console queues have
// visible work. Run AFTER `pnpm db:seed` (which creates the org,
// roles, buckets, product, and lot).
//
//   pnpm tsx scripts/seed-demo-orders.ts
//
// Everything flows through the REAL command bus (RegisterPatient,
// CreateOrder, StartTyping, CompleteTypingReview, StartPV1,
// ApprovePV1) under the seeded admin's identity, so command_log /
// order_event / audit_log / event_outbox rows are produced exactly
// as production would. The only direct Prisma writes are the demo
// Provider + Prescription rows — no production intake command
// exists for those yet (they arrive with the e-prescribe API).
//
// Idempotent-ish: exits early if any DEMO-ORD-* order already
// exists in the org (re-running won't duplicate the demo book).
//
// Synthetic data only. Names are obviously fake; the NDC matches
// the seeded demo product so the fill workbench finds LOT-DEMO-01.
//
// Required env:
//   DATABASE_URL              Postgres connection string.
//   PHARMAX_LOCAL_KMS_SEED    >=32-char dev KMS seed (must match
//                             apps/web so the UI can decrypt).

import { randomUUID } from "node:crypto";
import process from "node:process";

import { configureCommandBus, executeCommand } from "@pharmax/command-bus";
import { blindIndex, configureCrypto, encryptField, LocalKmsAdapter } from "@pharmax/crypto";
import { OrderPriority, Prisma, prisma, ProviderStatus, UserStatus } from "@pharmax/database";
import { CreateOrder } from "@pharmax/orders";
import { RegisterPatient } from "@pharmax/patients";
import { clock, errors, logger as loggerNs } from "@pharmax/platform-core";
import { configureRbac, PrismaPermissionLoader } from "@pharmax/rbac";
import { buildTenancyContext, withSystemContext, withTenancyContext } from "@pharmax/tenancy";
import { ApprovePV1, CompleteTypingReview, StartPV1, StartTyping } from "@pharmax/verification";

const ORG_SLUG = "acme";
const DEMO_NDC = "99999000001"; // matches prisma/seed.ts DEMO_PRODUCT_NDC
const DEMO_ORDER_PREFIX = "DEMO-ORD-";

interface DemoPatient {
  readonly firstName: string;
  readonly lastName: string;
  readonly dateOfBirth: string;
  readonly phone: string;
  readonly city: string;
  readonly state: string;
  readonly postalCode: string;
  readonly addressLine1: string;
}

// Obviously-synthetic identities (no real patient data — ever).
const DEMO_PATIENTS: ReadonlyArray<DemoPatient> = [
  {
    firstName: "Pat",
    lastName: "Synthetic",
    dateOfBirth: "1984-02-11",
    phone: "5550100001",
    addressLine1: "1 Demo Way",
    city: "Testville",
    state: "NY",
    postalCode: "10001",
  },
  {
    firstName: "Sam",
    lastName: "Placeholder",
    dateOfBirth: "1991-07-23",
    phone: "5550100002",
    addressLine1: "2 Demo Way",
    city: "Testville",
    state: "NY",
    postalCode: "10001",
  },
  {
    firstName: "Alex",
    lastName: "Example",
    dateOfBirth: "1978-11-05",
    phone: "5550100003",
    addressLine1: "3 Demo Way",
    city: "Mockham",
    state: "NJ",
    postalCode: "07001",
  },
  {
    firstName: "Jordan",
    lastName: "Fictitious",
    dateOfBirth: "2001-03-30",
    phone: "5550100004",
    addressLine1: "4 Demo Way",
    city: "Mockham",
    state: "NJ",
    postalCode: "07001",
  },
  {
    firstName: "Casey",
    lastName: "Notreal",
    dateOfBirth: "1969-09-14",
    phone: "5550100005",
    addressLine1: "5 Demo Way",
    city: "Fakefield",
    state: "CT",
    postalCode: "06001",
  },
];

// Stage targets for the 9 demo orders. `advance` is how far past
// RECEIVED each order is pushed through the real workflow commands.
type Advance = "none" | "typing" | "ready_for_pv1" | "pv1_in_progress" | "ready_for_fill";

const DEMO_ORDERS: ReadonlyArray<{
  readonly patientIdx: number;
  readonly priority: (typeof OrderPriority)[keyof typeof OrderPriority];
  readonly advance: Advance;
}> = [
  { patientIdx: 0, priority: OrderPriority.EMERGENCY, advance: "none" },
  { patientIdx: 1, priority: OrderPriority.RUSH, advance: "none" },
  { patientIdx: 2, priority: OrderPriority.NORMAL, advance: "none" },
  { patientIdx: 3, priority: OrderPriority.NORMAL, advance: "typing" },
  { patientIdx: 4, priority: OrderPriority.RUSH, advance: "typing" },
  { patientIdx: 0, priority: OrderPriority.NORMAL, advance: "ready_for_pv1" },
  { patientIdx: 1, priority: OrderPriority.RUSH, advance: "ready_for_pv1" },
  { patientIdx: 2, priority: OrderPriority.NORMAL, advance: "pv1_in_progress" },
  { patientIdx: 3, priority: OrderPriority.NORMAL, advance: "ready_for_fill" },
];

async function main(): Promise<void> {
  if (typeof process.env["DATABASE_URL"] !== "string") {
    process.stderr.write("DATABASE_URL is required.\n");
    process.exit(1);
  }
  const kmsSeed = process.env["PHARMAX_LOCAL_KMS_SEED"];
  if (typeof kmsSeed !== "string" || kmsSeed.length < 32) {
    process.stderr.write("PHARMAX_LOCAL_KMS_SEED is required (>=32 chars). See .env.example.\n");
    process.exit(1);
  }

  const logger = loggerNs.createPinoLogger({ service: "seed-demo-orders", level: "warn" });

  configureCrypto({ kms: new LocalKmsAdapter({ seed: kmsSeed }) });
  configureRbac({ loader: new PrismaPermissionLoader(prisma) });
  configureCommandBus({ prisma, clock: clock.systemClock, logger });

  // ---- Resolve the demo tenant (system context: cross-cutting reads) ----
  //
  // Two actors, because the platform's Separation-of-Duties guard is
  // real: the typist who completes typing review CANNOT approve PV1
  // on the same order. The admin acts as the typist; a dedicated
  // demo pharmacist performs the PV1 steps.
  const tenant = await withSystemContext("seed-demo-orders:resolve-tenant", async () => {
    const org = await prisma.organization.findUnique({ where: { slug: ORG_SLUG } });
    if (org === null) {
      throw new Error(`Organization "${ORG_SLUG}" not found. Run \`pnpm db:seed\` first.`);
    }
    const clinic = await prisma.clinic.findFirst({ where: { organizationId: org.id } });
    const site = await prisma.pharmacySite.findFirst({ where: { organizationId: org.id } });
    const admin = await prisma.user.findUnique({
      where: { organizationId_email: { organizationId: org.id, email: "owner@acme.test" } },
    });
    if (clinic === null || site === null || admin === null) {
      throw new Error("Demo clinic/site/admin missing. Run `pnpm db:seed` first.");
    }

    // Demo pharmacist (idempotent): the second pair of hands for SoD.
    const pharmacist = await prisma.user.upsert({
      where: {
        organizationId_email: { organizationId: org.id, email: "pharmacist@acme.test" },
      },
      update: { displayName: "Demo Pharmacist (DEMO)" },
      create: {
        organizationId: org.id,
        email: "pharmacist@acme.test",
        displayName: "Demo Pharmacist (DEMO)",
        status: UserStatus.INVITED,
      },
    });
    const pharmacistRole = await prisma.role.findUniqueOrThrow({
      where: { organizationId_code: { organizationId: org.id, code: "Pharmacist" } },
    });
    const existingGrant = await prisma.userRole.findFirst({
      where: {
        userId: pharmacist.id,
        roleId: pharmacistRole.id,
        siteId: null,
        clinicId: null,
        teamId: null,
      },
    });
    if (existingGrant === null) {
      await prisma.userRole.create({
        data: {
          userId: pharmacist.id,
          roleId: pharmacistRole.id,
          organizationId: org.id,
        },
      });
    }

    const existing = await prisma.order.findFirst({
      where: { organizationId: org.id, externalOrderNumber: { startsWith: DEMO_ORDER_PREFIX } },
      select: { id: true },
    });

    return {
      organizationId: org.id,
      clinicId: clinic.id,
      siteId: site.id,
      adminUserId: admin.id,
      pharmacistUserId: pharmacist.id,
      alreadySeeded: existing !== null,
    };
  });

  if (tenant.alreadySeeded) {
    process.stdout.write("Demo orders already present (DEMO-ORD-*); nothing to do.\n");
    await prisma.$disconnect();
    return;
  }

  const ctx = buildTenancyContext({
    organizationId: tenant.organizationId,
    siteId: tenant.siteId,
    clinicId: tenant.clinicId,
    actor: { userId: tenant.adminUserId, correlationId: randomUUID() },
  });
  const pharmacistCtx = buildTenancyContext({
    organizationId: tenant.organizationId,
    siteId: tenant.siteId,
    clinicId: tenant.clinicId,
    actor: { userId: tenant.pharmacistUserId, correlationId: randomUUID() },
  });

  // ---- Patients: REAL RegisterPatient commands (encrypt + BI + audit) ----
  const patientIds: string[] = [];
  for (const p of DEMO_PATIENTS) {
    const result = await withTenancyContext(ctx, () =>
      executeCommand(RegisterPatient, {
        clinicId: tenant.clinicId,
        firstName: p.firstName,
        lastName: p.lastName,
        dateOfBirth: p.dateOfBirth,
        phone: p.phone,
        addressLine1: p.addressLine1,
        city: p.city,
        state: p.state,
        postalCode: p.postalCode,
      })
    );
    patientIds.push(result.patientId);
  }
  process.stdout.write(`✓ ${patientIds.length} synthetic patients registered\n`);

  // ---- Provider + prescriptions (direct writes; no intake command yet) ----
  const { providerId, prescriptionIds } = await withSystemContext(
    "seed-demo-orders:provider-and-rx",
    async () => {
      let provider = await prisma.provider.findFirst({
        where: { organizationId: tenant.organizationId, npi: "1999999992" },
      });
      provider ??= await prisma.provider.create({
        data: {
          organizationId: tenant.organizationId,
          npi: "1999999992",
          firstName: "Demo",
          lastName: "Prescriber (DEMO)",
          credential: "MD",
          status: ProviderStatus.ACTIVE,
        },
      });

      const rxIds: string[] = [];
      for (let i = 0; i < DEMO_ORDERS.length; i++) {
        const rxNumber = `DEMO-RX-${String(1001 + i)}`;
        const prescriptionId = randomUUID();
        const sigEnc = await encryptField({
          plaintext: "Inject 1mL (200mg) intramuscularly once weekly. (DEMO)",
          binding: {
            tenantId: tenant.organizationId,
            table: "prescription",
            column: "sig",
            recordId: prescriptionId,
          },
        });
        const rxNumberBi = await blindIndex({
          value: rxNumber,
          binding: {
            tenantId: tenant.organizationId,
            table: "prescription",
            column: "rxNumber",
          },
        });
        if (rxNumberBi === null) throw new Error("rxNumber blind index resolved null");

        const row = await prisma.prescription.create({
          data: {
            id: prescriptionId,
            organizationId: tenant.organizationId,
            clinicId: tenant.clinicId,
            patientId: patientIds[DEMO_ORDERS[i]!.patientIdx]!,
            providerId: provider.id,
            rxNumber,
            rxNumberBi,
            drugNdc: DEMO_NDC,
            drugName: "Demo Testosterone Cypionate (DEMO)",
            drugStrength: "200mg/mL",
            drugForm: "INJECTABLE",
            quantityAuthorized: new Prisma.Decimal(10),
            daysSupply: 30,
            refillsAuthorized: 3,
            refillsRemaining: 3,
            originalDateWritten: new Date("2026-05-15T00:00:00.000Z"),
            expiresAt: new Date("2027-05-15T00:00:00.000Z"),
            sigEnc: sigEnc as unknown as Prisma.InputJsonValue,
          },
        });
        rxIds.push(row.id);
      }
      return { providerId: provider.id, prescriptionIds: rxIds };
    }
  );
  process.stdout.write(`✓ provider ${providerId} + ${prescriptionIds.length} prescriptions\n`);

  // ---- Orders + workflow advancement: REAL commands all the way ----
  const summary: Record<string, number> = {};
  for (let i = 0; i < DEMO_ORDERS.length; i++) {
    const spec = DEMO_ORDERS[i]!;
    const created = await withTenancyContext(ctx, () =>
      executeCommand(CreateOrder, {
        clinicId: tenant.clinicId,
        siteId: tenant.siteId,
        patientId: patientIds[spec.patientIdx]!,
        externalOrderNumber: `${DEMO_ORDER_PREFIX}${String(2026001 + i)}`,
        intakeSourceKind: "API",
        priority: spec.priority,
        lines: [{ prescriptionId: prescriptionIds[i]!, quantityToFill: 1, daysSupplyToFill: 30 }],
      })
    );

    // Each target stage replays the real command sequence from
    // RECEIVED. Ordered prefix: typing < ready_for_pv1 <
    // pv1_in_progress < ready_for_fill.
    const orderId = created.orderId;
    const depth: Record<Advance, number> = {
      none: 0,
      typing: 1,
      ready_for_pv1: 2,
      pv1_in_progress: 3,
      ready_for_fill: 4,
    };
    // Typing steps run as the admin (typist hat); PV1 steps run as
    // the demo pharmacist — the SoD guard rejects a PV1 approval by
    // the same user who completed typing review.
    const d = depth[spec.advance];
    if (d >= 1) await withTenancyContext(ctx, () => executeCommand(StartTyping, { orderId }));
    if (d >= 2)
      await withTenancyContext(ctx, () => executeCommand(CompleteTypingReview, { orderId }));
    if (d >= 3)
      await withTenancyContext(pharmacistCtx, () => executeCommand(StartPV1, { orderId }));
    if (d >= 4)
      await withTenancyContext(pharmacistCtx, () => executeCommand(ApprovePV1, { orderId }));
    summary[spec.advance] = (summary[spec.advance] ?? 0) + 1;
  }

  process.stdout.write(`✓ ${DEMO_ORDERS.length} demo orders created:\n`);
  for (const [stage, n] of Object.entries(summary)) {
    process.stdout.write(`    ${stage.padEnd(16)} × ${n}\n`);
  }
  process.stdout.write("✓ Demo order book seeded\n");
  await prisma.$disconnect();
}

main().catch(async (cause: unknown) => {
  if (cause instanceof errors.PharmaxError) {
    process.stderr.write(`\n[${cause.code}] ${cause.message}\n`);
  } else {
    process.stderr.write(
      `\n${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}\n`
    );
  }
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
