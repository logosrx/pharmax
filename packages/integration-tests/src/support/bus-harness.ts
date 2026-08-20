// Boots the real command bus against the real database.
//
// ## What this is for
//
// Every other test of a command handler in this repository runs against
// a hand-rolled fake Prisma whose `$transaction` is `fn => fn(tx)` — it
// records writes and cannot roll back. That makes the central
// architectural invariant unprovable by construction: `command_log`,
// `order_event`, `audit_log` and `event_outbox` are asserted to commit
// together thousands of times and verified together zero times.
//
// This harness closes that gap by configuring the process exactly the
// way a composition root does, then dispatching real commands. Nothing
// here is a stub: the Prisma client is the tenancy-extended production
// export, the permission loader is `PrismaPermissionLoader` reading real
// `role_permission` rows, and the transaction is a real Postgres
// transaction that really rolls back.
//
// ## Deliberately real, deliberately not
//
// REAL, because faking it would void the point:
//   - Prisma client (`@pharmax/database`), connected as `pharmax_app`
//     so RLS is enforced — see `setup-env.ts` for how the role is
//     pinned and why superuser would have been a trap.
//   - `PrismaPermissionLoader`, so an RBAC refusal is a real
//     `role_permission` join returning nothing.
//   - System clock, so `occurredAt` ordering is real ordering.
//
// SUBSTITUTED, with the reason:
//   - `LocalKmsAdapter` instead of `AwsKmsAdapter`. Envelope-encryption
//     correctness belongs to `@pharmax/crypto`'s own tests; here it only
//     has to be deterministic within a run so a `sigEnc` written by
//     `CreatePrescription` decrypts for a later read.
//   - A static `requestHashKey`. Production derives it from KMS; the
//     harness needs it stable, not secret.
//
// ## Idempotency of configuration
//
// `configureCommandBus` and friends are process-wide singletons and this
// suite runs single-fork, so configuring once per process is both
// sufficient and necessary — reconfiguring mid-run would swap the client
// underneath an in-flight test. `configureHarness()` is therefore
// idempotent and safe to call from every `beforeAll`.

import { randomUUID } from "node:crypto";

import { configureCommandBus, DEFAULT_TRANSACTION_BUDGET } from "@pharmax/command-bus";
import { configureCrypto, LocalKmsAdapter } from "@pharmax/crypto";
import { prisma } from "@pharmax/database";
import { clock as clockNs, logger as loggerNs } from "@pharmax/platform-core";
import { configureRbac, PrismaPermissionLoader } from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext, type TenancyContext } from "@pharmax/tenancy";

/**
 * Fixed HMAC key for the idempotency request hash.
 *
 * Production derives this from KMS at boot so a reader of
 * `idempotency_key.requestHash` cannot dictionary-attack it. The
 * harness only needs the value to be stable across dispatches inside a
 * run, so a replay is recognised as a replay.
 */
const HARNESS_REQUEST_HASH_KEY = "pharmax-integration-suite-request-hash-key-synthetic";

let configured = false;

/**
 * Configure crypto, RBAC and the command bus for the process.
 *
 * Idempotent. Returns the same Prisma client the bus was handed, so a
 * test asserting on rows reads through the identical tenancy-extended
 * path the command under test used — not a second client that might
 * differ in scoping.
 */
export function configureHarness(): { prisma: typeof prisma } {
  if (configured) return { prisma };

  const seed = process.env["PHARMAX_LOCAL_KMS_SEED"];
  if (seed === undefined || seed === "") {
    throw new Error(
      "bus-harness: PHARMAX_LOCAL_KMS_SEED is unset. `support/setup-env.ts` should have set it; " +
        "check that it is registered in setupFiles in packages/integration-tests/vitest.config.ts."
    );
  }

  configureCrypto({ kms: new LocalKmsAdapter({ seed }) });

  configureRbac({ loader: new PrismaPermissionLoader(prisma) });

  configureCommandBus({
    prisma,
    clock: clockNs.systemClock,
    logger: loggerNs.noopLogger,
    requestHashKey: HARNESS_REQUEST_HASH_KEY,
    // Explicit rather than inherited, and identical to production's
    // default. A harness that quietly ran on a larger budget than
    // production would hide exactly the contention this suite exists to
    // expose.
    transactionBudget: DEFAULT_TRANSACTION_BUDGET,
  });

  configured = true;
  return { prisma };
}

/**
 * Fail unless the Prisma client is really connected as `pharmax_app`.
 *
 * This is the load-bearing assumption of the whole harness and the one
 * most likely to break silently. If `setup-env.ts` stops pinning the
 * role — a refactor, a CI job that exports its own DATABASE_URL, a
 * future change to how `packages/database` reads config — then every
 * command here would run as a Postgres SUPERUSER with RLS bypassed. The
 * suite would stay green while quietly proving nothing about tenant
 * isolation, and a green check that has stopped testing what it claims
 * is worse than no check.
 *
 * Verified shape: `current_user` is the assumed role, `session_user`
 * remains the login user. Asserting on `current_user` is what matters,
 * since that is what RLS policies evaluate against.
 */
export async function assertAppRolePinned(): Promise<void> {
  const rows = await prisma.$queryRaw<Array<{ current_user: string }>>`select current_user`;
  const role = rows[0]?.current_user;
  if (role !== "pharmax_app") {
    throw new Error(
      `bus-harness: expected Prisma to connect as "pharmax_app" but it is "${String(role)}".\n` +
        "RLS would be bypassed and this suite's isolation assertions would be vacuous.\n" +
        "Check that DATABASE_URL carries `options=-c role=pharmax_app` (see support/setup-env.ts)."
    );
  }
}

export interface ActingAsInput {
  readonly organizationId: string;
  readonly userId: string;
  readonly siteId?: string;
  readonly clinicId?: string;
  readonly bucketId?: string;
  readonly workstationId?: string;
}

/**
 * Build the tenancy context a dispatch runs inside.
 *
 * The bus reads this from async-local storage and turns
 * `organizationId` into the `pharmax.organization_id` GUC at the top of
 * its transaction, which is what makes RLS bite. Passing the wrong
 * organization here is how the cross-tenant test proves fail-closed
 * behaviour, so this is intentionally a thin, honest wrapper rather
 * than something that "helpfully" reconciles ids.
 */
export function contextFor(input: ActingAsInput): TenancyContext {
  return buildTenancyContext({
    organizationId: input.organizationId,
    ...(input.siteId === undefined ? {} : { siteId: input.siteId }),
    ...(input.clinicId === undefined ? {} : { clinicId: input.clinicId }),
    ...(input.bucketId === undefined ? {} : { bucketId: input.bucketId }),
    ...(input.workstationId === undefined ? {} : { workstationId: input.workstationId }),
    actor: { userId: input.userId, correlationId: randomUUID() },
  });
}

/** Run `fn` inside the tenancy context implied by `input`. */
export async function actingAs<T>(input: ActingAsInput, fn: () => Promise<T>): Promise<T> {
  return withTenancyContext(contextFor(input), fn);
}

/** A fresh idempotency key. Callers that test replay reuse one instead. */
export function newIdempotencyKey(prefix = "it"): string {
  return `${prefix}-${randomUUID()}`;
}
