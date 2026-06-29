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

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "./generated/client/client.js";

type GlobalWithPrisma = typeof globalThis & {
  __pharmaxPrisma?: PrismaClient;
};

const globalForPrisma = globalThis as GlobalWithPrisma;

const isProduction = process.env["NODE_ENV"] === "production";

// Prisma 7 is Rust-engine-free: the client connects through a driver
// adapter built on `pg`. The pool is created lazily (no connection is
// opened until the first query), so importing this module never
// connects — the same lazy behavior the v6 client had.
//
// Connection-pool note: unlike the v6 Rust engine, `pg` has NO
// connection timeout by default. We restore the v6 5s timeout so a
// saturated/unreachable database fails fast instead of hanging a
// request indefinitely. Pool sizing follows the `pg` default (max 10);
// tune via the deployment's pool config if needed. Prisma-specific
// URL params (`connection_limit`, `pgbouncer`) are ignored by `pg`;
// the libpq `options=-c role=...` param IS honored.
/**
 * TLS options for the `pg` driver adapter.
 *
 * Production RDS/Aurora enforces TLS (`rds.force_ssl = 1`) and rejects
 * plaintext connections (`28000 … no encryption`). `pg` does NOT enable
 * TLS by default and the connection-string secrets carry no `sslmode`,
 * so we configure it here and VERIFY the server certificate against the
 * bundled AWS RDS global CA (`certs/rds-global-bundle.pem`) —
 * encryption WITH authentication, not `rejectUnauthorized:false`.
 *
 * Local dev / CI connect to a localhost Postgres with no TLS, so SSL is
 * disabled outside production (keyed on NODE_ENV, same as the client
 * caching above).
 */
export function buildPgSslOptions(): false | { ca: string; rejectUnauthorized: boolean } {
  if (!isProduction) return false;
  const caPath = join(dirname(fileURLToPath(import.meta.url)), "certs", "rds-global-bundle.pem");
  return { ca: readFileSync(caPath, "utf8"), rejectUnauthorized: true };
}

function buildSystemAdapter(): PrismaPg {
  return new PrismaPg({
    connectionString: process.env["DATABASE_URL"],
    connectionTimeoutMillis: 5_000,
    ssl: buildPgSslOptions(),
  });
}

/**
 * The raw, UNSCOPED Prisma client. Does NOT enforce tenant isolation.
 * Use ONLY in explicitly cross-tenant system/bootstrap code. Most
 * code wants the tenancy-enforced `prisma` export from the package
 * root instead.
 */
export const systemPrisma: PrismaClient =
  globalForPrisma.__pharmaxPrisma ??
  new PrismaClient({
    adapter: buildSystemAdapter(),
    log: isProduction ? ["error"] : ["warn", "error"],
  });

if (!isProduction) {
  globalForPrisma.__pharmaxPrisma = systemPrisma;
}
