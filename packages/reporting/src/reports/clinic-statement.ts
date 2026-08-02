// Clinic statement — the classic AR statement: balance forward,
// dated charge / credit / payment / refund entries with a running
// balance, closing balance. One statement per (clinic, currency).
//
// What finance / operators use this for:
//
//   - The monthly statement a clinic's AP department expects:
//     "here is what you owed on June 1, what happened during June,
//     and what you owe now."
//   - Settling "you never credited us for X" disputes — every
//     balance movement is a dated, referenced line.
//
// Entry types and their balance effect (positive = clinic owes more):
//
//   BALANCE_FORWARD   opening balance as of `from` (all history before)
//   INVOICE_ISSUED    +issued total (see reconstruction note below)
//   CREDIT_APPLIED    −credit (post-issue credits, discounts,
//                     adjustments, AND refund credit lines)
//   PAYMENT_RECEIVED  −payment (settled ledger PAYMENT rows,
//                     including CREDIT_BALANCE settles)
//   REFUND_ISSUED     +refund  (settled ledger REFUND rows — cash
//                     going back out re-opens that much balance;
//                     its paired CREDIT_APPLIED line nets it to 0)
//   CREDIT_GRANTED    −grant  (clinic_credit_entry GRANT rows —
//                     overpayment excess / goodwill; the clinic
//                     owes less from the moment the credit exists,
//                     whether or not it has been applied yet)
//   CREDIT_BALANCE_APPLIED
//                     +application (clinic_credit_entry APPLICATION
//                     rows — stored credit leaving the clinic's
//                     balance; pairs with the PAYMENT_RECEIVED
//                     "Credit balance" line at the same instant and
//                     nets to 0, mirroring the refund pair)
//   CLOSING_BALANCE   running balance as of `to`
//
// Clinic-credit shape: the balance effect of a credit happens at
// GRANT time (−), not at application time. A $100 goodwill credit
// fully applied later contributes exactly −100 overall: −100 at
// grant, then (−100 payment + 100 application) = 0 at application.
// A granted-but-unapplied credit therefore correctly shows as a
// closing balance in the clinic's favor — the caveat statement v1
// carried ("unapplied credit invisible, balance overstated") is
// closed by this pair.
//
// Issued-total reconstruction: CreditInvoice retroactively
// decrements `totalCents`, so today's stored total on an invoice is
// NET of every manual credit ever applied. A statement must instead
// show the charge as it was ISSUED and each later credit as its own
// dated entry — so the INVOICE_ISSUED amount is
// `totalCents + Σ |post-issue manual-credit lines|`. Refund credit
// lines (`stripe-refund:*`) do NOT touch `totalCents` and need no
// add-back; they appear purely as CREDIT_APPLIED entries. Credits
// applied BEFORE finalize are already baked into the issued total
// and are deliberately not shown as entries.
//
// Pending refunds behave correctly by construction: IssueRefund
// writes the credit line immediately (CREDIT_APPLIED — "we owe you
// this back") and the ledger REFUND row lands only at settlement
// (REFUND_ISSUED — "and now we've paid it"), so an unsettled refund
// shows as a balance in the clinic's favor until the money moves.
//
// Deliberately EXCLUDED:
//
//   - DRAFT invoices (never billed) and VOID / UNCOLLECTIBLE
//     invoices (charges not being pursued do not belong on a
//     statement of what the clinic owes — including their rare
//     partial-payment history, which the payments-received register
//     still reports).
//
// Why this lives HERE and not `@pharmax/billing`: domain → domain
// imports are forbidden by the package-layer fitness function;
// reports read other domains' TABLES through `ctx.client`.
//
// PHI invariant: clinic-level financial records only — invoice
// numbers, line descriptions, cents, dates. No patient linkage.

import {
  ClinicCreditEntryKind,
  InvoiceLineKind,
  InvoiceStatus,
  PaymentKind,
  PaymentMethod,
} from "@pharmax/database";
import { z } from "zod";

