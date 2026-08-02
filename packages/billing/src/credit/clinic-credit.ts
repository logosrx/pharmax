// Clinic credit ledger — shared write/read helpers for the
// append-only `clinic_credit_entry` table.
//
// Writers (all commands in this package):
//
//   - `GrantClinicCredit`  → GRANT entry ("credit-grant:{ulid}")
//   - `ApplyClinicCredit`  → APPLICATION entry ("credit-apply:{ulid}")
//                            + a payment-ledger row (method
//                            CREDIT_BALANCE) in the SAME transaction
//
// Invariants owned here:
//
//   - `amountCents` is always POSITIVE; direction comes from `kind`.
//   - Balance = Σ GRANT − Σ APPLICATION per (clinic, currency),
//     NEVER negative. This module computes the balance; the
//     never-negative guarantee comes from callers serializing on
//     `lockClinicForCredit` BEFORE reading it (two concurrent
//     applications against the same balance are impossible — the
//     second waits on the clinic row lock and re-reads a balance
//     that already reflects the first).
//   - Idempotency: the unique `creditEventKey` makes concurrent
//     replays converge (P2002 → re-read → `created: false`).
//   - Immutability: this module exposes NO update or delete path,
//     and none may be added. Corrections are new offsetting rows.
//
// PHI invariant: none. Clinic ids, cents, timestamps, operator ids.

import type { OutboxEventDraft, PrismaTxClient } from "@pharmax/command-bus";
import {
  type ClinicCreditEntryKind,
  ClinicCreditEntryKind as CreditKind,
  type ClinicCreditSource,
  Prisma,
} from "@pharmax/database";
import { errors, ids } from "@pharmax/platform-core";

export const CLINIC_CREDIT_CLINIC_NOT_FOUND = "CLINIC_CREDIT_CLINIC_NOT_FOUND";

export interface ClinicCreditEntryInput {
  readonly organizationId: string;
  readonly clinicId: string;
  readonly kind: ClinicCreditEntryKind;
  /** GRANT entries only; omit for APPLICATION. */
  readonly source?: ClinicCreditSource;
  /** Always positive; direction comes from `kind`. */
  readonly amountCents: number;
  readonly currency: string;
  /** Idempotency anchor, e.g. `"credit-grant:{ulid}"`. */
  readonly creditEventKey: string;
  /** APPLICATION entries only. */
  readonly appliedToInvoiceId?: string;
  /** APPLICATION entries only: the CREDIT_BALANCE payment-ledger row. */
  readonly appliedPaymentId?: string;
  readonly occurredAt: Date;
  readonly metadata?: Prisma.InputJsonValue;
}

export interface ClinicCreditEntryResult {
  readonly creditEntryId: string;
  /** False when a concurrent replay already inserted the entry. */
  readonly created: boolean;
}

/**
 * `SELECT … FOR UPDATE` the clinic row inside the tx. Serializes ALL
 * credit-ledger mutations for the clinic — the balance read that
 * follows is exact for the duration of the transaction, which is
 * what makes "balance never negative" a real invariant instead of a
 * race window.
 *
 * Also doubles as the existence + tenancy check: the org filter
 * belt-and-braces the RLS GUC, and a missing row throws NotFound.
 */
export async function lockClinicForCredit(
  tx: PrismaTxClient,
  input: { readonly organizationId: string; readonly clinicId: string }
): Promise<{ readonly clinicId: string }> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id
    FROM "clinic"
    WHERE id = ${input.clinicId}::uuid AND "organizationId" = ${input.organizationId}::uuid
    FOR UPDATE`;
  if (rows.length === 0) {
    throw new errors.NotFoundError({
      code: CLINIC_CREDIT_CLINIC_NOT_FOUND,
      message: "Clinic not found in this organization.",
      metadata: { clinicId: input.clinicId },
    });
  }
  return { clinicId: rows[0]!.id };
}

/**
 * Current credit balance for (clinic, currency):
 * Σ GRANT − Σ APPLICATION. Callers that intend to MUTATE the ledger
 * must hold the `lockClinicForCredit` lock before reading this.
 */
export async function computeClinicCreditBalanceCents(
  tx: PrismaTxClient,
  input: {
    readonly organizationId: string;
    readonly clinicId: string;
    readonly currency: string;
  }
): Promise<number> {
  const scope = {
    organizationId: input.organizationId,
    clinicId: input.clinicId,
    currency: input.currency,
  };
  const [granted, applied] = await Promise.all([
    tx.clinicCreditEntry.aggregate({
      where: { ...scope, kind: CreditKind.GRANT },
      _sum: { amountCents: true },
    }),
    tx.clinicCreditEntry.aggregate({
      where: { ...scope, kind: CreditKind.APPLICATION },
      _sum: { amountCents: true },
    }),
  ]);
  return (granted._sum.amountCents ?? 0) - (applied._sum.amountCents ?? 0);
}

/**
 * Append one credit movement. Idempotent on `creditEventKey` — a
 * concurrent replay's P2002 resolves by re-reading the winner's row.
 */
export async function insertClinicCreditEntry(
  tx: PrismaTxClient,
  input: ClinicCreditEntryInput
): Promise<ClinicCreditEntryResult> {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error(
      `clinic credit amounts must be positive integers (got ${input.amountCents}); direction comes from kind`
    );
  }

  const creditEntryId = ids.generateUlid();
  try {
    await tx.clinicCreditEntry.create({
      data: {
        id: creditEntryId,
        organizationId: input.organizationId,
        clinicId: input.clinicId,
        kind: input.kind,
        source: input.source ?? null,
        amountCents: input.amountCents,
        currency: input.currency,
        creditEventKey: input.creditEventKey,
        appliedToInvoiceId: input.appliedToInvoiceId ?? null,
        appliedPaymentId: input.appliedPaymentId ?? null,
        occurredAt: input.occurredAt,
        metadata: input.metadata ?? Prisma.JsonNull,
      },
    });
    return { creditEntryId, created: true };
  } catch (cause) {
    if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === "P2002") {
      const winner = await tx.clinicCreditEntry.findUnique({
        where: { creditEventKey: input.creditEventKey },
        select: { id: true },
      });
      if (winner !== null) {
        return { creditEntryId: winner.id, created: false };
      }
    }
    throw cause;
  }
}

/**
 * Build the `billing.clinic_credit.recorded.v1` outbox draft for an
 * entry that `insertClinicCreditEntry` just CREATED. Callers must not
 * emit this for `created: false` results.
 */
export function clinicCreditRecordedOutboxEvent(input: {
  readonly creditEntryId: string;
  readonly entry: ClinicCreditEntryInput;
  /** (clinic, currency) balance AFTER this entry. */
  readonly balanceAfterCents: number;
}): OutboxEventDraft {
  return {
    eventType: "billing.clinic_credit.recorded.v1",
    aggregateType: "Clinic",
    aggregateId: input.entry.clinicId,
    payload: {
      organizationId: input.entry.organizationId,
      clinicId: input.entry.clinicId,
      creditEntryId: input.creditEntryId,
      kind: input.entry.kind,
      source: input.entry.source ?? null,
      amountCents: input.entry.amountCents,
      currency: input.entry.currency,
      balanceAfterCents: input.balanceAfterCents,
      appliedToInvoiceId: input.entry.appliedToInvoiceId ?? null,
      occurredAt: input.entry.occurredAt.toISOString(),
    },
  };
}
