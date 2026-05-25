// ScopedRepository — the ergonomic base class repositories extend.
//
// Why have this when the Prisma extension already enforces tenancy?
//
//   1. Make the boundary VISIBLE in code review. Any new file that
//      writes to the database without extending ScopedRepository is
//      a code smell flagged at PR time. The extension is the safety
//      net; the base class is the lint rule.
//
//   2. Centralize transaction helpers. Repositories commonly need
//      to participate in an outer Prisma `$transaction` started by
//      a command handler. The base exposes a typed `withTx` hook so
//      every repository handles the tx case identically.
//
//   3. Provide a typed accessor for the current context, so
//      repository methods can branch on `clinicId`/`teamId`/etc.
//      without re-reading ALS in every method.
//
// What this base DELIBERATELY does NOT do:
//   - It does NOT re-implement tenancy filtering. The Prisma
//     extension is the source of truth. If you bypass the extension
//     (e.g. by holding a raw `prisma` reference), this class can't
//     save you.
//   - It does NOT enforce permissions. That's @pharmax/rbac, layered
//     above this on the command-handler side.
//   - It does NOT cache. Caches live in the read model / projector
//     layer, never in the write-path repository.

import type { PrismaClient } from "@pharmax/database";

import { requireCurrentContext } from "./als.js";
import type { TenancyContext } from "./context.js";

/**
 * Type of a Prisma model delegate (e.g. `prisma.clinic`,
 * `prisma.user`). We don't try to constrain this further at the
 * type level because Prisma's generated delegate types are not
 * usefully unifiable across models, and the base class only stores
 * the delegate to expose it to subclasses unchanged.
 */
export type AnyDelegate = unknown;

export abstract class ScopedRepository<TDelegate extends AnyDelegate> {
  protected constructor(protected readonly delegate: TDelegate) {}

  /**
   * The active tenancy context. Throws
   * `AuthorizationError(TENANCY_NO_CONTEXT)` if no user context is
   * active. Repository methods that don't need to branch on context
   * fields can ignore this — the Prisma extension already enforces
   * the filter.
   */
  protected get context(): TenancyContext {
    return requireCurrentContext();
  }

  /**
   * Returns a fresh repository instance bound to a Prisma transaction
   * client. Use inside a `prisma.$transaction(async (tx) => { ... })`
   * block when multiple repositories must commit atomically.
   *
   * Subclasses MUST override this to return their concrete type
   * with the tx delegate substituted.
   *
   * Example:
   *
   *     class ClinicRepository extends ScopedRepository<PrismaClient["clinic"]> {
   *       static fromPrisma(p: PrismaClient) { return new ClinicRepository(p.clinic); }
   *       override withTx(tx: PrismaTxClient) { return new ClinicRepository(tx.clinic); }
   *     }
   */
  public abstract withTx(tx: PrismaClient): ScopedRepository<TDelegate>;
}