import { dateRangeFields } from "../parameter-fields.js";
import type { DateRangeParams, ReportDefinition, ReportResult } from "../types.js";

export const STATEMENT_ENTRY_TYPES = [
  "BALANCE_FORWARD",
  "INVOICE_ISSUED",
  "CREDIT_APPLIED",
  "PAYMENT_RECEIVED",
  "CREDIT_BALANCE_APPLIED",
  "CREDIT_GRANTED",
  "REFUND_ISSUED",
  "CLOSING_BALANCE",
] as const;

export type StatementEntryType = (typeof STATEMENT_ENTRY_TYPES)[number];

export interface ClinicStatementRow {
  readonly clinicId: string;
  readonly currency: string;
  /** ISO timestamp of the entry (window bounds for balance rows). */
  readonly entryDate: string;
  readonly entryType: StatementEntryType;
  /** "" for balance rows. */
  readonly invoiceNumber: string;
  /** Human context: credit description, payment instrument+reference, Stripe refund id. "" when none. */
  readonly reference: string;
  /** Signed balance effect (positive = clinic owes more). Balance rows carry the balance itself. */
  readonly amountCents: number;
  /** Running balance after this entry. */
  readonly balanceCents: number;
}

const paramsSchema = z
  .object({
    from: z.date(),
    to: z.date(),
  })
  .strict()
  .refine((v) => v.from <= v.to, {
    message: "from must be <= to",
    path: ["from"],
  });

export type ClinicStatementParams = z.infer<typeof paramsSchema>;

const CREDIT_KINDS = [
  InvoiceLineKind.CREDIT,
  InvoiceLineKind.DISCOUNT,
  InvoiceLineKind.ADJUSTMENT,
] as const;

/**
 * Sort order for same-timestamp entries — charges before the money
 * that settles them; a credit application's PAYMENT_RECEIVED before
 * its CREDIT_BALANCE_APPLIED reversal (both share the command's
 * timestamp); CREDIT_GRANTED after PAYMENT_RECEIVED so an
 * overpayment reads "payment, then the excess became credit".
 */
const ENTRY_ORDER: Readonly<Record<StatementEntryType, number>> = {
  BALANCE_FORWARD: 0,
  INVOICE_ISSUED: 1,
  CREDIT_APPLIED: 2,
  PAYMENT_RECEIVED: 3,
  CREDIT_BALANCE_APPLIED: 4,
  CREDIT_GRANTED: 5,
  REFUND_ISSUED: 6,
  CLOSING_BALANCE: 7,
};

interface StatementEvent {
  readonly at: Date;
  readonly entryType: StatementEntryType;
  readonly invoiceNumber: string;
  readonly reference: string;
  /** Signed balance effect. */
  readonly amountCents: number;
  /** Stable tiebreak for deterministic CSV output. */
  readonly sortId: string;
}

interface Partition {
  readonly clinicId: string;
  readonly currency: string;
  openingCents: number;
  readonly events: StatementEvent[];
}

/** Safely pull a string field out of a JSON metadata blob. */
function metadataString(metadata: unknown, key: string): string {
  if (metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)) {
    const value = (metadata as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
  }
  return "";
}

