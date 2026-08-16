// E2E database provisioning. Runs BEFORE `playwright test` (see the
// `test:e2e` root script) so the ordering is explicit rather than
// depending on Playwright's globalSetup-vs-webServer sequencing.
//
// Steps, all idempotent:
//   1. Create the throwaway `pharmax_e2e` database if it is missing
//      (requires a reachable Postgres — `pnpm db:up` locally, the
//      service container in CI).
//   2. Apply the committed migration history (prisma migrate deploy).
//   3. Run the standard demo seed (prisma/seed.ts) — org `acme`,
//      roles, buckets, workflow policy.
//   4. Seed the synthetic E2E operator credential
//      (scripts/e2e-seed.ts).
//
// The suite reuses exactly what the integration tests use (the
// docker-compose Postgres + migrate deploy + seed); nothing here
// invents a parallel provisioning path.

/* eslint-disable no-console */

import { execFileSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { E2E_DATABASE_URL, E2E_KMS_SEED, E2E_OPERATOR_EMAIL, E2E_OPERATOR_PASSWORD } from "./env";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const dbEnv: Readonly<Record<string, string>> = Object.freeze({
  DATABASE_URL: E2E_DATABASE_URL,
  DIRECT_URL: E2E_DATABASE_URL,
  PHARMAX_LOCAL_KMS_SEED: E2E_KMS_SEED,
  E2E_OPERATOR_EMAIL,
  E2E_OPERATOR_PASSWORD,
});

function run(args: ReadonlyArray<string>): void {
  console.log(`e2e setup: pnpm ${args.join(" ")}`);
  execFileSync("pnpm", [...args], {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, ...dbEnv },
  });
}

/** Create the e2e database when absent. CREATE DATABASE cannot run in a
 * transaction and has no IF NOT EXISTS, hence the explicit existence
 * check against the `postgres` maintenance database. */
async function ensureDatabase(): Promise<void> {
  const url = new URL(E2E_DATABASE_URL);
  const dbName = url.pathname.replace(/^\//, "");
  if (dbName.length === 0) {
    throw new Error(`E2E_DATABASE_URL has no database name: ${E2E_DATABASE_URL}`);
  }
  const adminUrl = new URL(E2E_DATABASE_URL);
  adminUrl.pathname = "/postgres";

  const client = new pg.Client({ connectionString: adminUrl.toString() });
  try {
    await client.connect();
  } catch (cause) {
    throw new Error(
      `Cannot reach Postgres at ${adminUrl.host}. Start it first (locally: pnpm db:up).`,
      { cause }
    );
  }
  try {
    const existing = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (existing.rowCount === 0) {
      // Identifier, not a value — cannot be parameterized. The name
      // comes from our own constant / CI env, and is quoted defensively.
      await client.query(`CREATE DATABASE "${dbName.replaceAll('"', '""')}"`);
      console.log(`e2e setup: created database ${dbName}`);
    } else {
      console.log(`e2e setup: database ${dbName} already exists`);
    }
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  await ensureDatabase();
  run(["db:migrate:deploy"]);
  run(["db:seed"]);
  run(["tsx", "scripts/e2e-seed.ts"]);
  console.log("✓ E2E database ready");
}

main().catch((cause: unknown) => {
  console.error("E2E setup failed:", cause);
  process.exit(1);
});
