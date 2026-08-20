// Idempotency lookup + store.
//
// Contract:
//
//   `lookupIdempotency` runs in the bus's GUC'd pre-flight
//   transaction (idempotency_key is RLS-protected; a raw-client
//   read has no tenant GUC and sees nothing). It returns:
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
//   unique-violation Prisma error, which the bus resolves into a
//   replay of the winner's cached response (or a stable
//   COMMAND_IN_FLIGHT 409 when the winner has not committed yet).
//
// PHI invariant: `requestHash` is a KEYED HMAC-SHA256 over the full
// request payload (see hash.ts — the key is KMS-derived, so the
// stored hash is non-reversible); `responsePayload` is the redacted
// handler output. Plain payload bytes never reach this table.

import type { Prisma, PrismaClient } from "@pharmax/database";

import { errors } from "@pharmax/platform-core";

import { COMMAND_IDEMPOTENCY_PAYLOAD_MISMATCH } from "./errors.js";
import type { PrismaTxClient } from "./types.js";

/**
 * Bind the acting user into the idempotency identity.
 *
 * The stored dedup identity is `(organizationId, commandName, key)`.
 * Route handlers build `key` from the RESOURCE and a minute bucket
 * (e.g. `pv1-approve:{orderId}:{fingerprint}:{minute}`) — the actor
 * is deliberately NOT in it, because a legitimate retry is the same
 * actor resubmitting. But that also meant two DIFFERENT operators
 * acting on the same resource in the same minute produced the SAME
 * key: the second one's preflight lookup HIT the first's row and the
 * bus replayed the first actor's response WITHOUT running the second
 * actor's handler — so the second actor's own RBAC/scope/SoD checks
 * never ran and no command_log / audit_log row was written for their
 * attempt (pentest M — cross-actor replay + audit gap).
 *
 * Qualifying the key with the actor makes a replay reachable ONLY by
 * the actor that created it. A different actor misses the cache and
 * executes the full pipeline (its own authorization, its own audit),
 * or is correctly refused by the workflow-state guard if the first
 * actor already advanced the order.
 *
 * System commands (`actorUserId === null`) collapse to a single
 * `sys` segment, preserving today's behavior: their idempotency is
 * keyed on an external event id (e.g. a Stripe event) and there is
 * no differing actor to isolate.
 *
 * The separator `|` never appears in a UUID or in the route-built
 * key segments, so the composed value round-trips unambiguously (it
 * is only ever compared, never parsed back apart).
 */
export function actorScopedIdempotencyKey(actorUserId: string | null, key: string): string {
  const actorSegment = actorUserId === null ? "sys" : `u:${actorUserId}`;
  return `${actorSegment}|${key}`;
}

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
  client: PrismaClient | PrismaTxClient,
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
