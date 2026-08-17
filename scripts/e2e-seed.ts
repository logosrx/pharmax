// Seed the synthetic E2E operator credentials + intake fixtures
// (Playwright suite: operator smoke + full-dispense golden path).
//
// Same category as prisma/seed.ts and scripts/bootstrap-org.ts: a
// system-bootstrap operator CLI that provisions identity fixtures
// OUTSIDE the request path. It runs against the throwaway
// `pharmax_e2e` database only (see e2e/setup.ts) — never against a
// shared environment.
//
// What it creates, idempotently, on top of the standard demo seed:
//
//   - Five ACTIVE operators in the demo org, each with a real
//     Argon2id password hash produced by the SAME hasher factory
//     apps/web boots with (createArgon2idHasher, no pepper — matching
//     an e2e web server started without AUTH_PASSWORD_PEPPER), so
//     sign-in exercises the production verify path, not a shortcut:
//
//       e2e-pharmacist@acme.test    Pharmacist          (PV1)
//       e2e-tech@acme.test          PharmacyTechnician  (typing + fill)
//       e2e-tech-2@acme.test        PharmacyTechnician  (patient-search test only)
//       e2e-pharmacist-2@acme.test  Pharmacist          (final verification)
//       e2e-shipping@acme.test      ShippingClerk       (ship release/confirm)
//
//     Four hands because the Separation-of-Duties registry is
//     real: typing-complete forbids PV1-approve by the same actor,
//     and PV1-approve / fill-complete each forbid final-approve by
//     the same actor. Every grant is org-wide (siteId/clinicId/teamId
//     null) — a site-scoped grant would never match the site-less web
//     session. All four roles sit BELOW the platform MFA floor, so
//     the suite completes password-only sign-ins without weakening or
//     bypassing the MFA policy for privileged roles.
//
//   - One synthetic patient, registered through the REAL
//     RegisterPatient command (encrypt + blind index + audit) as the
//     tech operator, so the transcription page's PHI-safe search can
//     find them. Idempotent via the same lastName/firstName blind
//     indexes the search uses.
//
//   - One synthetic ACTIVE provider (direct row, upsert by NPI). A
//     deliberate command bypass with the same rationale as
//     scripts/seed-demo-orders.ts: provider onboarding is a
//     multi-step production flow that would spend real command-log /
//     audit series on a disposable fixture.
//
//   - One partner API key minted through the REAL CreateApiKey
//     command (as the seeded OrgAdmin owner — a bootstrap actor
//     choice, not a web sign-in; the MFA floor governs sessions, not
//     the command bus). The raw token is the fixed constant in
//     e2e/env.ts; only its SHA-256 hash is stored. Scopes:
//     orders.create + orders.read — the spec creates orders through
//     POST /api/v1/orders, the production intake surface, because no
//     ops-console UI exists for order creation.
//
//   - e2e/.e2e-state.json with the tenant ids the specs need.
//
// It also clears the durable login-attempt ledger for every seeded
// email on each run. The `pharmax_e2e` database is reused across
// local runs; the wrong-password smoke writes INVALID_CREDENTIALS
// rows, so without a reset the ledger accumulates toward the
// distributed lockout threshold (packages/auth login-attempt.ts: 10
// failures per email in 15 minutes) and later authenticated smokes
// fail as if the password were wrong.
//
// Synthetic data only. The passwords and API token live in e2e/env.ts
// and are not secrets: they authenticate nothing outside the
// throwaway local database.

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import process from "node:process";

import { createArgon2idHasher } from "@pharmax/auth";
import { configureCommandBus, executeCommand } from "@pharmax/command-bus";
import { configureCrypto, LocalKmsAdapter } from "@pharmax/crypto";
import { prisma, ProviderStatus, UserStatus } from "@pharmax/database";
import { CreateApiKey, hashApiKeyToken } from "@pharmax/partner-api";
import { PATIENT_BLIND_INDEX, RegisterPatient } from "@pharmax/patients";
import { clock, logger as loggerNs } from "@pharmax/platform-core";
import { configureRbac, PERMISSIONS, PrismaPermissionLoader } from "@pharmax/rbac";
import { buildTenancyContext, withSystemContext, withTenancyContext } from "@pharmax/tenancy";

import {
  E2E_API_KEY_TOKEN,
  E2E_KMS_SEED,
  E2E_OPERATOR_EMAIL,
  E2E_OPERATOR_PASSWORD,
  E2E_PHARMACIST2_EMAIL,
  E2E_PHARMACIST2_PASSWORD,
  E2E_SHIPPING_EMAIL,
  E2E_SHIPPING_PASSWORD,
  E2E_STATE_FILE,
  E2E_TECH2_EMAIL,
  E2E_TECH2_PASSWORD,
  E2E_TECH_EMAIL,
  E2E_TECH_PASSWORD,
  type E2ESeedState,
} from "../e2e/env";

