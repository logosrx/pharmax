// Prisma client extension that enforces tenancy at the lowest
// possible layer.
//
// Why at the Prisma layer (not a service-layer linter, not an
// in-memory wrapper)?
//
//   1. Defense in depth. Repositories can have bugs. Forgotten
//      `.scope(orgId)` calls in a repository will leak data. A
//      Prisma-level extension catches the leak EVEN IF the
//      repository forgot.
//
//   2. ORM neutrality of the API. Repository methods remain the
//      idiomatic Prisma calls (`db.clinic.findMany({ where: ... })`)
//      — no novel scope DSL to learn, no novel call shape to
//      reverse-engineer when reading domain code. The tenancy
//      enforcement is invisible to authors but bulletproof at
//      runtime.
//
//   3. Single auditable choke-point. SOC 2 reviewers can read ONE
//      file (this one) and ONE registry (tenant-scoped-models.ts)
//      to verify the entire isolation boundary, instead of grep-
//      ping the repo for every Prisma call.
//
// Behavior matrix:
//
//   | model is scoped? | ALS frame    | result                       |
//   |------------------|--------------|------------------------------|
//   | no               | any          | pass through                 |
//   | yes              | none         | throw TENANCY_NO_CONTEXT     |
//   | yes              | system       | pass through (audited bypass)|
//   | yes              | user         | inject org filter            |
//
// Mutation rules with a user context:
//   - find*/count/aggregate/groupBy → merge `{ organizationId }` into
//     `where`. For Organization model, merge `{ id }` instead.
//   - create/createMany → ensure `data.organizationId` (or `data.id`
//     for Organization) equals the active context. If the caller
//     passed a different value, throw TENANCY_CROSS_ORG_WRITE. If
//     the caller omitted it, inject the active value.
//   - update/updateMany/upsert/delete/deleteMany → merge into
//     `where`. For upsert, the create branch additionally gets the
//     create-side data check.
//
// Prisma 5.x guarantee that makes this clean: `WhereUniqueInput`
// extends `WhereInput`, so `{ id, organizationId }` is a valid
// `findUnique` filter. A `findUnique` for a guessed UUID belonging
// to a different org returns `null` instead of leaking.

import type { PrismaClient } from "@pharmax/database";

import { getCurrentContext, isSystemContext } from "./als.js";
import { tenancyCrossOrgWriteError, tenancyNoContextError } from "./errors.js";
import { resolveTenantFilterKind, type TenantFilterKind } from "./tenant-scoped-models.js";

// We can't import `Prisma.ExtensionArgs` types portably across
// generator output paths without coupling to the generated client,
// so we narrow the args we touch to a structural shape and let
// Prisma's variadic types pass through the extension. The unit
// tests exercise the matrix above against a fake client.
type AnyArgs = Record<string, unknown> | undefined;

interface ExtensionContext {
  readonly model: string | undefined;
  readonly operation: string;
  readonly args: AnyArgs;
  readonly query: (args: AnyArgs) => Promise<unknown>;
}

const WHERE_OPS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
  "update",
  "updateMany",
  "delete",
  "deleteMany",
]);

const CREATE_OPS = new Set(["create", "createMany"]);
const UPSERT_OPS = new Set(["upsert"]);

/**
 * Build a transform that injects the tenancy filter into a given
 * args object. Returns a NEW args object — never mutates the caller's
 * input. (Mutating Prisma args is observably buggy because Prisma
 * caches type metadata against the reference.)
 */
function injectTenancyArgs(
  filter: TenantFilterKind,
  activeOrgId: string,
  modelName: string,
  operation: string,
  args: AnyArgs
): AnyArgs {
  const filterField = filter.kind === "selfOrganization" ? "id" : "organizationId";
  const next: Record<string, unknown> = { ...(args ?? {}) };

  if (WHERE_OPS.has(operation)) {
    const where = (next["where"] as Record<string, unknown> | undefined) ?? {};
    next["where"] = { ...where, [filterField]: activeOrgId };
  }

  if (CREATE_OPS.has(operation)) {
    const data = next["data"];
    if (Array.isArray(data)) {
      next["data"] = data.map((row) =>
        ensureRowMatchesOrg(row, filterField, activeOrgId, modelName, operation)
      );
    } else if (data !== undefined && data !== null) {
      next["data"] = ensureRowMatchesOrg(
        data as Record<string, unknown>,
        filterField,
        activeOrgId,
        modelName,
        operation
      );
    }
  }

  if (UPSERT_OPS.has(operation)) {
    const where = (next["where"] as Record<string, unknown> | undefined) ?? {};
    next["where"] = { ...where, [filterField]: activeOrgId };

    const create = next["create"];
    if (create !== undefined && create !== null) {
      next["create"] = ensureRowMatchesOrg(
        create as Record<string, unknown>,
        filterField,
        activeOrgId,
        modelName,
        operation
      );
    }
    // The `update` branch is implicitly scoped by `where`, which we
    // just narrowed above. No additional injection needed.
  }

  return next;
}

function ensureRowMatchesOrg(
  row: Record<string, unknown>,
  filterField: string,
  activeOrgId: string,
  modelName: string,
  operation: string
): Record<string, unknown> {
  const existing = row[filterField];
  if (existing === undefined) {
    return { ...row, [filterField]: activeOrgId };
  }
  if (existing !== activeOrgId) {
    throw tenancyCrossOrgWriteError({
      model: modelName,
      operation,
      activeOrganizationId: activeOrgId,
      attemptedOrganizationId: String(existing),
    });
  }
  return row;
}

/**
 * Returns a Prisma client extended with the tenancy enforcement
 * layer. The original client is unaffected; the returned client
 * inherits all model delegates with the enforcement applied.
 *
 * Use exactly once per process at boot:
 *
 *     // packages/database/src/scoped-client.ts (or app boot)
 *     import { prisma } from "@pharmax/database";
 *     import { applyTenancyExtension } from "@pharmax/tenancy";
 *     export const db = applyTenancyExtension(prisma);
 *
 * Repositories then import `db` (not `prisma`). Bootstrap code
 * (migrations, seed, supervisor drainers) may continue using the
 * raw `prisma` import or call repositories inside
 * `withSystemContext(...)`.
 */
export function applyTenancyExtension<T extends PrismaClient>(client: T): T {
  // Cast the result through `unknown` because Prisma's `$extends`
  // returns a structurally compatible but nominally different type
  // and we want repositories to keep typing against `PrismaClient`.
  const extended = client.$extends({
    name: "pharmax-tenancy",
    query: {
      $allModels: {
        async $allOperations(ctx: ExtensionContext) {
          const filter = resolveTenantFilterKind(ctx.model);
          if (filter === null) {
            return ctx.query(ctx.args);
          }

          if (isSystemContext()) {
            return ctx.query(ctx.args);
          }

          const userCtx = getCurrentContext();
          if (userCtx === null) {
            throw tenancyNoContextError({
              model: ctx.model ?? "<unknown>",
              operation: ctx.operation,
            });
          }

          const nextArgs = injectTenancyArgs(
            filter,
            userCtx.organizationId,
            ctx.model ?? "<unknown>",
            ctx.operation,
            ctx.args
          );
          return ctx.query(nextArgs);
        },
      },
    },
  });

  return extended as unknown as T;
}
