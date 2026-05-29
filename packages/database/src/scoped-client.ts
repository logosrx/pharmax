// The tenancy-enforced Prisma client — the canonical `prisma` export.
//
// This is the client that ALL application code (route handlers, read
// helpers, command handlers, repositories) must use. It wraps the raw
// `systemPrisma` with the `@pharmax/tenancy` Prisma extension, which
// enforces tenant isolation at the ORM layer:
//
//   | model is scoped? | ALS frame | result                    |
//   |------------------|-----------|---------------------------|
//   | no               | any       | pass through              |
//   | yes              | none      | throw TENANCY_NO_CONTEXT  |
//   | yes              | system    | pass through (audited)    |
//   | yes              | user      | inject org filter         |
//
// Why this is the default export (and `systemPrisma` is the opt-in):
//
//   Before this wiring the extension was defined and unit-tested but
//   NEVER applied to the exported client, so read helpers that relied
//   on it (e.g. `prisma.reportSchedule.findMany()` with no `where`)
//   were either leaking across tenants (when the connection role had
//   BYPASSRLS) or fail-closed-broken (under `pharmax_app`). Making the
//   scoped client the default makes the safe path the easy path and
//   the unscoped path an explicit, greppable opt-in (`systemPrisma`).
//
// Layered defense:
//
//   - ORM layer (here): the extension injects `where organizationId`
//     under a user frame and fails closed with no frame. Works
//     regardless of the Postgres connection role.
//   - DB layer (RLS): the command bus sets the per-tx GUC
//     (`applyTenancySessionGuc`) so Postgres ALSO enforces the
//     predicate on writes. Read paths get the same backstop when run
//     through `readInTenantContext` (see scoped-read.ts).
//
// HMR note: cache the extended client on `globalThis` for the same
// reason `client.ts` caches the raw one — Next.js dev re-imports
// server modules many times per process.

import process from "node:process";

import { applyTenancyExtension } from "@pharmax/tenancy";

import { systemPrisma } from "./client.js";
import type { PrismaClient } from "./generated/client/index.js";

type GlobalWithScopedPrisma = typeof globalThis & {
  __pharmaxScopedPrisma?: PrismaClient;
};

const globalForScopedPrisma = globalThis as GlobalWithScopedPrisma;

const isProduction = process.env["NODE_ENV"] === "production";

/**
 * The tenancy-enforced Prisma client. This is the canonical `prisma`
 * export from `@pharmax/database`. Tenant-scoped models are
 * automatically filtered to the active `withTenancyContext` org and
 * fail closed (`TENANCY_NO_CONTEXT`) when queried with no frame.
 */
export const prisma: PrismaClient =
  globalForScopedPrisma.__pharmaxScopedPrisma ?? applyTenancyExtension(systemPrisma);

if (!isProduction) {
  globalForScopedPrisma.__pharmaxScopedPrisma = prisma;
}