// Obviously-synthetic patient identity (no real patient data — ever).
// The lastName is what the transcription page's blind-index search
// keys on, so it must be distinctive within the e2e org.
const E2E_PATIENT = {
  firstName: "Goldie",
  lastName: "E2efixture",
  dateOfBirth: "1990-01-15",
  phone: "5550109001",
  addressLine1: "9 Synthetic Way",
  city: "Testville",
  state: "NY",
  postalCode: "10001",
} as const;

const E2E_PROVIDER_NPI = "1999999991";

interface OperatorSpec {
  readonly email: string;
  readonly password: string;
  readonly displayName: string;
  readonly roleCode: string;
}

const OPERATORS: ReadonlyArray<OperatorSpec> = [
  {
    email: process.env["E2E_OPERATOR_EMAIL"] ?? E2E_OPERATOR_EMAIL,
    password: process.env["E2E_OPERATOR_PASSWORD"] ?? E2E_OPERATOR_PASSWORD,
    displayName: "E2E Pharmacist (DEMO)",
    roleCode: "Pharmacist",
  },
  {
    email: E2E_TECH_EMAIL,
    password: E2E_TECH_PASSWORD,
    displayName: "E2E Tech (DEMO)",
    roleCode: "PharmacyTechnician",
  },
  {
    email: E2E_TECH2_EMAIL,
    password: E2E_TECH2_PASSWORD,
    displayName: "E2E Tech Two (DEMO)",
    roleCode: "PharmacyTechnician",
  },
  {
    email: E2E_PHARMACIST2_EMAIL,
    password: E2E_PHARMACIST2_PASSWORD,
    displayName: "E2E Pharmacist Two (DEMO)",
    roleCode: "Pharmacist",
  },
  {
    email: E2E_SHIPPING_EMAIL,
    password: E2E_SHIPPING_PASSWORD,
    displayName: "E2E Shipping Clerk (DEMO)",
    roleCode: "ShippingClerk",
  },
];

async function seedOperator(
  organizationId: string,
  spec: OperatorSpec,
  hashedPassword: string
): Promise<string> {
  const user = await prisma.user.upsert({
    where: { organizationId_email: { organizationId, email: spec.email } },
    update: { hashedPassword, status: UserStatus.ACTIVE },
    create: {
      organizationId,
      email: spec.email,
      displayName: spec.displayName,
      status: UserStatus.ACTIVE,
      hashedPassword,
    },
  });

  // Org-wide role grant, same shape as prisma/seed.ts uses for its
  // demo operators. UserRole's composite unique includes nullable
  // scope columns, so upsert can't address it; findFirst + create.
  const role = await prisma.role.findUniqueOrThrow({
    where: { organizationId_code: { organizationId, code: spec.roleCode } },
  });
  const existingGrant = await prisma.userRole.findFirst({
    where: { userId: user.id, roleId: role.id, siteId: null, clinicId: null, teamId: null },
  });
  if (existingGrant === null) {
    await prisma.userRole.create({
      data: { userId: user.id, roleId: role.id, organizationId },
    });
  }

  // Drop any site-scoped grant an earlier revision created: it never
  // matches the site-less web session and only muddies "which grant
  // made this pass" when debugging.
  await prisma.userRole.deleteMany({
    where: { userId: user.id, roleId: role.id, siteId: { not: null } },
  });

  // Clear the durable login-attempt ledger for this synthetic email
  // (see the header). Lowercased to match how recordLoginAttempt
  // normalizes emailAttempted before writing.
  await prisma.loginAttempt.deleteMany({ where: { emailAttempted: spec.email.toLowerCase() } });

  return user.id;
}

