// GrantClinicCredit — operator-recorded addition to a clinic's
// stored credit balance.
//
// Where credit comes from:
//
//   - OVERPAYMENT: a clinic's check exceeds the invoice balance.
//     RecordManualPayment (correctly) rejects the excess — the
//     operator records the invoice's remaining balance there, then
//     grants the excess here. The cash arrived once; the ledger
//     split mirrors how it was absorbed.
//   - GOODWILL: service-recovery credit, negotiated concession.
//   - OTHER: anything the operator can justify in the note.
//
// Pipeline:
//
//   1. Lock the clinic row (SELECT … FOR UPDATE) — ALL credit
//      mutations for a clinic serialize on this lock, which is what
//      makes the balance arithmetic exact.
//   2. Read the current (clinic, currency) balance.
//   3. Append the GRANT entry ("credit-grant:{ulid}").
//   4. Emit `billing.clinic_credit.recorded.v1` with the post-entry
//      balance.
//
// The grant does NOT touch any invoice — stored credit is a
// clinic-level asset until ApplyClinicCredit spends it against an
// OPEN invoice.
//
// SETTLED-ONLY, same as every ledger writer: grant credit when the
// backing money is in hand (the overpaid check has cleared), not
// when it is promised.
//
// Statement rendering: grants appear on the clinic statement as
// CREDIT_GRANTED entries (negative — the clinic owes less from the
// moment the credit exists), so a granted-but-unapplied credit shows
// as a closing balance in the clinic's favor. Applications appear as
// the PAYMENT_RECEIVED "Credit balance" / CREDIT_BALANCE_APPLIED
// pair, which nets to zero.
//
// Idempotency: bus-level command idempotency key short-circuits
// retries; the ledger key `credit-grant:{ulid}` is generated inside
// the handler and commits atomically with the command log.
//
// PHI invariant: none. Amounts, source kind, a bank-side reference.
// `operatorNote` is free-text (NOT PHI by convention but redacted
// from command_log per defense in depth).

import type { Command, HandlerResult, OutboxEventDraft } from "@pharmax/command-bus";
import { ClinicCreditEntryKind, ClinicCreditSource } from "@pharmax/database";
import { errors, ids } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

import {
  type ClinicCreditEntryInput,
  clinicCreditRecordedOutboxEvent,
  computeClinicCreditBalanceCents,
  insertClinicCreditEntry,
  lockClinicForCredit,
} from "../credit/clinic-credit.js";

export const GRANT_CLINIC_CREDIT_RECEIVED_AT_IN_FUTURE =
  "GRANT_CLINIC_CREDIT_RECEIVED_AT_IN_FUTURE";

/** Tolerated clock skew when validating `receivedAt` against now. */
const RECEIVED_AT_FUTURE_SKEW_MS = 5 * 60 * 1000;

const inputSchema = z
  .object({
    clinicId: z.uuid(),
    /** Positive cents. Capped at $100k — larger grants deserve a human double-take and a split entry. */
    amountCents: z.number().int().min(1).max(100_000_00),
    source: z.enum(ClinicCreditSource),
    /** ISO-4217 lowercase, e.g. "usd" (matches invoice.currency). */
    currency: z
      .string()
      .length(3)
      .regex(/^[a-z]{3}$/)
      .default("usd"),
    /** Bank-side reference for OVERPAYMENT grants: check number, ACH trace id. Not PHI. */
    referenceNumber: z.string().min(1).max(128).optional(),
    /**
     * When the backing money was actually received. Defaults to now.
     * Backdating is expected (overpaid checks are recorded after
     * deposit); future dates are not.
     */
    receivedAt: z.iso.datetime({ offset: true }).optional(),
    /** Free-text operator note. Redacted from command_log per defense-in-depth. */
    operatorNote: z.string().min(1).max(2000).optional(),
  })
  .strict();

export type GrantClinicCreditInput = z.infer<typeof inputSchema>;

export interface GrantClinicCreditOutput {
  readonly clinicId: string;
  readonly creditEntryId: string;
  readonly amountCents: number;
  readonly currency: string;
  /** (clinic, currency) credit balance after this grant. */
  readonly balanceAfterCents: number;
}

export const GrantClinicCredit: Command<GrantClinicCreditInput, GrantClinicCreditOutput> = {
  name: "GrantClinicCredit",
  inputSchema,
  permission: PERMISSIONS.BILLING_MANAGE_CLINIC_CREDIT,
  redactFields: ["operatorNote"],

  async handle({
    input,
    ctx,
    tx,
    clock,
    commandLogId,
  }): Promise<HandlerResult<GrantClinicCreditOutput>> {
    const now = clock.now();

    // ---- receivedAt sanity ----
    const receivedAt = input.receivedAt !== undefined ? new Date(input.receivedAt) : now;
    if (receivedAt.getTime() > now.getTime() + RECEIVED_AT_FUTURE_SKEW_MS) {
      throw new errors.ValidationError({
        code: GRANT_CLINIC_CREDIT_RECEIVED_AT_IN_FUTURE,
        message: "receivedAt is in the future. Credit is granted for money already in hand.",
        metadata: { receivedAt: receivedAt.toISOString(), now: now.toISOString() },
      });
    }

    // ---- Serialize on the clinic row, then read the balance ----
    await lockClinicForCredit(tx, {
      organizationId: ctx.organizationId,
      clinicId: input.clinicId,
    });
    const balanceBeforeCents = await computeClinicCreditBalanceCents(tx, {
      organizationId: ctx.organizationId,
      clinicId: input.clinicId,
      currency: input.currency,
    });
    const balanceAfterCents = balanceBeforeCents + input.amountCents;

    // ---- Append the GRANT entry ----
    const hasOperatorNote =
      typeof input.operatorNote === "string" && input.operatorNote.trim().length > 0;
    const entry: ClinicCreditEntryInput = {
      organizationId: ctx.organizationId,
      clinicId: input.clinicId,
      kind: ClinicCreditEntryKind.GRANT,
      source: input.source,
      amountCents: input.amountCents,
      currency: input.currency,
      creditEventKey: `credit-grant:${ids.generateUlid()}`,
      occurredAt: receivedAt,
      metadata: {
        referenceNumber: input.referenceNumber ?? null,
        recordedByUserId: ctx.actor.userId,
        hasOperatorNote,
        commandLogId,
      },
    };
    const result = await insertClinicCreditEntry(tx, entry);
    const outboxEvents: OutboxEventDraft[] = result.created
      ? [
          clinicCreditRecordedOutboxEvent({
            creditEntryId: result.creditEntryId,
            entry,
            balanceAfterCents,
          }),
        ]
      : [];

    return {
      output: {
        clinicId: input.clinicId,
        creditEntryId: result.creditEntryId,
        amountCents: input.amountCents,
        currency: input.currency,
        balanceAfterCents,
      },
      audit: {
        action: "billing.clinic_credit.granted",
        resourceType: "Clinic",
        resourceId: input.clinicId,
        metadata: {
          clinicId: input.clinicId,
          creditEntryId: result.creditEntryId,
          source: input.source,
          amountCents: input.amountCents,
          currency: input.currency,
          balanceBeforeCents,
          balanceAfterCents,
          referenceNumber: input.referenceNumber ?? null,
          receivedAt: receivedAt.toISOString(),
          hasOperatorNote,
          recordedByUserId: ctx.actor.userId,
          commandLogId,
          occurredAt: now.toISOString(),
        },
      },
      outboxEvents,
    };
  },
};
