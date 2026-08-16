# 0039 — Cash-only fulfillment; no PBM adjudication, ever

- **Status:** Accepted
- **Date:** 2026-08-15
- **Deciders:** Product owner, pharmacy ops lead, Platform team
- **Tags:** `billing`, `scope`, `product`, `compliance`

## Context

Pharmax's billing domain has always been B2B: `Invoice`, `InvoiceLine`,
`PricingRule`, `Payment`, and `ClinicCreditEntry` describe clinic
invoicing settled through Stripe (ADR-0014). Nothing in the 103-model
schema knows about a payer. There is no BIN, PCN, group, copay, claim,
adjudication response, DUR segment, or reversal record anywhere.

`docs/GO_LIVE_PROGRAM.md` already frames this as _Track A_ (clinic-billed
/ cash-pay) versus a hypothetical _Track B_ (retail with third-party
insurance) and notes that Track B would add "+6 to 12 months" of
engineering plus 3–6 months of switch-contract calendar time. Two years
of audits and PRs have consistently read the absence of adjudication as
"not started yet" rather than as a scoping decision, because there is
no ADR that says otherwise.

This ADR is that record. The pharmacy is cash-only by design:
prescribing clinics (or the patient, through the clinic's own settlement)
pay Pharmax directly. NCPDP D.0 real-time claim processing is not
merely deferred — it is out of scope permanently.

## Decision

Pharmax fulfills prescriptions on a **cash / clinic-billed basis only**.
The `@pharmax/billing` domain — clinic invoices, per-clinic pricing,
dispense/shipping/rush fees, Stripe reconciliation — is the sole payment
model. NCPDP D.0 / PBM adjudication and everything downstream of it is
not built and not planned:

- **No payer model.** No `Payer`, `Plan`, `Formulary`, `BIN`, `PCN`,
  `Group`, `Copay`, `Claim`, `ClaimResponse`, `DurResponse`, or
  `Reversal` tables. New migrations that introduce any of these must be
  rejected as scope creep and pointed at this ADR.
- **No claim command surface.** No `SubmitClaim`, `ReverseClaim`,
  `AcceptClaimResponse`, `HandleDurAlert`, or equivalent commands. The
  bus contract (ADR-0007) is not extended for adjudication.
- **No switch integration.** No Change Healthcare / RelayHealth /
  equivalent adapter, no NCPDP D.0 parser, no B1/B2 request-response
  worker, no ePA workflow.
- **Pricing is what we charge, not what we can collect.** `PricingRule`
  produces the invoice amount. There is no allowed-amount / patient-
  responsibility split; the platform never asks "what will the plan pay?"

## Consequences

**Easier.** No vendor contract with a switch or PBM. No certification
cycle. No claims-lifecycle domain (submit / accept / reject / reverse /
reconcile) with its own retention and audit obligations. No PBM data
flow to enumerate in BAAs. No ePA queues, no rejection-reason mapping,
no copay accounting. The billing/reporting axis stays as-is — dispense
fee × quantity + carrier cost, invoiced to the clinic.

**Harder.** Pharmax cannot serve any customer whose business model
requires third-party billed retail pharmacy. Contract requests that
imply "we bill patients' insurance" must be declined at intake, not
scheduled. Reports built on adjudicated-price/reimbursement metrics do
not exist and will not be added.

**Ongoing.** Every PR that introduces payer/plan/copay/claim vocabulary
into schema, commands, RBAC permissions, or reports is a design
regression against this ADR. Reviewers should reject on sight. If the
business ever changes, this ADR is superseded by an explicit successor
that acknowledges the scope shift and prices the Track B work honestly
(the GO_LIVE_PROGRAM's 6–12 month estimate is the floor, not the ceiling).

## Alternatives Considered

- **Ship Track B in parallel** (add NCPDP D.0 as an opt-in module).
  Attractive because it opens the retail market. Rejected because no
  customer has been sold on Track B capability, the six-figure vendor
  cost plus two-quarter certification calendar are speculative
  investment, and the moment adjudication exists in the codebase every
  new command grows an "adjudicated variant" tax.
- **Passthrough integration** (route claims to a third-party billing
  service). Attractive because it externalizes the switch relationship.
  Rejected because the data-model changes to represent claim state
  (submit → response → reversal → reconciliation) are the majority of
  the work; the passthrough boundary saves the vendor contract but not
  the schema or the domain logic.
- **Silence** (leave the current de-facto cash-only posture undocumented).
  Attractive because it costs zero to change our mind later. Rejected
  because "we haven't done it yet" and "we will never do it" score the
  same on a readiness audit, and prospective customers, auditors, and
  new engineers repeatedly misread the absence as an unfinished feature.

## References

- Code: `packages/billing/**`, `apps/worker/src/billing/**` (Stripe
  adapters), `packages/orders/src/commands/**` (no claim commands)
- Migrations: `prisma/migrations/**` — grep for any of `payer`, `claim`,
  `adjudication`, `bin`, `pcn`, `copay` returns zero, and this ADR is
  the reason it must stay that way.
- Companion ADRs: `0014-stripe-ports-adapters-billing-sdk-free.md`,
  `0007-command-bus-twenty-step-contract.md`
- Product framing: `docs/GO_LIVE_PROGRAM.md` (Track A vs Track B); this
  ADR converts "Track B is deferred" into "Track B is not planned."
- Companion decision on the intake side: `0040-direct-connect-prescription-intake.md`