async function main(): Promise<void> {
  const kmsSeed = process.env["PHARMAX_LOCAL_KMS_SEED"] ?? E2E_KMS_SEED;

  const logger = loggerNs.createPinoLogger({ service: "e2e-seed", level: "warn" });
  configureCrypto({ kms: new LocalKmsAdapter({ seed: kmsSeed }) });
  configureRbac({ loader: new PrismaPermissionLoader(prisma) });
  configureCommandBus({ prisma, clock: clock.systemClock, logger });

  // Hash BEFORE entering the system context — pure CPU work.
  const hasher = createArgon2idHasher({ pepper: null });
  const hashes = await Promise.all(OPERATORS.map((o) => hasher.hash(o.password)));

  const bootstrap = await withSystemContext("scripts:e2e-seed", async () => {
    const org = await prisma.organization.findUnique({ where: { slug: "acme" } });
    if (org === null) {
      throw new Error("Demo org 'acme' not found. Run `pnpm db:seed` first (see e2e/setup.ts).");
    }
    const clinic = await prisma.clinic.findFirst({ where: { organizationId: org.id } });
    const site = await prisma.pharmacySite.findFirst({ where: { organizationId: org.id } });
    const owner = await prisma.user.findUnique({
      where: { organizationId_email: { organizationId: org.id, email: "owner@acme.test" } },
    });
    if (clinic === null || site === null || owner === null) {
      throw new Error("Demo clinic/site/owner missing. Run `pnpm db:seed` first.");
    }

    const userIds: string[] = [];
    for (let i = 0; i < OPERATORS.length; i++) {
      userIds.push(await seedOperator(org.id, OPERATORS[i]!, hashes[i]!));
      console.log(`✓ E2E operator ready: ${OPERATORS[i]!.email} (${OPERATORS[i]!.roleCode})`);
    }

    // Synthetic ACTIVE provider — direct upsert by NPI (deliberate
    // command bypass, see the header).
    let provider = await prisma.provider.findFirst({
      where: { organizationId: org.id, npi: E2E_PROVIDER_NPI },
    });
    provider ??= await prisma.provider.create({
      data: {
        organizationId: org.id,
        npi: E2E_PROVIDER_NPI,
        firstName: "E2E",
        lastName: "Prescriber (DEMO)",
        credential: "MD",
        status: ProviderStatus.ACTIVE,
      },
    });

    // Idempotent patient existence check via the SAME blind indexes
    // RegisterPatient writes and the patient search queries.
    const [lastNameBi, firstNameBi] = await Promise.all([
      PATIENT_BLIND_INDEX.lastName({ tenantId: org.id, value: E2E_PATIENT.lastName }),
      PATIENT_BLIND_INDEX.firstName({ tenantId: org.id, value: E2E_PATIENT.firstName }),
    ]);
    if (lastNameBi === null || firstNameBi === null) {
      throw new Error("Patient blind index resolved null — crypto misconfiguration.");
    }
    const existingPatient = await prisma.patient.findFirst({
      where: { organizationId: org.id, clinicId: clinic.id, lastNameBi, firstNameBi },
      select: { id: true },
    });

    // Idempotent API key check by token hash (unique).
    const tokenHash = hashApiKeyToken(E2E_API_KEY_TOKEN);
    const existingKey = await prisma.apiKey.findUnique({
      where: { tokenHash },
      select: { id: true },
    });

    return {
      organizationId: org.id,
      clinicId: clinic.id,
      siteId: site.id,
      ownerUserId: owner.id,
      techUserId: userIds[1]!,
      providerId: provider.id,
      existingPatientId: existingPatient?.id ?? null,
      apiKeyExists: existingKey !== null,
      tokenHash,
    };
  });

  // ---- Patient: REAL RegisterPatient command as the tech operator ----
  let patientId = bootstrap.existingPatientId;
  if (patientId === null) {
    const techCtx = buildTenancyContext({
      organizationId: bootstrap.organizationId,
      siteId: bootstrap.siteId,
      clinicId: bootstrap.clinicId,
      actor: { userId: bootstrap.techUserId, correlationId: randomUUID() },
    });
    const result = await withTenancyContext(techCtx, () =>
      executeCommand(
        RegisterPatient,
        { clinicId: bootstrap.clinicId, ...E2E_PATIENT },
        { idempotencyKey: `e2e-seed:register-patient:${randomUUID()}` }
      )
    );
    patientId = result.patientId;
    console.log(`✓ E2E patient registered: ${E2E_PATIENT.lastName} (${patientId})`);
  } else {
    console.log(`✓ E2E patient already present (${patientId})`);
  }

  // ---- API key: REAL CreateApiKey command as the seeded OrgAdmin ----
  if (!bootstrap.apiKeyExists) {
    const ownerCtx = buildTenancyContext({
      organizationId: bootstrap.organizationId,
      actor: { userId: bootstrap.ownerUserId, correlationId: randomUUID() },
    });
    await withTenancyContext(ownerCtx, () =>
      executeCommand(
        CreateApiKey,
        {
          name: "E2E full-dispense intake (DEMO)",
          tokenHash: bootstrap.tokenHash,
          tokenPrefix: E2E_API_KEY_TOKEN.slice(0, 8),
          scopes: [PERMISSIONS.ORDERS_CREATE, PERMISSIONS.ORDERS_READ],
        },
        { idempotencyKey: `e2e-seed:create-api-key:${randomUUID()}` }
      )
    );
    console.log("✓ E2E partner API key minted (orders.create, orders.read)");
  } else {
    console.log("✓ E2E partner API key already present");
  }

  const state: E2ESeedState = {
    organizationId: bootstrap.organizationId,
    clinicId: bootstrap.clinicId,
    siteId: bootstrap.siteId,
    patientId,
    patientLastName: E2E_PATIENT.lastName,
    providerId: bootstrap.providerId,
  };
  writeFileSync(E2E_STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
  console.log(`✓ E2E state written: ${E2E_STATE_FILE}`);
}

main()
  .then(() => process.exit(0))
  .catch((cause: unknown) => {
    console.error("e2e-seed failed:", cause);
    process.exit(1);
  });
