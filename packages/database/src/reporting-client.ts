// Reporting read client + tenant-scoped read scope.
//
// Heavy analytical reports (productivity, SLA breach, rejection
// rate) scan history tables. Running those scans inside the OLTP
// primary's write path competes with live workflow transactions
// for connections + buffer cache. This module routes report reads
// to a dedicated REPLICA connection when one is configured, while
// the report's audit trail (`report_run` + audit_log +
// event_outbox) stays on the primary command transaction.
//
// Resolution:
//   - `REPORTING_DATABASE_URL` set  → a second PrismaClient pointed
//     at that URL (typically a read replica), wrapped in the SAME
//     tenancy extension as the primary `prisma` so ORM-layer org
//     scoping applies identically.
//   - unset                         → falls back to the primary
//     `prisma`. Reports still run correctly; they just read from
//     the primary (current behavior). No replica == no regression.
//
// The read scope mirrors `readInTenantContext`: it opens a
// (read-shaped) transaction on the reporting client and sets the
// RLS session GUC so Postgres ALSO enforces `organizationId =
// <tenant>` — same dual-layer (ORM + RLS) guarantee reads get on
// the primary. On a physical replica a read-only tx + `SET LOCAL`
// is fully supported.
//
// HMR / connection-pool note: like `client.ts` + `scoped-client.ts`,
// the replica client is cached on `globalThis` so `next dev`
// re-imports don't spawn a new pool each time.

import process from "node:process";

import { PrismaPg } from "@prisma/adapter-pg";
import {
  applyTenancyExtension,
  applyTenancySessionGuc,
  withTenancyContext,
  type SessionGucExecutor,
} from "@pharmax/tenancy";

import { buildPgSslOptions } from "./client.js";
import { PrismaClient } from "./generated/client/client.js";
import { prisma } from "./scoped-client.js";
import { buildReadScopeContext, type TenantTransactionClient } from "./scoped-read.js";

type GlobalWithReportingPrisma = typeof globalThis & {
  __pharmaxReportingPrisma?: PrismaClient;
};

const globalForReportingPrisma = globalThis as GlobalWithReportingPrisma;

const isProduction = process.env["NODE_ENV"] === "production";
const reportingUrl = process.env["REPORTING_DATABASE_URL"];

function buildReplicaClient(url: string): PrismaClient {
  // Prisma 7: point a dedicated `pg` driver adapter at the replica URL
  // (the v6 `datasourceUrl` override no longer exists — connections are
  // owned by the adapter, not a schema datasource block). Same 5s
  // connection timeout as the primary client (see `client.ts`).
  const adapter = new PrismaPg({
    connectionString: url,
    connectionTimeoutMillis: 5_000,
    ssl: buildPgSslOptions(),
  });
  const raw = new PrismaClient({
    adapter,
    log: isProduction ? ["error"] : ["warn", "error"],
  });
  return applyTenancyExtension(raw);
}

/**
 * The client report reads run against. A replica when
 * `REPORTING_DATABASE_URL` is configured; otherwise the primary
 * tenancy-enforced `prisma`. Tenant-scoped models are auto-filtered
 * at the ORM layer regardless of which underlying connection.
 */
export const reportingPrisma: PrismaClient =
  typeof reportingUrl === "string" && reportingUrl.length > 0
    ? (globalForReportingPrisma.__pharmaxReportingPrisma ?? buildReplicaClient(reportingUrl))
    : prisma;

if (!isProduction && reportingPrisma !== prisma) {
  globalForReportingPrisma.__pharmaxReportingPrisma = reportingPrisma;
}

/**
 * True when a dedicated reporting replica is configured (i.e.
 * `reportingPrisma` is NOT the primary client). Boot code logs
 * this so operators can confirm report reads are offloaded.
 */
export const reportingClientIsReplica: boolean = reportingPrisma !== prisma;

/**
 * Run `fn` against the reporting client inside a tenant-scoped
 * read transaction (ALS tenancy frame + RLS session GUC). Mirrors
 * `readInOrgScope` but on the reporting connection.
 *
 * Queries inside `fn` MUST use the provided `tx`. Keep `fn` free
 * of slow non-DB work — it holds a (replica) connection open.
 */
export function readReportingInOrgScope<T>(
  organizationId: string,
  fn: (tx: TenantTransactionClient) => Promise<T>
): Promise<T> {
  const ctx = buildReadScopeContext(organizationId);
  return withTenancyContext(ctx, () =>
    reportingPrisma.$transaction(async (tx) => {
      await applyTenancySessionGuc(tx as unknown as SessionGucExecutor, ctx);
      return fn(tx as unknown as TenantTransactionClient);
    })
  );
}
