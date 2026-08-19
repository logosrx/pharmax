// A Prisma client connected as `pharmax_system`, for tests that
// exercise system-role write paths.
//
// ## Why this exists
//
// `setup-env.ts` pins the shared `prisma` client to `pharmax_app`, which
// is the posture every command dispatch must be tested under. But some
// production code paths never run as the app role: RxNorm ingestion
// (`scripts/operations/ingest-rxnorm-release.ts`) writes the global
// drug-knowledge tables, and the migration deliberately REVOKES
// INSERT/UPDATE/DELETE on them from `pharmax_app` — poisoning the
// reference data every tenant screens against is a patient-safety
// attack, so only `pharmax_system` may write it.
//
// Before the role pinning, the rxnorm tests wrote those tables through
// a superuser connection, which proved nothing about the grants. This
// client makes the tests run ingestion under the exact role production
// grants it, so a migration that accidentally revokes the system
// role's write set fails here instead of in the ingestion job.
//
// NOT the raw `systemPrisma` export from `@pharmax/database` — that
// import is banned by check:raw-prisma, and it would inherit the
// app-role pinning from DATABASE_URL anyway. This is a separate client
// on the un-pinned owner URL with its own role parameter.

import { PrismaClient } from "@pharmax/database";
import { PrismaPg } from "@prisma/adapter-pg";

import { pinSessionRole } from "./db-url.js";

let client: PrismaClient | undefined;

/** Lazy singleton so suites that never touch system tables pay nothing. */
export function systemDb(): PrismaClient {
  if (client !== undefined) return client;
  const base = process.env["INTEGRATION_OWNER_DATABASE_URL"];
  if (base === undefined || base === "") {
    throw new Error(
      "system-prisma: INTEGRATION_OWNER_DATABASE_URL is unset. `support/setup-env.ts` should have " +
        "preserved it; check setupFiles in packages/integration-tests/vitest.config.ts."
    );
  }
  client = new PrismaClient({
    adapter: new PrismaPg({ connectionString: pinSessionRole(base, "pharmax_system") }),
  });
  return client;
}

/** Disconnect the singleton, if it was ever created. Safe to call twice. */
export async function disconnectSystemDb(): Promise<void> {
  if (client === undefined) return;
  const c = client;
  client = undefined;
  await c.$disconnect().catch(() => undefined);
}
