// billing.clinic_credit.recorded.v1 — a clinic credit movement
// (grant or application) was appended to the clinic credit ledger.
//
// Producers (all in `@pharmax/billing`):
//   - `GrantClinicCredit` — GRANT entry (overpayment excess,
//     goodwill, other). Cash, if any, moved at grant time.
//   - `ApplyClinicCredit` — APPLICATION entry when stored credit
//     settles an OPEN invoice. Always paired with a
//     `billing.payment.recorded.v1` (method CREDIT_BALANCE) in the
//     same commit.
//
// `balanceAfterCents` is the clinic's (clinic, currency) credit
// balance after this entry — consumers can render "credit remaining"
// without re-summing the ledger. It is computed under the same
// clinic-row lock that serializes credit commands, so it is exact
// at commit time (though later entries supersede it).
//
// Consumers: future clinic-billing console credit widget, finance
// exports. (The clinic-statement report reads the
// `clinic_credit_entry` TABLE directly — CREDIT_GRANTED /
// CREDIT_BALANCE_APPLIED entries — not this event.)

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    clinicId: z.uuid(),
    creditEntryId: z.uuid(),
    kind: z.enum(["GRANT", "APPLICATION"]),
    /** GRANT entries only; null for APPLICATION. */
    source: z.enum(["OVERPAYMENT", "GOODWILL", "OTHER"]).nullable(),
    /** Always positive; direction comes from `kind`. */
    amountCents: z.number().int().min(1),
    currency: z.string().min(3).max(3),
    /** Clinic's (clinic, currency) credit balance after this entry. */
    balanceAfterCents: z.number().int().min(0),
    /** APPLICATION entries only: the invoice the credit settled. */
    appliedToInvoiceId: z.uuid().nullable(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const BillingClinicCreditRecordedV1 = defineEvent({
  name: "billing.clinic_credit.recorded",
  version: 1,
  aggregateType: "Clinic",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.clinicId,
  owner: "billing",
  retention: "7y",
  phiSafe: true,
  routingKey: "billing.clinic_credit",
  description:
    "Emitted when a clinic credit grant or application is appended to the clinic credit ledger. Amounts are always positive with direction in kind; balanceAfterCents is the post-entry (clinic, currency) balance.",
});

export type BillingClinicCreditRecordedV1Payload = z.infer<typeof payloadSchema>;
