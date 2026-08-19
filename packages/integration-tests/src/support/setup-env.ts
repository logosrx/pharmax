// Vitest `setupFiles` for the integration suite.
//
// ## Why this file has to exist, and why it has to run first
//
// `@pharmax/database` builds its Prisma client at MODULE SCOPE from
// `process.env["DATABASE_URL"]` (see `packages/database/src/client.ts`
// — `systemPrisma` is a `const` initialised on import). By the time a
// test file's import graph is evaluated, the connection string is
// already baked in. So anything that wants to influence how the bus
// talks to Postgres has to happen strictly earlier than the first
// import, which is exactly what `setupFiles` gives us.
//
// ## What it changes, and why it matters more than it looks
//
// Locally and in CI, `DATABASE_URL` points at Postgres as `postgres` —
// a SUPERUSER, which silently **bypasses every RLS policy**. A command
// harness running that way would prove the four-table transaction and
// prove nothing whatsoever about tenant isolation, while looking like
// it proved both. That is a worse outcome than not testing isolation,
// because the green check would be evidence for a claim it never made.
//
// Production does not run as a superuser. It pins the session role with
// the libpq startup parameter (see `.env.example`,
// `infra/terraform/modules/secrets/main.tf`, `docs/RUNBOOK.md`):
//
//     postgresql://…/pharmax?options=-c%20role%3Dpharmax_app
//
// `packages/database/src/client.ts` notes that `pg` honours `options`
// even though it ignores Prisma-specific URL params. So this file
// rewrites the URL into the production shape, and the harness therefore
// exercises the role posture production actually uses.
//
// ## The interaction with the pre-existing tests
//
// `src/lib/db.ts` opens raw `pg` connections and switches role with an
// explicit `SET ROLE`, including a `"owner"` mode used to seed fixtures
// across tenants. If those connections inherited `options=-c
// role=pharmax_app` they would start life as the restricted role, and
// `connect("owner")` would quietly stop being owner — every existing
// seeding call would begin failing RLS in a way that looks like a
// policy bug rather than a harness bug.
//
// `db.ts` therefore strips `options` from whatever URL it resolves. The
// two mechanisms are deliberately complementary: Prisma is pinned by
// connection string, raw `pg` is pinned by `SET ROLE`.

import process from "node:process";

import { pinSessionRole, stripSessionRole } from "./db-url.js";

/** Session role the Prisma client connects as. Mirrors apps/web. */
const APP_ROLE = "pharmax_app";

/**
 * Deterministic local KMS seed for the suite.
 *
 * `LocalKmsAdapter` needs a stable seed so ciphertext written by one
 * command is readable by the next within a run. It is synthetic and
 * fixed — nothing here is a secret, and nothing here may ever be a
 * real key. `build-kms-adapter.ts` requires >= 32 characters.
 */
const LOCAL_KMS_SEED = "pharmax-integration-suite-synthetic-kms-seed-never-production";

function resolveBaseUrl(): string {
  // Re-execution guard. Vitest can instantiate this module TWICE: once
  // as the setupFiles entry and once more if any test helper imports it
  // (separate module instances, same process). On the second run
  // DATABASE_URL is already pinned to the app role, so deriving "base"
  // from it would store a pinned URL as the owner URL — and everything
  // that builds an owner or system connection from it would silently
  // run as `pharmax_app`. The first run's preserved base is the truth.
  const preserved = process.env["INTEGRATION_OWNER_DATABASE_URL"];
  if (typeof preserved === "string" && preserved.length > 0) return preserved;
  const integration = process.env["INTEGRATION_DATABASE_URL"];
  if (typeof integration === "string" && integration.length > 0) return integration;
  const dev = process.env["DATABASE_URL"];
  if (typeof dev === "string" && dev.length > 0) return dev;
  throw new Error(
    "Integration suite: no INTEGRATION_DATABASE_URL or DATABASE_URL set.\n" +
      "  pnpm db:up                # start docker-compose postgres\n" +
      "  pnpm db:migrate:deploy    # apply the schema\n" +
      "  pnpm test:integration"
  );
}

const baseUrl = resolveBaseUrl();

// Prisma reads DATABASE_URL. Point it at the app role so RLS is live
// for every command the harness dispatches.
process.env["DATABASE_URL"] = pinSessionRole(baseUrl, APP_ROLE);

// Some code paths read DIRECT_URL for non-pooled access. Keep it
// consistent so a stray reader cannot end up on a different role than
// the one under test.
process.env["DIRECT_URL"] = process.env["DATABASE_URL"];

// Preserve the un-pinned URL for `db.ts` and `system-prisma.ts`. `db.ts`
// needs the login user so its explicit `SET ROLE` still controls the
// session, and `system-prisma.ts` re-pins this URL to `pharmax_system`
// — `pinSessionRole` deliberately respects an existing `role=`, so a
// URL that arrives already pinned to `pharmax_app` (local `.env` and
// production-shaped strings both do) would keep the system client on
// the app role and silently defeat the RxNorm grant checks.
process.env["INTEGRATION_OWNER_DATABASE_URL"] = stripSessionRole(baseUrl);

if (
  process.env["PHARMAX_LOCAL_KMS_SEED"] === undefined ||
  process.env["PHARMAX_LOCAL_KMS_SEED"] === ""
) {
  process.env["PHARMAX_LOCAL_KMS_SEED"] = LOCAL_KMS_SEED;
}
