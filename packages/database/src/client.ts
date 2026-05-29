// Singleton PrismaClient. Server-only.
//
// This module exposes the RAW, UNSCOPED Prisma client as
// `systemPrisma`. It performs NO tenancy enforcement: a query issued
// through it sees every organization's rows. It exists for the narrow
// set of callers that legitimately operate across tenants:
//
//   - migrations / seed / bootstrap scripts
//   - the command bus's pre-tx command_log + idempotency writes run
//     under an explicit tenancy frame (see scoped-client.ts note)
//   - supervisor drains that resolve a tenant from a webhook BEFORE
//     entering that org's tenancy context (they wrap their work in
//     `withSystemContext`)
//
// APPLICATION CODE MUST NOT IMPORT `systemPrisma`. Import the tenancy-
// enforced `prisma` from the package root instead (see
// `scoped-client.ts`). The `@pharmax/database` ESLint boundary + the
// `check:command-files` guard flag raw-client use outside the
// approved system directories.
//
// The cached `globalThis` reference avoids spawning a new client on
// each hot-module reload during `next dev`, which would otherwise
// exhaust Postgres connections in a few seconds.

import process from "node:process";

import { PrismaClient } from "./generated/client/index.js";

type GlobalWithPrisma = typeof globalThis & {
  __pharmaxPrisma?: PrismaClient;
};

const globalForPrisma = globalThis as GlobalWithPrisma;

const isProduction = process.env["NODE_ENV"] === "production";

/**
 * The raw, UNSCOPED Prisma client. Does NOT enforce tenant isolation.
 * Use ONLY in explicitly cross-tenant system/bootstrap code. Most
 * code wants the tenancy-enforced `prisma` export from the package
 * root instead.
 */
export const systemPrisma: PrismaClient =
  globalForPrisma.__pharmaxPrisma ??
  new PrismaClient({
    log: isProduction ? ["error"] : ["warn", "error"],
  });

if (!isProduction) {
  globalForPrisma.__pharmaxPrisma = systemPrisma;
}
