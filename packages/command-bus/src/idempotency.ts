// Idempotency lookup + store.
//
// Contract:
//
//   `lookupIdempotency` runs BEFORE the transaction. It returns:
//     - `{ kind: "miss" }` — no existing row, the bus should proceed.
//     - `{ kind: "replay", responsePayload }` — existing row with a
//       MATCHING request hash. The bus returns the cached payload
//       WITHOUT invoking the handler.
//     - throws `ConflictError(COMMAND_IDEMPOTENCY_PAYLOAD_MISMATCH)`
//       when a row exists with the same key but a DIFFERENT request
//       hash. This is a strong signal of a client bug: the same
//       idempotency key was reused for a different request.
//
//   `storeIdempotencyInTx` runs INSIDE the transaction, AFTER the
//   handler succeeds. The unique constraint on
//   (organizationId, commandName, key) means concurrent attempts
//   serialize at commit time: the loser's tx rolls back with a
//   unique-violation Prisma error, which the bus surfaces to the
//   caller as a ConflictError on retry.
//
// PHI invariant: `requestHash` is a SHA-256 over the REDACTED
// request payload; `responsePayload` is the redacted handler
// output. Plain payload bytes never reach this table.

import type { Prisma, PrismaClient } from "@pharmax/database";

import { errors } from "@pharmax/platform-core";

import { COMMAND_IDEMPOTENCY_PAYLOAD_MISMATCH } from "./errors.js";
import type { PrismaTxClient } from "./types.js";

export type LookupResult =
  | { readonly kind: "miss" }
  | {
      readonly kind: "replay";
      readonly responsePayload: Prisma.JsonValue | null;
      readonly responseStatus: number | null;
    };

export interface LookupIdempotencyInput {
  readonly organizationId: string;
  readonly commandName: string;
  readonly key: string;
  readonly currentRequestHash: string;
}

/**
 * Look up an existing idempotency row. Pure read; does NOT mutate.
 * Throws `ConflictError(COMMAND_IDEMPOTENCY_PAYLOAD_MISMATCH)` if a
 * row exists with a different request hash.
 */
export async function lookupIdempotency(
  client: PrismaClient,
  input: LookupIdempotencyInput
): Promise<LookupResult> {
  const row = await client.idempotencyKey.findUnique({
    where: {
      organizationId_commandName_key: {
        organizationId: input.organizationId,
        commandName: input.commandName,
        key: input.key,
      },
    },
  });

  if (row === null) {
    return { kind: "miss" };
  }

  if (row.requestHash !== input.currentRequestHash) {
    throw new errors.ConflictError({
      code: COMMAND_IDEMPOTENCY_PAYLOAD_MISMATCH,
      message:
        "Idempotency key was previously used with a different request body. Generate a new key for a new request.",
      metadata: {
        commandName: input.commandName,
        organizationId: input.organizationId,
      },
    });
  }

  return {
    kind: "replay",
    responsePayload: row.responsePayload,
    responseStatus: row.responseStatus,
  };
}

export interface StoreIdempotencyInput {
  readonly organizationId: string;
  readonly commandName: string;
  readonly key: string;
  readonly requestHash: string;
  readonly responsePayload: Record<string, unknown>;
  readonly responseStatus: number | null;
  readonly expiresAt?: Date;
}

/**
 * Insert the idempotency row INSIDE the transaction. The unique
 * constraint serializes concurrent attempts — the loser's
 * transaction rolls back at this point on a unique-violation
 * Prisma error, which propagates to the executor's catch.
 */
export async function storeIdempotencyInTx(
  tx: PrismaTxClient,
  input: StoreIdempotencyInput
): Promise<void> {
  await tx.idempotencyKey.create({
    data: {
      organizationId: input.organizationId,
      commandName: input.commandName,
      key: input.key,
      requestHash: input.requestHash,
      responsePayload: input.responsePayload as Prisma.InputJsonValue,
      ...(input.responseStatus === null ? {} : { responseStatus: input.responseStatus }),
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    },
  });
}
