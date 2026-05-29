// Production dispatch adapters for the NPI Registry sync worker.
//
// The slice-4 orchestrator (`run-sync.ts`) takes its
// command-dispatch behavior as DI: `DispatchUpdateProvider` /
// `DispatchDeactivateProvider`. This file wires those interfaces
// to the real command bus + a post-hoc `command_log` lookup to
// resolve `command_log.id` for the `provider_sync_check`
// `dispatchedCommandLogId` foreign key.
//
// Why a separate file:
//   - Keeps slice-4 unit tests free of `executeCommand` /
//     `command-bus` configuration plumbing (the worker tests mock
//     `DispatchUpdateProvider` directly).
//   - Gives slice-5 (the cross-tenant drain) one importable
//     `buildProductionDispatchers(prisma)` call instead of two
//     ad-hoc adapter closures.
//
// CommandLogId lookup:
//   The command bus does not return the `command_log.id` it
//   created — `executeCommand(...)` returns the command's
//   typed output only. We use the bus's own idempotency key as
//   the lookup handle: every command_log row carries a unique
//   `(organizationId, commandName, idempotencyKey)` combo, and
//   the worker generates idempotency keys of the form
//   `npi-sync:<runId>:<providerId>:<action>` (worker contract,
//   slice 4). One indexed `findUnique` per successful dispatch
//   resolves the row id.
//
// Race-code classification:
//   `classifyDispatchError` (re-exported from `run-sync.ts`)
//   walks a thrown error's `.code` field and returns the
//   matching `ProviderRaceCode` if it's one the worker knows how
//   to downgrade. Any other exception propagates — the
//   orchestrator's outer try/catch will mark the run FAILED.

import { executeCommand } from "@pharmax/command-bus";
import type { PrismaClient } from "@pharmax/database";
import { getCurrentContext } from "@pharmax/tenancy";

import { DeactivateProvider } from "../commands/deactivate-provider.js";
import { UpdateProvider } from "../commands/update-provider.js";
import {
  classifyDispatchError,
  type DispatchDeactivateProvider,
  type DispatchResult,
  type DispatchUpdateProvider,
} from "./run-sync.js";

/**
 * Narrow Prisma surface used by the adapter — only the
 * `commandLog.findFirst` lookup needed to resolve a
 * `command_log.id` from the bus-emitted idempotency key.
 */
export type DispatchAdaptersPrismaSurface = Pick<PrismaClient, "commandLog">;

export interface ProductionDispatchers {
  readonly dispatchUpdateProvider: DispatchUpdateProvider;
  readonly dispatchDeactivateProvider: DispatchDeactivateProvider;
}

/**
 * Build dispatch adapters that wire the worker's typed adapter
 * interfaces to the real `executeCommand` + `command_log` lookup.
 *
 * The returned adapters expect the slice-5 drain to be running
 * inside the org's tenancy frame (the bus reads the actor /
 * organization out of the ALS; this adapter just hands the
 * input and idempotency key to the bus).
 *
 * Concurrency / safety:
 *   - The post-hoc `command_log` lookup uses the same
 *     idempotency key the bus persisted, so the lookup is
 *     deterministic — no race window between commit and read.
 *   - If the lookup returns no row (a structural invariant
 *     violation: bus said success but command_log is missing),
 *     the adapter throws an InternalError so the orchestrator
 *     marks the run FAILED with an actionable code rather than
 *     silently filing a check row with a stale / null
 *     commandLogId.
 */
export function buildProductionDispatchers(
  prisma: DispatchAdaptersPrismaSurface
): ProductionDispatchers {
  return {
    dispatchUpdateProvider: async (input, opts): Promise<DispatchResult> => {
      try {
        await executeCommand(UpdateProvider, input, { idempotencyKey: opts.idempotencyKey });
      } catch (cause) {
        const race = classifyDispatchError(cause);
        if (race !== null) {
          return { ok: false, raceCode: race };
        }
        throw cause;
      }
      const commandLogId = await resolveCommandLogId(prisma, "UpdateProvider", opts.idempotencyKey);
      return { ok: true, commandLogId };
    },

    dispatchDeactivateProvider: async (input, opts): Promise<DispatchResult> => {
      try {
        await executeCommand(DeactivateProvider, input, { idempotencyKey: opts.idempotencyKey });
      } catch (cause) {
        const race = classifyDispatchError(cause);
        if (race !== null) {
          return { ok: false, raceCode: race };
        }
        throw cause;
      }
      const commandLogId = await resolveCommandLogId(
        prisma,
        "DeactivateProvider",
        opts.idempotencyKey
      );
      return { ok: true, commandLogId };
    },
  };
}

async function resolveCommandLogId(
  prisma: DispatchAdaptersPrismaSurface,
  commandName: "UpdateProvider" | "DeactivateProvider",
  idempotencyKey: string
): Promise<string> {
  // Tenancy frame is required — `command_log` is tenant-scoped and
  // the Prisma extension auto-filters by organizationId. We assert
  // the frame exists so a missing-frame bug surfaces as a clear
  // error rather than a silent "no row" return.
  const ctx = getCurrentContext();
  if (ctx === null) {
    throw new Error(
      "buildProductionDispatchers: command_log lookup requires an active tenancy frame."
    );
  }

  const row = await prisma.commandLog.findFirst({
    where: { commandName, idempotencyKey },
    select: { id: true },
  });
  if (row === null) {
    throw new Error(
      `buildProductionDispatchers: command_log row missing after successful ` +
        `${commandName} dispatch (idempotencyKey=${idempotencyKey}).`
    );
  }
  return row.id;
}
