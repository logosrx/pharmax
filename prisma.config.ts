// Prisma CLI configuration (Prisma 7+).
//
// In Prisma 7 the `datasource` block no longer carries connection URLs.
// The CLI (migrate / db execute / migrate diff / db seed) reads the
// database connection, schema location, migration output, and seed
// command from THIS file instead.
//
// Connection roles (unchanged from the v6 `url` / `directUrl` split):
//   - `datasource.url` is the OWNER/superuser connection used by the
//     CLI for DDL (migrations, db execute, diff). It maps to the old
//     `DIRECT_URL`, falling back to `DATABASE_URL` for local/dev where
//     a single role does everything.
//   - The application RUNTIME client does NOT use this file. It is
//     built from `DATABASE_URL` (the pooled `pharmax_app` role) via the
//     `pg` driver adapter in `packages/database/src/client.ts`.
//   - `shadowDatabaseUrl` is consumed by `migrate dev` and by the drift
//     guard (`scripts/check-prisma-drift.ts`, which sets
//     `SHADOW_DATABASE_URL` before invoking `prisma migrate diff`).
//
// `import "dotenv/config"` is required: Prisma 7 no longer auto-loads
// `.env`, so the config file is the single place we load it for every
// CLI invocation.

import "dotenv/config";
import process from "node:process";

import { defineConfig } from "prisma/config";

// `env()` from `prisma/config` THROWS when a variable is absent, which
// is too strict for our optional URLs (the owner connection falls back
// to DATABASE_URL in dev, and the shadow DB is only needed by the drift
// guard). dotenv has already populated `process.env`, so resolve the
// optional values directly and only attach the ones that are set.
const datasourceUrl = process.env["DIRECT_URL"] ?? process.env["DATABASE_URL"];
const shadowDatabaseUrl = process.env["SHADOW_DATABASE_URL"];

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    ...(datasourceUrl !== undefined ? { url: datasourceUrl } : {}),
    ...(shadowDatabaseUrl !== undefined ? { shadowDatabaseUrl } : {}),
  },
});