export const clinicStatementReport: ReportDefinition<typeof paramsSchema, ClinicStatementRow> = {
  id: "clinic-statement",
  // v2: clinic-credit entries (CREDIT_GRANTED / CREDIT_BALANCE_APPLIED)
  // joined the statement — closing balances now reflect unapplied
  // credit, so v1 and v2 outputs are not comparable for clinics
  // holding credit.
  version: 2,
  title: "Clinic statement",
  description:
    "Statement-style payment history per clinic: balance forward, dated invoice / credit / payment / refund / clinic-credit entries with a running balance, closing balance. Unapplied clinic credit shows as a balance in the clinic's favor. One statement per clinic and currency.",
  parametersSchema: paramsSchema,
  parameterFields: [...dateRangeFields()],

  async run(ctx, params): Promise<ReportResult<ClinicStatementRow>> {
    const window: DateRangeParams = { from: params.from, to: params.to };
    const orgScope = {
      organizationId: ctx.organizationId,
      ...(ctx.clinicId !== undefined ? { clinicId: ctx.clinicId } : {}),
    };

    // ---- Source scans ----
    // Everything up to the window END: pre-`from` items feed the
    // balance forward, in-window items become entries. (Post-`to`
    // activity is irrelevant to this statement.)
    const [invoices, creditLines, ledgerRows, creditEntries] = await Promise.all([
      ctx.client.invoice.findMany({
        where: {
          ...orgScope,
          status: { in: [InvoiceStatus.OPEN, InvoiceStatus.PAID] },
          issuedAt: { not: null, lte: window.to },
        },
        select: {
          id: true,
          invoiceNumber: true,
          clinicId: true,
          currency: true,
          totalCents: true,
          issuedAt: true,
        },
      }),
      // NO upper date bound here: `totalCents` today is net of every
      // manual credit ever applied — including ones after `to` — so
      // the issued-total reconstruction must add back all of them.
      ctx.client.invoiceLine.findMany({
        where: {
          ...orgScope,
          kind: { in: [...CREDIT_KINDS] },
          amountCents: { lt: 0 },
          invoice: {
            status: { in: [InvoiceStatus.OPEN, InvoiceStatus.PAID] },
            issuedAt: { not: null },
          },
        },
        select: {
          id: true,
          invoiceId: true,
          clinicId: true,
          amountCents: true,
          description: true,
          billingEventKey: true,
          createdAt: true,
          invoice: { select: { invoiceNumber: true, currency: true, issuedAt: true } },
        },
      }),
      ctx.client.payment.findMany({
        where: { ...orgScope, occurredAt: { lte: window.to } },
        select: {
          id: true,
          clinicId: true,
          kind: true,
          method: true,
          amountCents: true,
          currency: true,
          occurredAt: true,
          stripeRefundId: true,
          metadata: true,
          invoice: { select: { invoiceNumber: true } },
        },
      }),
      // Clinic credit ledger: grants (−) and applications (+). The
      // application's paired PAYMENT_RECEIVED comes from the payment
      // scan above (method CREDIT_BALANCE).
      ctx.client.clinicCreditEntry.findMany({
        where: { ...orgScope, occurredAt: { lte: window.to } },
        select: {
          id: true,
          clinicId: true,
          kind: true,
          source: true,
          amountCents: true,
          currency: true,
          occurredAt: true,
          metadata: true,
          appliedToInvoice: { select: { invoiceNumber: true } },
        },
      }),
    ]);

    // Post-issue credit lines only — pre-issue credits are baked
    // into the invoice's issued total and must not double-count.
    const postIssueCredits = creditLines.filter(
      (line) => line.invoice.issuedAt !== null && line.createdAt > line.invoice.issuedAt
    );

    // Issued-total add-back per invoice: manual credits hit
    // `totalCents` retroactively; refund lines do not.
    const manualCreditAddBack = new Map<string, number>();
    for (const line of postIssueCredits) {
      if (line.billingEventKey?.startsWith("manual-credit:") === true) {
        manualCreditAddBack.set(
          line.invoiceId,
          (manualCreditAddBack.get(line.invoiceId) ?? 0) + Math.abs(line.amountCents)
        );
      }
    }

    // ---- Partition + accumulate ----
    const partitions = new Map<string, Partition>();
    const partitionFor = (clinicId: string, currency: string): Partition => {
      const key = `${clinicId}\u0000${currency}`;
      let partition = partitions.get(key);
      if (partition === undefined) {
        partition = { clinicId, currency, openingCents: 0, events: [] };
        partitions.set(key, partition);
      }
      return partition;
    };
    const accumulate = (
      clinicId: string,
      currency: string,
      at: Date,
      event: Omit<StatementEvent, "at">
    ): void => {
      const partition = partitionFor(clinicId, currency);
      if (at < window.from) {
        partition.openingCents += event.amountCents;
      } else {
        partition.events.push({ at, ...event });
      }
    };

    for (const inv of invoices) {
      // `issuedAt: { not: null }` in the query guarantees this.
      const issuedAt = inv.issuedAt as Date;
      const issuedTotal = inv.totalCents + (manualCreditAddBack.get(inv.id) ?? 0);
      accumulate(inv.clinicId, inv.currency, issuedAt, {
        entryType: "INVOICE_ISSUED",
        invoiceNumber: inv.invoiceNumber,
        reference: "",
        amountCents: issuedTotal,
        sortId: inv.id,
      });
    }

    for (const line of postIssueCredits) {
      if (line.createdAt > window.to) continue;
      accumulate(line.clinicId, line.invoice.currency, line.createdAt, {
        entryType: "CREDIT_APPLIED",
        invoiceNumber: line.invoice.invoiceNumber,
        reference: line.description,
        amountCents: -Math.abs(line.amountCents),
        sortId: line.id,
      });
    }

    for (const row of ledgerRows) {
      if (row.kind === PaymentKind.PAYMENT) {
        const instrument = metadataString(row.metadata, "instrument");
        const referenceNumber = metadataString(row.metadata, "referenceNumber");
        let reference: string;
        switch (row.method) {
          case PaymentMethod.MANUAL:
            reference = [instrument, referenceNumber].filter((s) => s !== "").join(" ");
            break;
          case PaymentMethod.STRIPE:
            reference = "Stripe";
            break;
          case PaymentMethod.CREDIT_BALANCE:
            reference = "Credit balance";
            break;
          default: {
            const _never: never = row.method;
            throw new Error(`unhandled payment method: ${String(_never)}`);
          }
        }
        accumulate(row.clinicId, row.currency, row.occurredAt, {
          entryType: "PAYMENT_RECEIVED",
          invoiceNumber: row.invoice.invoiceNumber,
          reference,
          amountCents: -row.amountCents,
          sortId: row.id,
        });
      } else {
        accumulate(row.clinicId, row.currency, row.occurredAt, {
          entryType: "REFUND_ISSUED",
          invoiceNumber: row.invoice.invoiceNumber,
          reference: row.stripeRefundId ?? "",
          amountCents: row.amountCents,
          sortId: row.id,
        });
      }
    }

    for (const entry of creditEntries) {
      switch (entry.kind) {
        case ClinicCreditEntryKind.GRANT: {
          const referenceNumber = metadataString(entry.metadata, "referenceNumber");
          accumulate(entry.clinicId, entry.currency, entry.occurredAt, {
            entryType: "CREDIT_GRANTED",
            invoiceNumber: "",
            reference: [entry.source ?? "", referenceNumber].filter((s) => s !== "").join(" "),
            amountCents: -entry.amountCents,
            sortId: entry.id,
          });
          break;
        }
        case ClinicCreditEntryKind.APPLICATION:
          // The +reversal of the stored credit; the invoice-side
          // settle is the paired PAYMENT_RECEIVED "Credit balance"
          // ledger row at the same instant. Net zero — the balance
          // already moved at grant time.
          accumulate(entry.clinicId, entry.currency, entry.occurredAt, {
            entryType: "CREDIT_BALANCE_APPLIED",
            invoiceNumber: entry.appliedToInvoice?.invoiceNumber ?? "",
            reference: "Credit balance",
            amountCents: entry.amountCents,
            sortId: entry.id,
          });
          break;
        default: {
          const _never: never = entry.kind;
          throw new Error(`unhandled clinic credit entry kind: ${String(_never)}`);
        }
      }
    }

    // ---- Render statements ----
    const orderedPartitions = [...partitions.values()]
      // A clinic with no opening balance and no in-window activity
      // has nothing to say — skip the empty statement.
      .filter((p) => p.openingCents !== 0 || p.events.length > 0)
      .sort((a, b) => {
        if (a.clinicId !== b.clinicId) return a.clinicId < b.clinicId ? -1 : 1;
        return a.currency < b.currency ? -1 : 1;
      });

    const rows: ClinicStatementRow[] = [];
    let entryCount = 0;
    let invoicedCents = 0;
    let creditedCents = 0;
    let paymentsReceivedCents = 0;
    let refundsIssuedCents = 0;
    let creditGrantedCents = 0;
    let creditBalanceAppliedCents = 0;
    let closingBalanceTotalCents = 0;

    for (const partition of orderedPartitions) {
      partition.events.sort((a, b) => {
        const t = a.at.getTime() - b.at.getTime();
        if (t !== 0) return t;
        const o = ENTRY_ORDER[a.entryType] - ENTRY_ORDER[b.entryType];
        if (o !== 0) return o;
        return a.sortId < b.sortId ? -1 : 1;
      });

      let balance = partition.openingCents;
      rows.push(
        Object.freeze({
          clinicId: partition.clinicId,
          currency: partition.currency,
          entryDate: window.from.toISOString(),
          entryType: "BALANCE_FORWARD" as const,
          invoiceNumber: "",
          reference: "",
          amountCents: balance,
          balanceCents: balance,
        })
      );

      for (const event of partition.events) {
        balance += event.amountCents;
        entryCount += 1;
        switch (event.entryType) {
          case "INVOICE_ISSUED":
            invoicedCents += event.amountCents;
            break;
          case "CREDIT_APPLIED":
            creditedCents += -event.amountCents;
            break;
          case "PAYMENT_RECEIVED":
            paymentsReceivedCents += -event.amountCents;
            break;
          case "REFUND_ISSUED":
            refundsIssuedCents += event.amountCents;
            break;
          case "CREDIT_GRANTED":
            creditGrantedCents += -event.amountCents;
            break;
          case "CREDIT_BALANCE_APPLIED":
            creditBalanceAppliedCents += event.amountCents;
            break;
          case "BALANCE_FORWARD":
          case "CLOSING_BALANCE":
            break;
          default: {
            const _never: never = event.entryType;
            throw new Error(`unhandled statement entry type: ${String(_never)}`);
          }
        }
        rows.push(
          Object.freeze({
            clinicId: partition.clinicId,
            currency: partition.currency,
            entryDate: event.at.toISOString(),
            entryType: event.entryType,
            invoiceNumber: event.invoiceNumber,
            reference: event.reference,
            amountCents: event.amountCents,
            balanceCents: balance,
          })
        );
      }

      closingBalanceTotalCents += balance;
      rows.push(
        Object.freeze({
          clinicId: partition.clinicId,
          currency: partition.currency,
          entryDate: window.to.toISOString(),
          entryType: "CLOSING_BALANCE" as const,
          invoiceNumber: "",
          reference: "",
          amountCents: balance,
          balanceCents: balance,
        })
      );
    }

    return Object.freeze({
      rows,
      aggregates: Object.freeze({
        statementCount: orderedPartitions.length,
        clinicCount: new Set(orderedPartitions.map((p) => p.clinicId)).size,
        entryCount,
        invoicedCents,
        creditedCents,
        paymentsReceivedCents,
        refundsIssuedCents,
        creditGrantedCents,
        creditBalanceAppliedCents,
        // Sum across statements — only meaningful for
        // single-currency orgs; per-statement closing balances are
        // on the CLOSING_BALANCE rows.
        closingBalanceTotalCents,
      }),
      window,
      generatedAt: ctx.asOf ?? new Date(),
    });
  },
};
