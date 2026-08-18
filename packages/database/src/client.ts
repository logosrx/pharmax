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
// request indefinitely. Prisma-specific URL params
// (`connection_limit`, `pgbouncer`) are ignored by `pg`; the libpq
// `options=-c role=...` param IS honored.
//
// Pool sizing used to read "follows the `pg` default (max 10); tune via
// the deployment's pool config if needed" — but there is no deployment
// pool config, and the sentence above explains why `connection_limit`
// in the URL cannot be it. So the default was the setting, in every
// environment including production, by omission rather than decision.
//
// That surfaced on 2026-08-17 as an E2E failure that read like flake:
//
//   Transaction API error: Unable to start a transaction in the given time.
//
// The arithmetic behind it is worth keeping. A single command request
// opens transactions serially in `resolve-org-from-host`,
// `resolve-tenancy`, the session service, and then three more in the
// command bus (pre-flight, handler, status update) — each taking a
// pooled connection for its duration. Against a pool of 10 that leaves
// very little headroom, and on a slow runner the requests overlap
// enough to exhaust it.
//
// `POOL_ACQUIRE_TIMEOUT_MS` is also a **ceiling on Prisma's `maxWait`**,
// which is the other half of the same 2026-08-17 incident: the command
// bus raised `maxWait` to 30s and nothing changed, because `pg` gives
// up acquiring a connection at 5s and Prisma reports that as "unable to
// start a transaction". Two timeouts govern one wait and the smaller
// always wins. Raise them together or not at all — see
// `assertTransactionWaitWithinPoolTimeout`.
//
// Both values keep their historical defaults so this stays a no-op
// until someone sets the variables. Sizing them honestly needs load
// measurement (Workstream D2), which has not run.
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
 *
 * NOTE: keying transport security on a bundling flag is why the E2E
 * suite cannot run a production build — `next build` inlines
 * `NODE_ENV=production`, so a prod bundle demands RDS TLS against a
 * plaintext docker Postgres. Decoupling it is a real follow-up, but it
 * is not sufficient on its own: `bootstrap.ts` also keys the KMS
 * adapter, object storage and Sentry wiring on the same flag, and the
 * production-refuses-LocalKmsAdapter check is a control worth keeping.
 * Doing this properly means giving the composition root an explicit
 * profile rather than loosening each guard, which is its own change.
 */
export function buildPgSslOptions(): false | { ca: string; rejectUnauthorized: boolean } {
  if (!isProduction) return false;
  const caPath = join(dirname(fileURLToPath(import.meta.url)), "certs", "rds-global-bundle.pem");
  return { ca: readFileSync(caPath, "utf8"), rejectUnauthorized: true };
}

/** `pg`'s own default pool size, restated so it is a choice, not an accident. */
export const DEFAULT_POOL_MAX = 10;

/** The v6 Rust-engine acquisition timeout, preserved. */
export const DEFAULT_POOL_ACQUIRE_TIMEOUT_MS = 5_000;

/**
 * Pool settings, read from the environment with the historical values
 * as defaults.
 *
 * Deliberately not keyed on `NODE_ENV`: that coupling is already why
 * `buildPgSslOptions` cannot be exercised by the E2E suite, and
 * repeating it for pool sizing would make the pool untestable in the
 * one harness that drives real concurrency.
 */
export function resolvePoolSettings(env: Record<string, string | undefined> = process.env): {
  max: number;
  connectionTimeoutMillis: number;
} {
  return {
    max: positiveIntOr(env["DATABASE_POOL_MAX"], DEFAULT_POOL_MAX),
    connectionTimeoutMillis: positiveIntOr(
      env["DATABASE_POOL_ACQUIRE_TIMEOUT_MS"],
      DEFAULT_POOL_ACQUIRE_TIMEOUT_MS
    ),
  };
}

/**
 * Fail fast when a command-bus `maxWait` is configured above the pool's
 * acquisition timeout, because the larger value is silently unreachable.
 *
 * Returns the offending pair rather than throwing, so a composition root
 * can decide between refusing to boot and logging loudly. Both are
 * defensible; picking for the caller is not.
 */
export function assertTransactionWaitWithinPoolTimeout(
  maxWaitMs: number,
  connectionTimeoutMillis: number
): { ok: true } | { ok: false; maxWaitMs: number; connectionTimeoutMillis: number } {
  if (maxWaitMs <= connectionTimeoutMillis) return { ok: true };
  return { ok: false, maxWaitMs, connectionTimeoutMillis };
}

function positiveIntOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function buildSystemAdapter(): PrismaPg {
  const pool = resolvePoolSettings();
  return new PrismaPg({
    connectionString: process.env["DATABASE_URL"],
    max: pool.max,
    connectionTimeoutMillis: pool.connectionTimeoutMillis,
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
