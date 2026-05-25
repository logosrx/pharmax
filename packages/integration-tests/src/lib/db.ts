// DB connection harness for integration tests.
//
// We use `pg` directly rather than the Prisma client so the tests
// have:
//   - Explicit control over `SET LOCAL ROLE` (Prisma's pooled
//     connection model doesn't honor mid-query role switches
//     reliably).
//   - Direct visibility into the SQL the test issues, including
//     the exact error code on policy / constraint violations.
//   - The ability to run two concurrent connections to test row
//     locking, advisory locks, and audit-chain serialization
//     without fighting Prisma's connection pool.
//
// Each `connect()` call opens a NEW connection. Callers are
// responsible for calling `client.end()` in a `try/finally` or
// `afterEach`. The `withClient(fn)` helper does this for you.

import { Client, type ClientConfig } from "pg";

/** Which Postgres role to assume for the connection. */
export type DbRole =
  // Connect as the configured user (typically `postgres`, a
  // superuser, automatically BYPASSRLS). Used for setup, seeding,
  // and any test that needs to write across tenants.
  | "owner"
  // Connect AS postgres, then `SET ROLE pharmax_app` immediately.
  // Subject to RLS — exactly the runtime application role.
  | "app"
  // Connect AS postgres, then `SET ROLE pharmax_system`. BYPASSRLS
  // but still subject to audit_log REVOKE UPDATE, DELETE. Used to
  // test the system-context path (CreateOrganization, etc.).
  | "system";

function resolveDatabaseUrl(): string {
  const intg = process.env["INTEGRATION_DATABASE_URL"];
  if (typeof intg === "string" && intg.length > 0) return intg;
  const dev = process.env["DATABASE_URL"];
  if (typeof dev === "string" && dev.length > 0) return dev;
  throw new Error(
    "No INTEGRATION_DATABASE_URL or DATABASE_URL set. Start docker-compose postgres (`pnpm db:up`), set DATABASE_URL, and re-run."
  );
}

function buildClientConfig(): ClientConfig {
  return {
    connectionString: resolveDatabaseUrl(),
    application_name: "pharmax-integration-tests",
    // Fail fast if the DB is unreachable rather than hanging the
    // suite startup.
    statement_timeout: 15_000,
    query_timeout: 15_000,
  };
}

/**
 * Open a fresh connection and put it into the requested role.
 * Caller MUST `await client.end()` (or use `withClient`).
 */
export async function connect(role: DbRole = "owner"): Promise<Client> {
  const client = new Client(buildClientConfig());
  await client.connect();
  if (role === "app") {
    await client.query(`SET ROLE pharmax_app`);
  } else if (role === "system") {
    await client.query(`SET ROLE pharmax_system`);
  }
  return client;
}

/**
 * Open a connection, run `fn`, close the connection. Use this
 * for one-shot tests that don't need concurrent connections.
 */
export async function withClient<T>(role: DbRole, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = await connect(role);
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Set the per-session tenancy GUC. Mirrors what the production
 * Prisma extension does at transaction start (see
 * `@pharmax/tenancy/prisma-extension.ts`).
 *
 * Note: `SET LOCAL` only takes effect inside a transaction. Use
 * the non-LOCAL variant outside of explicit txs so the setting
 * persists for the connection lifetime — that matches how a
 * pooled app connection behaves in practice.
 */
export async function setTenantContext(client: Client, organizationId: string): Promise<void> {
  await client.query(`SELECT set_config('pharmax.organization_id', $1, false)`, [organizationId]);
  // Make sure the system-context flag is OFF so the RLS policy
  // actually evaluates the tenant predicate.
  await client.query(`SELECT set_config('pharmax.system_context', '', false)`);
}

/**
 * Set the system-context flag. RLS policies short-circuit to
 * "permit" when this is on; intended for the BYPASSRLS role or
 * for tests that need to set up cross-tenant fixtures.
 */
export async function setSystemContext(client: Client): Promise<void> {
  await client.query(`SELECT set_config('pharmax.system_context', 'on', false)`);
  await client.query(`SELECT set_config('pharmax.organization_id', '', false)`);
}

/**
 * Clear both GUCs. Mirrors what a fresh connection looks like;
 * any RLS-filtered query after this returns zero rows.
 */
export async function clearContext(client: Client): Promise<void> {
  await client.query(`SELECT set_config('pharmax.organization_id', '', false)`);
  await client.query(`SELECT set_config('pharmax.system_context', '', false)`);
}

/**
 * Probe: is the configured Postgres reachable, and does it look
 * like the Pharmax schema (RLS baseline applied, key tables in
 * place)? Throws a clear, actionable error rather than letting
 * each test fail with a noisy connect-refused.
 */
export async function assertSchemaReady(): Promise<void> {
  let client: Client | undefined;
  try {
    client = await connect("owner");
  } catch (cause) {
    const code = (cause as { code?: string }).code;
    if (code === "ECONNREFUSED" || code === "ENOTFOUND") {
      throw new Error(
        `Integration tests cannot connect to Postgres. Start the local DB first:\n` +
          `  pnpm db:up                  # start docker-compose postgres\n` +
          `  pnpm db:migrate:deploy      # apply the schema\n` +
          `Then re-run \`pnpm test:integration\`.\n` +
          `(connection target was ${resolveDatabaseUrl()})`
      );
    }
    throw cause;
  }
  try {
    const roles = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pharmax_app') AS exists`
    );
    if (roles.rows[0]?.exists !== true) {
      throw new Error(
        "Integration test setup: role `pharmax_app` is missing. Run `pnpm db:migrate:deploy` against the integration database first."
      );
    }
    const verification = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'verification_record'
       ) AS exists`
    );
    if (verification.rows[0]?.exists !== true) {
      throw new Error(
        "Integration test setup: table `verification_record` is missing. Run `pnpm db:migrate:deploy` against the integration database first."
      );
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}
