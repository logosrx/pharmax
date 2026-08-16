// Seed the synthetic E2E operator credential (Playwright smoke suite).
//
// Same category as prisma/seed.ts and scripts/bootstrap-org.ts: a
// system-bootstrap operator CLI that provisions identity fixtures
// OUTSIDE the request path. It runs against the throwaway
// `pharmax_e2e` database only (see e2e/setup.ts) — never against a
// shared environment.
//
// What it creates, idempotently, on top of the standard demo seed:
//   - An ACTIVE user `e2e-pharmacist@acme.test` in the demo org with a
//     real Argon2id password hash. The hash is produced by the SAME
//     hasher factory apps/web boots with (createArgon2idHasher), with
//     no pepper — matching an e2e web server started without
//     AUTH_PASSWORD_PEPPER — so sign-in exercises the production
//     verify path, not a shortcut.
//   - An org-wide `Pharmacist` role grant (siteId/clinicId/teamId all
//     null), matching how prisma/seed.ts grants its demo operators.
//     A site-scoped grant would never take effect here: the web
//     session's tenancy context carries no siteId, and scope matching
//     (packages/rbac grants.ts) requires the context to sit inside the
//     grant scope. Deliberately NOT OrgAdmin: the Pharmacist role is
//     below the platform MFA floor, so the suite can complete a
//     password-only sign-in without weakening or bypassing the MFA
//     policy for privileged roles.
//
// Synthetic data only. The password constant lives in e2e/env.ts and
// is not a secret: it authenticates nothing outside the throwaway
// local database.

import process from "node:process";

import { createArgon2idHasher } from "@pharmax/auth";
import { prisma, UserStatus } from "@pharmax/database";
import { withSystemContext } from "@pharmax/tenancy";

import { E2E_OPERATOR_EMAIL, E2E_OPERATOR_PASSWORD } from "../e2e/env";

const email = process.env["E2E_OPERATOR_EMAIL"] ?? E2E_OPERATOR_EMAIL;
const password = process.env["E2E_OPERATOR_PASSWORD"] ?? E2E_OPERATOR_PASSWORD;

async function main(): Promise<void> {
  // Hash BEFORE entering the system context — pure CPU work.
  const hasher = createArgon2idHasher({ pepper: null });
  const hashedPassword = await hasher.hash(password);

  await withSystemContext("scripts:e2e-seed", async () => {
    const org = await prisma.organization.findUnique({ where: { slug: "acme" } });
    if (org === null) {
      throw new Error("Demo org 'acme' not found. Run `pnpm db:seed` first (see e2e/setup.ts).");
    }

    const user = await prisma.user.upsert({
      where: { organizationId_email: { organizationId: org.id, email } },
      update: { hashedPassword, status: UserStatus.ACTIVE },
      create: {
        organizationId: org.id,
        email,
        displayName: "E2E Pharmacist (DEMO)",
        status: UserStatus.ACTIVE,
        hashedPassword,
      },
    });

    // Org-wide Pharmacist grant, same shape as prisma/seed.ts uses for
    // its demo operators. UserRole's composite unique includes nullable
    // scope columns, so upsert can't address it; findFirst + create.
    const role = await prisma.role.findUniqueOrThrow({
      where: { organizationId_code: { organizationId: org.id, code: "Pharmacist" } },
    });
    const existingGrant = await prisma.userRole.findFirst({
      where: { userId: user.id, roleId: role.id, siteId: null, clinicId: null, teamId: null },
    });
    if (existingGrant === null) {
      await prisma.userRole.create({
        data: {
          userId: user.id,
          roleId: role.id,
          organizationId: org.id,
        },
      });
    }

    // Drop the site-scoped grant an earlier revision of this script
    // created: it never matches the site-less web session and only
    // muddies "which grant made this pass" when debugging.
    await prisma.userRole.deleteMany({
      where: { userId: user.id, roleId: role.id, siteId: { not: null } },
    });

    // Clear the durable login-attempt ledger for this synthetic email.
    // The `pharmax_e2e` database is reused across local runs; the
    // wrong-password smoke writes INVALID_CREDENTIALS rows against this
    // same email, so without a reset the ledger accumulates toward the
    // distributed lockout threshold (packages/auth login-attempt.ts:
    // 10 failures per email in 15 minutes) and later authenticated
    // smokes fail as if the password were wrong. Lowercased to match
    // how recordLoginAttempt normalizes emailAttempted before writing.
    await prisma.loginAttempt.deleteMany({ where: { emailAttempted: email.toLowerCase() } });

    console.log(`✓ E2E operator ready: ${email} (Pharmacist, org-wide)`);
  });
}

main()
  .then(() => process.exit(0))
  .catch((cause: unknown) => {
    console.error("e2e-seed failed:", cause);
    process.exit(1);
  });
