# Go-Live Program

## 0. What this document is

> **Scope correction, 2026-08-17.** Every version of this document before
> today was written as though Pharmax **is** a pharmacy: it gave a
> pharmacist-in-charge veto authority over its own gates, put state
> pharmacy licensure and DEA registration on its own critical path, and
> planned a cutover that stages a paper downtime packet "physically in the
> pharmacy". That framing contradicted the security and compliance bundle,
> which has always been correct —
> [HIPAA SRA §1](./security/hipaa-security-risk-analysis.md): "Pharmax is
> a Business Associate under HIPAA. It processes ePHI on behalf of pharmacy
> customers." The consequence was not cosmetic: it produced a finish date
> dominated by licences Pharmax will never hold, and it hid the items that
> genuinely block a first customer. §0.1 states the model plainly so no
> future reader re-derives the old plan from this file.

### 0.1 Who Pharmax is, and what that means for this program

**Pharmax is a multi-tenant B2B software vendor and a HIPAA Business
Associate.** It sells a pharmacy operating platform to pharmacies. It
does not dispense, does not hold a pharmacy licence, does not hold a DEA
registration, and does not employ a pharmacist-in-charge.

The tenant pharmacy is the Covered Entity. It holds every licence and
registration, designates its own PIC, writes its own SOPs, trains its own
staff, and answers to its own board of pharmacy. Pharmax's obligation is
to be **software the tenant can pass an inspection with**, and to record
and enforce against the tenant's credentials — not to obtain them.

This single distinction moves a great deal:

| Concern                                                  | Before (wrong)                                   | Actual                                                                      |
| -------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------- |
| State pharmacy licence, DEA registration, PDMP enrolment | Pharmax obtains them — 2–6 months, critical path | The tenant's. Pharmax stores, validates and enforces against them.          |
| Pharmacist-in-charge                                     | Pharmax hires one; PIC vetoes gates              | The tenant's. Pharmax retains a pharmacist **clinical reviewer**.           |
| Operator SOPs, training, competency                      | Pharmax writes and delivers them                 | The tenant's quality system. Pharmax ships **templates** as enablement.     |
| Computer system validation (IQ/OQ/PQ)                    | Pharmax's PIC signs it                           | Pharmax produces the pack; the **tenant** validates and signs for its site. |
| SOC 2 Type II                                            | A compliance chore, late in the plan             | **The gate on revenue.** No pharmacy signs without it.                      |
| Definition of "live"                                     | Pharmax dispenses to a patient                   | A **tenant** dispenses to a patient **through** Pharmax.                    |

Two consequences worth stating explicitly, because they run in opposite
directions:

1. Roughly **3–5 months of pure calendar leaves the critical path** with
   licensure and DEA registration. Nothing replaces it.
2. The work does not disappear — it **relocates from company paperwork
   into product features**. Software that cannot record a tenant's licence
   number, or that lets a tenant ship into a state it holds no
   non-resident licence for, fails the tenant's inspection on Pharmax's
   behalf. That is Workstream G, rewritten.

### 0.2 Relationship to the implementation plan

`docs/IMPLEMENTATION_PLAN.md` records **what we have built**. This
document records **what must be true before a tenant pharmacy dispenses a
real prescription to a real patient through Pharmax**, and the order in
which to make it true.

The two differ more than they look. The implementation plan is organised
by capability and is largely complete: 111 command handlers, a traceable
`RECEIVED → SHIPPED` chain, RLS on 83 of 106 models, a live Multi-AZ
production cluster, and an executed point-in-time restore drill.
Go-live is organised by **risk to a patient, to the tenant's licence, and
to the trust a customer extends by sending us their PHI** — and by that
measure the platform is not close, for reasons that have nothing to do
with code quality.

The three headline blockers this document opened with in August 2026 have
all closed, and are retained here because the pattern matters: each was a
narrow gap at a seam, not a deficiency in the bulk of the system.

1. **There is no way to put a prescription into the system.** No
   `CreatePrescription` command exists. The only code in the repository
   that writes a `prescription` row is `scripts/seed-demo-orders.ts:305`.
2. **Nothing screens the prescription clinically.** PV1 has rejection
   reason codes for interaction, allergy and duplicate therapy, but
   nothing computes them. There is no drug knowledge base.
3. **Nothing pages anybody.** 14 of 18 production CloudWatch alarms have
   zero alarm actions because `alarm_sns_topic_arn` is `""` in
   `infra/terraform/environments/prod/us-east-1/terraform.tfvars`.

> **Status note (2026-08-06, at merge).** This document was drafted on
> 2026-08-02 and its facts are as of that date. All three headline
> blockers above have since closed on `main`: `CreatePrescription`
> exists with UI and v1 API surfaces (Workstream A); PV1 clinical
> screening runs against the RxNorm Prescribable Content release with
> hard-stop/acknowledge dispositions, allergy capture, compound-formula
> coverage, structured sig dose checks, and persisted findings
> (Workstream B core); and every production alarm routes to a
> severity-tiered SNS topic, enforced in CI by `check:alarm-actions`
> (item C1 — the paging-delivery test remains open). Checklist marks in
> the workstream tables have deliberately **not** been rewritten:
> a gate is passed by its named evidence artifact, not by edits to this
> file, and per-item status lives in the working tracker. The gate
> structure, D-1 scope decision, and evidence requirements remain the
> program of record.

Gates in this document are **blocking**. A gate is not passed because the
work "is basically done"; it is passed when the named evidence artifact
exists, is committed, and is signed.

### Audience and authority

| Role                      | Held by                 | Authority                                                                           |
| ------------------------- | ----------------------- | ----------------------------------------------------------------------------------- |
| Program owner             | Engineering lead        | Declares gates passed or failed                                                     |
| Clinical reviewer         | Licensed RPh (contract) | **Veto** on any gate that asserts clinical safety (B3, G2). Not a PIC.              |
| Security owner            | Engineering lead        | Owns Workstream E, signs pentest closure                                            |
| Compliance owner          | Engineering lead        | Owns Workstream F, signs auditor readiness                                          |
| Quality owner             | Engineering lead        | Owns the validation pack (H2) that tenants execute against                          |
| Design-partner pharmacist | The tenant's PIC        | **Veto** on G3 and G4 for their own site. Pharmax cannot overrule a customer's PIC. |

Two changes from earlier versions of this table, both material.

**Pharmax does not have a PIC, and does not need one.** What it needs is a
**licensed pharmacist under contract as clinical reviewer** to attest that
the screening logic, workflow policy and label content are clinically
sound. That is a part-time engagement, not a hire, and the distinction is
several months and a salary. The reviewer must not be the person who wrote
the code they are attesting to — segregation of duties is already modelled
in the command bus (`sodRules`) and must hold at the program level too.

**The PIC veto still exists, it just belongs to the customer.** The design
partner's pharmacist-in-charge decides whether their site goes live on
Pharmax, and no argument from this program overrides that. Practically
this is stronger than a veto held internally: a customer's PIC has no
incentive to approve software they do not trust.

On a solo-plus-agents team one person wears most of the internal hats.
That is acceptable for all of them; it is not acceptable for the clinical
reviewer, and it cannot substitute for the customer's PIC.

---

## 1. D-1 — the scope decision that governed everything (CLOSED)

> **Resolved 2026-08-15 by [ADR-0039](./adr/0039-cash-only-no-pbm-adjudication.md),
> status Accepted.** Pharmax is cash-only / clinic-billed by design. NCPDP
> D.0 real-time adjudication is **out of scope permanently**, not deferred.
> [ADR-0040](./adr/0040-direct-connect-prescription-intake.md), accepted the
> same day, settles the companion question: the partner API is the eRx path
> and Surescripts is not adopted, so NCPDP SCRIPT certification does not
> apply either.
>
> Between them these two decisions removed the entire Track B branch —
> 6–12 months of engineering plus 3–6 months of switch-contract calendar —
> and a further 3–6 months of e-prescribing certification. They are the
> largest timeline reductions in the program's history and they cost two
> afternoons of writing.
>
> Note for future readers: the ADR numbers do not match the ones this
> section originally demanded. It called for `0038-payer-model-scope.md`;
> 0038 went to an unrelated PV1 decision and the payer question landed at 0039. The decision is what binds, not the number. §12 is retained only
> as the record of what was rejected.

The analysis below is preserved because it explains _why_ the decision went
the way it did, and because a future pressure to reverse it should have to
argue with the original reasoning rather than a summary of it.

Nothing in the 85-model schema models a payer. There is no BIN, PCN,
group, copay, claim, or adjudication response anywhere. `Invoice`,
`InvoiceLine`, `PricingRule`, `Payment` and `ClinicCreditEntry` describe
**business-to-business clinic invoicing settled through Stripe**. That is
a deliberate, coherent design — and it is the design of a cash-pay or
clinic-billed pharmacy, not a retail one.

|             | Track A — clinic-billed / cash-pay                           | Track B — retail with insurance                                              |
| ----------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Business    | 503A/503B compounding, mail-order, clinic-ordered fulfilment | Third-party billed retail                                                    |
| Billing     | Existing B2B invoicing — already built                       | NCPDP Telecommunication D.0 adjudication — **not started**                   |
| Extra scope | None                                                         | Claims domain, switch contract, prior auth, copay, reversals, reconciliation |
| Added time  | —                                                            | +6 to 12 months                                                              |
| Schema fit  | Native                                                       | Requires a new bounded context                                               |

**This program plans Track A, permanently.** Track B is recorded in Annex
§12 as rejected scope, not as deferred work.

One nuance the original framing missed. Because Pharmax is a vendor rather
than a pharmacy, "cash-only" is a statement about **the product's billing
domain**, not about one pharmacy's business model. It means Pharmax sells
to cash-pay and clinic-billed pharmacies and does not serve
insurance-billed retail. That is a market-segmentation decision, and it
should be stated as one in sales material so a prospect is disqualified in
the first call rather than in month three of an implementation.

---

## 2. Gate model

Five gates. Each has exit criteria that are **artifacts, not opinions**.

| Gate   | Name                         | Meaning                                                                                        | Blocking veto                        |
| ------ | ---------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------ |
| **G0** | Scope locked, clocks started | Scope is decided and every calendar-bound clock is running                                     | Program owner                        |
| **G1** | Pilot feature-complete       | An operator can take an Rx from intake to shipped label without touching a script              | Program owner                        |
| **G2** | Validated and secure         | Pentest clean, validation pack produced, system proven under load, screening clinically signed | Clinical reviewer + Security owner   |
| **G3** | Sellable to a design partner | A customer may lawfully and safely send PHI: BAA executed, tenant credentials enforced         | Compliance owner + the partner's PIC |
| **G4** | Generally available          | Sellable without bespoke hand-holding; SOC 2 report in hand; normal on-call                    | Program owner + Compliance owner     |

G3 and G4 changed meaning in the 2026-08-17 correction and it is worth
being precise about how, because the old names survive in older documents.

**G3 was "first real patient, capped volume".** That is a _customer's_
milestone, and Pharmax cannot pass or fail it — the tenant's PIC decides
when their pharmacy dispenses. What Pharmax controls is whether it is
**lawful and safe for a customer to try**, which is a different and
sharper test: is there an executed BAA, can the platform record and enforce
the tenant's licences, and would an alarm wake someone. The volume cap and
abort criteria in §7–§8 still exist; they are now terms Pharmax _agrees
with_ the design partner rather than rules it imposes on itself.

**G4 was "volume caps removed".** For a vendor the meaningful threshold is
commercial: can you sell to a pharmacy that is not a hand-held design
partner, which in practice means a SOC 2 report and a pentest letter you
can hand to their compliance officer without an apology.

### Gate exit criteria

**G0 — Scope locked, clocks started**

- [x] Payer scope recorded as an ADR — closed by ADR-0039 and ADR-0040, 2026-08-15
- [ ] Pentest vendor under contract with a scheduled fieldwork window
- [ ] Drug-knowledge vendor in commercial conversation with a written quote, scoped as a **redistribution/OEM licence for ingredient-level content** (see B1)
- [ ] SOC 2 auditor engaged; Type I readiness date agreed
- [x] All BAAs in `docs/governance/baa-tracker.md` moved off `TBD` to `requested`, `executed`, or `N/A — justified` — done 2026-08-18. Only `Datadog or Honeycomb` remains `TBD`, and that is an unselected vendor rather than an unsigned agreement. **Note this criterion is weaker than F4**: moving off `TBD` is not executing, and EasyPost sits at `not requested` while receiving PHI
- [ ] Customer-facing BAA template with counsel — [`customer-baa-template.md`](./governance/customer-baa-template.md)
- [ ] Licensed pharmacist retained as clinical reviewer (contract, not hire)
- [ ] On-call rotation named, with a human who answers a phone

**G1 — Pilot feature-complete**

- [x] Workstream A complete: a prescription can be created through the UI and through the v1 API — A1, A2, A4, A5, A7 landed; **A3 typing workbench landed in #175** (`apps/web/app/ops/typing/[orderId]`). A6 document intake remains
- [ ] Workstream C1–C4 complete: alarms route to a pager; **print-agent runs in production** — C1 and C4 closed; C3 is the open one, `ecs_print_agent_desired_count` is still 0
- [x] Workstream D1 complete: an E2E test dispenses a synthetic order through the real UI — **landed in #174** (`e2e/tests/full-dispense.spec.ts`; the suite is now 3 specs / 13 cases)
- [ ] `pnpm verify` green; zero `Partial` SOC 2 controls newly introduced

**G2 — Validated and secure**

- [ ] Pentest final report received; **zero open Critical or High** findings (or formally risk-accepted by the Security owner and recorded in the risk register)
- [ ] IQ/OQ/PQ validation pack **produced and executable by a tenant** against their own site (H2)
- [ ] Load test demonstrates the documented NFRs with headroom (D2)
- [ ] DUR screening live and signed off by the **clinical reviewer** (B3)
- [ ] All three chaos drills executed with retained evidence (D4)
- [ ] Restore drill re-executed against a database containing real data volume (D5)
- [ ] Command-level integration harness proves the four-table transaction against real Postgres (D3)

**G3 — Sellable to a design partner**

Everything here is a Pharmax obligation. The partner's own licences, SOPs
and training are their responsibility and are **not** gates Pharmax can
pass — but Pharmax must be able to _evidence_ them, which is the
difference between the two lists below.

Pharmax must have:

- [ ] Customer BAA executed with the design partner, recorded in [`customer-baa-register.md`](./governance/customer-baa-register.md)
- [ ] Every upstream BAA `executed` — §164.502(e)(1)(ii) flow-down makes this a precondition of the clause above, not a parallel task
- [ ] Tenant credential capture and enforcement shipped: licence number and expiry, DEA registration, NPI, NCPDP/NABP, and ship-to-state restriction (G-1, G-2)
- [ ] Print path proven end to end from production on the partner's hardware (C3)
- [ ] Validation pack, SOP templates and training material delivered to the partner (H1, H2, H3)
- [ ] Volume cap and abort criteria **agreed in writing with the partner** (§7, §8)
- [ ] Support model live: named on-call, escalation path, pharmacist-reachable channel (H7)

The partner must have (Pharmax verifies and records, does not obtain):

- [ ] Pharmacy licence current for its state, and non-resident licences for every state it ships into
- [ ] DEA registration current for the schedules it dispenses
- [ ] PDMP enrolment where applicable
- [ ] Its PIC's written approval to go live on Pharmax

**G4 — Generally available**

- [ ] 30 consecutive days at G3 with no SEV0/SEV1 attributable to Pharmax
- [ ] SOC 2 Type I report issued; Type II observation window running
- [ ] Auditor readiness checklist (`docs/compliance/auditor-readiness-checklist.md`, 48 items) fully checked
- [ ] Error budget policy in force and not exhausted
- [ ] Onboarding runbook exercised by someone who did not build the platform — the test of whether G3 needed hand-holding

---

## 3. How to read the workstream tables

Every task carries an ID, an acceptance criterion that a third party
could check, the evidence artifact it produces, its dependencies, and an
estimate in **engineer-weeks at the velocity this repository has actually
demonstrated** (52 commits and four substantial feature slices in the
week of 2026-07-27). Where a task is bounded by somebody else's clock,
the estimate is marked **[calendar]** and adding capacity will not
shorten it.

---

## 4. Workstreams

### Workstream A — Intake: closing the front door

**Objective.** Make it possible to enter a prescription into Pharmax
through a supported, audited, permission-checked path.

**Why it blocks.** Everything downstream already works. This is the
narrowest point in the entire funnel and it is at the very front. Until
it is closed, Pharmax cannot process a prescription at all, and the
controlled-substance authorisation validator that already exists
(`validateControlledPrescriptionAuthorization`) has no caller — so an
over-authorised CII prescription is caught at dispensing rather than at
writing, which is the wrong end of the process.

| ID  | Task                               | Acceptance criteria                                                                                                                                                  | Evidence                 | Depends on | Est.   |
| --- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ---------- | ------ |
| A1  | `CreatePrescription` command       | Spec in §4.A.1 satisfied; unit tests cover every declared error code; CS authorisation validated at issuance                                                         | Merged PR + tests        | —          | 1.5 wk |
| A2  | `POST /api/v1/prescriptions`       | Partner scope `prescriptions.create`; caller `Idempotency-Key` required; OpenAPI updated; contract tests                                                             | Merged PR + OpenAPI diff | A1         | 0.5 wk |
| A3  | Typing workbench                   | `/ops/typing/[orderId]` captures and corrects prescription data; `CompleteTypingReview` refuses an order whose lines carry unverified intake                         | Merged PR + E2E test     | A1         | 1.5 wk |
| A4  | Rx number allocation               | Per-`(organizationId, clinicId)` monotonic allocation; collision-safe under concurrency; integration test proves no duplicates under parallel load                   | Integration test         | A1         | 0.5 wk |
| A5  | Refill dispensing                  | `DispenseRefill` decrements `refillsRemaining` atomically under row lock; CS refill caps enforced; no refill past `expiresAt`                                        | Merged PR + tests        | A1         | 1 wk   |
| A6  | Document intake                    | Fax/PDF/image attached to an order via `@pharmax/documents`; classified; visible on order detail                                                                     | Merged PR                | —          | 1 wk   |
| A7  | Fix `ORDER_PRESCRIPTION_NOT_FOUND` | The constant is declared in `create-order.ts` but never thrown — the prescription lookup throws `ORDER_PRESCRIPTION_MISMATCH` instead. Either throw it or delete it. | Merged PR                | —          | 0.1 wk |

#### §4.A.1 — `CreatePrescription` specification

This is the highest-leverage single piece of work in the program. It is
specified precisely so it can be built without re-deriving the seams.

**Location.** `packages/orders/src/commands/create-prescription.ts`.
Placed in `@pharmax/orders` rather than a new package because
`Prescription` is already the aggregate that `AddPrescription` and
`CreateOrder` read, and `scripts/check-command-files.ts` only inspects
`packages/*/src/commands/` — a new location would silently escape the
guard.

**Shape.** Follow `packages/orders/src/commands/create-order.ts` exactly:

```ts
export const CreatePrescription = defineCommand<CreatePrescriptionInput, CreatePrescriptionOutput>({
  name: "CreatePrescription",
  inputSchema,
  permission: PERMISSIONS.PRESCRIPTIONS_CREATE,
  // No lockTarget: the prescription does not exist yet and this
  // command does not transition an order.
  redactFields: ["sig", "noteToPharmacist", "noteToPatient", "indication"],
  async exec(input, ctx) {
    /* ... */
  },
});
```

`redactFields` is **not optional here**. `sig` is PHI and
`command_log` persists the command payload; omitting it would write
plaintext directions into an audit table. This is the single most likely
way to fail the `no PHI in logs` rule while believing the opposite.

**Input schema.** `clinicId`, `patientId`, `providerId`, `drugNdc`,
`drugName`, optional `drugStrength` / `drugForm`, `quantityAuthorized`,
`daysSupply`, `refillsAuthorized`, `originalDateWritten`, `expiresAt`,
optional `daw`, optional `earliestFillDate`, `sig`, and optional
`noteToPharmacist` / `noteToPatient` / `indication`. `.strict()`.

`rxNumber` is **not** an input — it is allocated by A4 so a caller cannot
choose one and collide with, or overwrite, another clinic's numbering.
`refillsRemaining` is **not** an input — it is initialised to
`refillsAuthorized`; accepting it would let a caller create a
prescription that has already been partly dispensed.
`controlledSubstanceSchedule` is **not** an input — see below.

**Encryption.** `sigEnc` is required and must be produced with the same
binding shape the seed uses, so the ciphertext is bound to the tenant,
table, column and row:

```ts
const prescriptionId = randomUUID();
const sigEnc = await encryptField({
  plaintext: input.sig,
  binding: {
    tenantId: ctx.organizationId,
    table: "prescription",
    column: "sig",
    recordId: prescriptionId,
  },
});
```

The id must be generated **before** encryption because it is part of the
binding. The three optional note fields follow the same pattern with
their own `column` values.

**Blind index.** `rxNumberBi` uses the registered binding in
`packages/database/src/phi/blind-index-purposes.ts`
(`PRESCRIPTION_BLIND_INDEX_BINDINGS.rxNumber`) and carries **no
`recordId`** — a blind index must be equal across rows for the same
value or search cannot work.

**Controlled-substance snapshot — a defect to fix, not just a field to
copy.** `prescription.controlledSubstanceSchedule` is documented in
ADR-0037 as a point-in-time snapshot so that rescheduling a substance
does not retroactively change the rules governing an already-written
prescription. The seed script does not set it, so every demo prescription
silently defaults to `NON_CONTROLLED`. `CreatePrescription` must resolve
it from the catalog:

1. Look up `Product` by `(organizationId, drugNdc)`.
2. If no product row exists, throw `PRESCRIPTION_PRODUCT_NOT_FOUND` —
   dispensing a drug the catalog does not know is not something to
   default your way through.
3. Copy `product.controlledSubstanceSchedule` onto the prescription.

**Issuance-time validation.** Call
`validateControlledPrescriptionAuthorization({ schedule, refillsAuthorized })`
from `@pharmax/controlled-substances` and reject on failure with
`PRESCRIPTION_CS_AUTHORIZATION_INVALID`, surfacing every returned
violation code in the error metadata. This closes the gap ADR-0037 flags
as "still unwired at issuance". Note the Schedule V asymmetry the module
already pins by test: `federalRefillCap(CV)` returns `null`, not `5`.

**Scope cross-checks.** In one `findFirst` each, scoped to
`ctx.organizationId`: patient belongs to `clinicId`; provider is `ACTIVE`
in the org. Mirror `create-order.ts`'s reasoning — a cross-clinic id
returns a fixable typed error, not a silent success.

**Declared error codes.** `PRESCRIPTION_CLINIC_NOT_FOUND`,
`PRESCRIPTION_PATIENT_NOT_FOUND`, `PRESCRIPTION_PATIENT_CLINIC_MISMATCH`,
`PRESCRIPTION_PROVIDER_NOT_FOUND`, `PRESCRIPTION_PROVIDER_INACTIVE`,
`PRESCRIPTION_PRODUCT_NOT_FOUND`,
`PRESCRIPTION_CS_AUTHORIZATION_INVALID`,
`PRESCRIPTION_EXPIRY_BEFORE_WRITTEN`, `PRESCRIPTION_RX_NUMBER_CONFLICT`.
Every declared code must be reachable — see A7 for the precedent of one
that is not.

**Return value.**

```ts
return {
  output: { prescriptionId, rxNumber, controlledSubstanceSchedule },
  audit: {
    action: "prescription.created",
    resourceType: "Prescription",
    resourceId: prescriptionId,
    metadata: {
      prescriptionId,
      clinicId,
      patientId,
      providerId,
      drugNdc,
      controlledSubstanceSchedule,
      refillsAuthorized,
      daysSupply,
    },
  },
  emits: [
    {
      eventType: "prescription.created.v1",
      aggregateType: "Prescription",
      aggregateId: prescriptionId,
      payload: {/* ids + schedule + counts only */},
    },
  ],
};
```

Audit metadata and event payload carry **ids and non-identifying scalars
only**. `drugNdc` is included because `AddPrescription` already
establishes that drug identity in an id-keyed payload is acceptable and
downstream consumers join for the rest; `sig` and the notes never appear
in either.

**Registration checklist — five places, all required.**

1. `packages/rbac/src/permissions.ts` — add `PRESCRIPTIONS_CREATE: "prescriptions.create"` **and** the matching `PERMISSION_METADATA` entry.
2. `packages/rbac/src/role-templates.ts` — grant to `PharmacyTechnician` and `Pharmacist`; **not** to `ClinicViewer`.
3. `prisma/seed.ts` — add the permission row, or the seed-fixture check fails.
4. `packages/events/src/events/prescription/created-v1.ts` — `defineEvent` with `owner: "orders"`, `retention: "7y"`, `phiSafe: true`, `aggregateType: "Prescription"`.
5. `packages/events/src/registry.ts` — import and append to `ALL_DEFINITIONS`, plus the domain barrel export.

`pnpm events:validate` and `pnpm check:seed` will fail loudly if any step
is missed. Run `pnpm verify` before opening the PR.

---

### Workstream B — Clinical safety

**Objective.** Ensure no prescription reaches a patient without
automated clinical screening.

**Why it blocks.** This is the difference between a fulfilment workflow
and a pharmacy system. A pharmacist verifying PV1 without interaction,
allergy and duplicate-therapy screening is doing so unaided. The
**tenant's** board inspector will ask which knowledge base the software
uses, and the customer's clinical leadership will ask before signing.
There is no defensible answer that is "none" — and because Pharmax is the
vendor, "our customer decided that" is not available either.

**What the compounding model changes, and what it does not.** A frequent
and reasonable objection is that if most dispensed preparations are
compounded in-house, there are no manufactured products for a drug
database to match. That reasoning does not hold — knowledge bases screen
**ingredients**, not products, and compounded preparations are made of
ingredients. But it arrives at a partly correct conclusion by luck, and
the real position is better than the objection assumes:

- `CompoundFormulaIngredient.rxnormInRxcui` already carries RxNorm
  ingredient (IN) concepts, in the same code space
  `patient_allergy.substanceCode` uses under `substanceCodeSystem =
RXNORM`, compared by string equality in the PV1 allergy screen. So
  **exact-ingredient allergy and duplicate-ingredient screening on
  compounded preparations work today with no licensed content**, because
  the formulas are coded in-house. For a compounder that is the
  highest-frequency axis and it is already owned outright.
- **Interactions still require a licence, and matter more, not less.**
  Compounded preparations are multi-API by design, so the interaction
  surface within a single preparation is combinatorial; and the patient's
  other medications are commercial drugs prescribed elsewhere, so one side
  of every interaction pair needs commercial content regardless of what is
  dispensed. This is the one axis where an in-house table is indefensible.
- **Dose range inverts: build, do not buy.** For a manufactured product
  the package insert bounds the dose. For a compounded preparation there is
  no FDA-approved dose — the formula _is_ the dose decision. A generic
  min/max-daily-dose file is a poor fit; per-formula limits authored on
  `CompoundFormula` (which already models `finalStrength`, quantity, unit
  and BUD policy) encode the reviewing pharmacist's judgement for the
  actual preparation. Tracked as B7.

| ID  | Task                           | Acceptance criteria                                                                                                                                                                                                                                                                                                        | Evidence                               | Depends on | Est.                   |
| --- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ---------- | ---------------------- |
| B1  | Drug knowledge licence         | Signed licence covering **ingredient-level interactions and allergen cross-sensitivity, keyed to RxNorm ingredient concepts, redistributed to N pharmacy tenants**. Not the NDC-keyed dispensing file, AWP/WAC pricing, or OTC/nutraceutical catalogue. BAA executed if PHI crosses the boundary                           | Contract + BAA row                     | G0         | **[calendar] 4–12 wk** |
| B2  | `@pharmax/drug-knowledge` port | Adapter interface with a deterministic in-repo fake; no vendor SDK imported outside the package; vendor data version recorded on every screening result                                                                                                                                                                    | Merged PR + ADR                        | B1         | 2 wk                   |
| B3  | DUR engine at PV1              | Interaction, allergy, duplicate-therapy and dose-range screening run before `ApprovePV1`; each alert requires pharmacist acknowledgement with a reason; alerts persisted immutably with the knowledge-base version                                                                                                         | Merged PR + clinical-reviewer sign-off | B2, A1     | 2 wk                   |
| B4  | Patient allergy capture        | Allergy list on `Patient`, encrypted, editable through a command; allergy screening cannot silently pass on an empty list — absence must be an explicit "no known allergies" attestation                                                                                                                                   | Migration + PR                         | —          | 1 wk                   |
| B5  | Counseling record              | Offer-to-counsel recorded per dispense; refusal captured; visible on order timeline                                                                                                                                                                                                                                        | Migration + PR                         | —          | 0.5 wk                 |
| B6  | Med guides + auxiliary labels  | FDA Medication Guide attached where required; auxiliary warning label rules driven by the knowledge base rather than hand-maintained                                                                                                                                                                                       | Merged PR                              | B2         | 1 wk                   |
| B7  | Per-formula dose limits        | Min/max dose and daily-dose limits authored on `CompoundFormula`, versioned with the formula, enforced at PV1 alongside the licensed dose-range axis; reviewing pharmacist recorded on the limit                                                                                                                           | Migration + PR + reviewer sign-off     | —          | 1 wk                   |
| B8  | Compensating control until B1  | Until interaction content is licensed, `SCR_KNOWLEDGE_UNAVAILABLE` becomes a **documented** compensating control: a written procedure requiring the verifying pharmacist to check a named external reference, shipped to tenants as an SOP template. Without this the gap is an unmanaged risk rather than an accepted one | SOP template + risk entry              | —          | 0.3 wk                 |

> **Sequencing note.** B1 is the longest pole in Track A and is pure
> calendar. Start the vendor conversation in Week 1 even though no code
> depends on it until Week 6. Every week of delay here moves G2.

---

### Workstream C — Production operations

**Objective.** Make production observable, reachable, and recoverable by
a human at 3am.

**Why it blocks.** The cluster is live and healthy today —
`web` 3/3, `worker` 3/3, Aurora 16.4 Multi-AZ available, ALB targets
healthy. That is exactly the condition under which a silent failure is
most dangerous, because nothing is watching.

| ID  | Task                                     | Acceptance criteria                                                                                                                                                                                                                                                                                                                                                                              | Evidence                                           | Depends on | Est.   |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- | ---------- | ------ |
| C1  | Alarm routing                            | SNS topic created; `alarm_sns_topic_arn` set in prod and staging tfvars; **all 18 alarms show ≥1 action**; a deliberately tripped test alarm reaches a phone                                                                                                                                                                                                                                     | `describe-alarms` output showing zero `actions: 0` | —          | 0.5 wk |
| C2  | SLOs + error budget                      | Availability, queue-read p95, and command-latency SLOs written into `docs/ARCHITECTURE_PRINCIPLES.md`; burn-rate alerts wired; error-budget policy states what stops shipping                                                                                                                                                                                                                    | Merged PR                                          | C1         | 0.5 wk |
| C3  | Print agent in production                | `ecs_print_agent_desired_count > 0`; AWS KMS adapter path verified (not `LocalKmsAdapter`); a physical Zebra printer produces a correct vial label from production                                                                                                                                                                                                                               | Photo + `PrintJob` record                          | —          | 1 wk   |
| C4  | Verify compliance jobs actually run      | Confirm `DAILY_AUDIT_CHAIN_VERIFIER_ENABLED=true` and the Merkle signer env vars are present in the **running** prod worker task definition. `docs/RUNBOOK.md` claims "there is currently no scheduled chain check" while `apps/worker/src/security/audit-chain-verifier-loop.ts` exists — one of the two is wrong and the alarm `pharmax-prod-ue1-audit-chain-integrity` depends on the answer. | Task-def env diff + runbook correction             | —          | 0.3 wk |
| C5  | Access-review evidence to S3 Object Lock | Replace `FilesystemEvidencePublisher` in production; the job currently warns and falls back. Evidence must be immutable to be evidence.                                                                                                                                                                                                                                                          | Merged PR + object-lock verification               | —          | 0.5 wk |
| C6  | DR region + failover rehearsal           | Real `backend.tf` for `prod/us-west-2` replacing the `REPLACE_…` placeholder; documented RTO/RPO; a rehearsed (not merely documented) regional failover                                                                                                                                                                                                                                          | Drill evidence pack                                | —          | 1.5 wk |
| C7  | Secret rotation                          | Rotation lambdas replace the TODO; rotation exercised once per secret class without downtime                                                                                                                                                                                                                                                                                                     | Rotation run log                                   | —          | 1 wk   |
| C8  | `incident_log` table                     | `scripts/soc2/export-incident-log.ts` currently emits `incident-log-stub.txt` because no structured incident table exists. Model it, write it through a command, and make the exporter real.                                                                                                                                                                                                     | Migration + PR + non-stub export                   | —          | 1 wk   |

---

### Workstream D — Quality engineering

**Objective.** Prove the system works end to end and under load, not
just unit by unit.

**Why it blocks.** 3,795 unit tests pass in 7.7 seconds — which is
excellent and also tells you they are mocked. There are 61 integration
tests, zero browser tests, and zero load tests. The eleven-command
`RECEIVED → SHIPPED` chain has never been executed through the actual
UI by anything other than a human.

| ID  | Task                         | Acceptance criteria                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Evidence                                      | Depends on | Est.   |
| --- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------- | ------ |
| D1  | E2E suite                    | Playwright in CI against a seeded stack; the golden path (intake → typing → PV1 → fill → label → final → ship) passes headless; also covers PV1 rejection, hold/release, and cancellation                                                                                                                                                                                                                                                                                                                                                                                                                  | Green CI job                                  | A1, A3     | 2 wk   |
| D2  | Load + soak                  | Documented NFRs (orders/day, concurrent operators, queue-read p95) then k6 proving them with headroom; 24-hour soak with no leak or lock escalation; **row-lock contention on the hot order path measured explicitly**                                                                                                                                                                                                                                                                                                                                                                                     | Load report                                   | C2         | 1.5 wk |
| D3  | Command integration harness  | **The highest-leverage engineering task in the program.** A harness that dispatches real command handlers against real Postgres and asserts `command_log`, `order_event`, `audit_log` and `event_outbox` commit in one transaction — and roll back together on failure. Today 0 of 111 handlers are exercised this way: the unit tests use a fake whose `$transaction` is `fn => fn(tx)`, so the central architectural invariant is asserted thousands of times and proven zero times. Cover every command that writes `order_event`, plus concurrent dispatch on one order and duplicate idempotency keys | Coverage delta + harness                      | —          | 2 wk   |
| D4  | Execute the chaos drills     | All three scenarios in `docs/operations/chaos-drills.md` run for real: printer outage, queue backpressure, Stripe outage. Tooling exists; execution does not.                                                                                                                                                                                                                                                                                                                                                                                                                                              | Evidence packs under `evidence/chaos-drills/` | C1, C3     | 0.5 wk |
| D5  | Restore drill at real volume | Re-run the restore drill against a database with production-scale data. The 2026-07-23 drill was clean but **vacuous — zero organizations, zero orders**; it proved the mechanism, not the timing.                                                                                                                                                                                                                                                                                                                                                                                                         | Drill evidence pack                           | —          | 0.5 wk |
| D6  | Migration rehearsal          | Every migration replayed against a prod-sized dataset with lock-time measured; any migration holding an exclusive lock beyond the agreed budget is rewritten                                                                                                                                                                                                                                                                                                                                                                                                                                               | Rehearsal log                                 | D5         | 0.5 wk |

---

### Workstream E — Security

| ID  | Task                  | Acceptance criteria                                                                                                                                                                                                                                                                                                                              | Evidence                                 | Depends on | Est.                   |
| --- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- | ---------- | ---------------------- |
| E1  | Pentest fieldwork     | Engagement executed per `docs/compliance/pentest-engagement-plan.md`, which states a realistic 7–10 week end-to-end calendar                                                                                                                                                                                                                     | Final signed report                      | G0         | **[calendar] 7–10 wk** |
| E2  | Remediation           | Zero open Critical/High; Mediums either fixed or risk-accepted in the register with an owner and a date; retest letters obtained                                                                                                                                                                                                                 | Updated `pentest-remediation-tracker.md` | E1         | 1–3 wk                 |
| E3  | OIDC SSO              | ADR-0036 slice 2: org-scoped issuer/client config, authorization code + PKCE, verified-email linking to existing active users only, no JIT provisioning                                                                                                                                                                                          | Merged PR                                | —          | 1.5 wk                 |
| E4  | Threat model          | A standalone STRIDE model per trust boundary. Today threat identification lives inside the HIPAA SRA and the risk-assessment procedure; an auditor will ask for the artifact by name.                                                                                                                                                            | `docs/security/threat-model.md`          | —          | 0.5 wk                 |
| E5  | Break-glass rehearsal | `docs/compliance/break-glass-runbook.md` executed in production against a synthetic tenant; `BreakGlassSession` and `BreakGlassAction` rows verified; access auto-expires                                                                                                                                                                        | Rehearsal evidence                       | —          | 0.3 wk                 |
| E6  | Risk register refresh | R-004 still describes "Clerk account takeover" although Clerk is retired (`baa-tracker.md` shows `terminated`, no `@clerk/*` dependency remains). Retire it, and add the new risks in §9. Also remove the dead `"@clerk/shared": set this to true or false` placeholder in `pnpm-workspace.yaml:107` and the orphaned `ClerkWebhookEvent` model. | Updated register + cleanup PR            | —          | 0.5 wk                 |

---

### Workstream F — Compliance

**Objective.** Be able to hand **an auditor or a prospect's security
reviewer** a folder and answer questions from evidence rather than memory.

The second audience is the one the vendor correction adds, and it changes
the priority rather than the content. An auditor arrives once a year by
appointment; a prospect's compliance officer arrives in the middle of every
sales cycle and can end it. That is why F3 moved from a late compliance
chore to the constraint on G4, and why F9 exists.

The machinery here is genuinely good and mostly needs finishing, not
building: a TSC control matrix with real control IDs, a HIPAA Security
Risk Analysis, a control matrix mapping §164.308/310/312, and a
quarterly evidence pack orchestrator producing SHA-256 manifests.

| ID  | Task                                        | Acceptance criteria                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Evidence                                                                                                                                                     | Depends on | Est.                   |
| --- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | ---------------------- |
| F1  | ~~Ratify the policies~~ **DONE 2026-08-18** | Closed by #200: the governance bundle carries real effective dates, `Last reviewed` / `Next review`, and version 1.0. The nine `docs/soc2/policies/` stubs were deliberately **not** adopted — adopting a stub asserts a control with no text behind it, which is worse than an unadopted policy. F3 is therefore unblocked.                                                                                                                                                                                                                                                                                                                  | Adopted bundle, effective 2026-08-18                                                                                                                         | —          | ✅ 0                   |
| F2  | Close the `Partial` controls                | `CC1.2-1`, `CC2.3-1`, `CC7.2-3`, `CC7.5-1`, `A1.2-2`, `A1.3-1`, `P1.1-1`, `P4.1-1` moved to `Implemented` with evidence, or formally scoped out                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Updated `controls-inventory.md`                                                                                                                              | C1–C8      | 1.5 wk                 |
| F3  | SOC 2 Type I → Type II                      | Type I report issued, then the observation window opened                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Auditor report                                                                                                                                               | F1, F2, E2 | **[calendar] 3–12 mo** |
| F4  | Execute BAAs                                | **Effectively closed by scope change, pending two facts.** AWS and Sentry `executed`. **EasyPost is being retired rather than signed (2026-08-17)** — it was the last blocker on F8 §3.4, and removing the counterparty closes it more cleanly than a signature would. FedEx and UPS replace it directly on a **conduit determination** (HHS FAQ #245, tenant-owned credentials), so they add no obligation. What remains is not paperwork: (a) the EasyPost integration must be **off in production**, and (b) **counsel must concur** on the conduit determination. Resend blocks only if patient notifications carry identifiers. See G-8. | `baa-tracker.md`: every PHI-receiving row `executed` or retired; counsel concurrence on file                                                                 | —          | **1 wk + counsel**     |
| F5  | Workforce training                          | `docs/governance/security-training-program.md` delivered and attested by every person with production access                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Attestation records                                                                                                                                          | —          | 0.3 wk                 |
| F6  | Auditor readiness checklist                 | All 48 items in `docs/compliance/auditor-readiness-checklist.md` checked                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Completed checklist                                                                                                                                          | F1–F5      | 0.5 wk                 |
| F7  | HIPAA §164.316 + breach procedure           | Add an explicit §164.316 documentation-retention row to the control matrix (currently mapped mainly to §164.530(j)), and a state-by-state breach notification procedure                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Updated docs                                                                                                                                                 | —          | 0.5 wk                 |
| F8  | **Customer-facing BAA**                     | The agreement Pharmax signs **as** Business Associate with each pharmacy, reviewed and issued by counsel; every §7 precondition in the template true before first signature; executed agreements recorded in the register, which gates tenant provisioning                                                                                                                                                                                                                                                                                                                                                                                    | [`customer-baa-template.md`](./governance/customer-baa-template.md) + [`customer-baa-register.md`](./governance/customer-baa-register.md) + counsel sign-off | F4         | **[calendar] 1–3 wk**  |
| F9  | Customer security-review pack               | The folder a prospect's compliance officer asks for, assembled once rather than per deal: pentest letter, SOC 2 report or bridge letter, SRA summary, subprocessor list, architecture and data-flow summary, BAA. Reusable across every sale                                                                                                                                                                                                                                                                                                                                                                                                  | Assembled pack                                                                                                                                               | E2, F3     | 0.5 wk                 |

---

### Workstream G — Tenant regulatory enablement

> **This workstream was rewritten on 2026-08-17.** It previously read
> "Pharmacy regulatory — be legally permitted to dispense", and listed
> obtaining a state pharmacy licence and a DEA registration as Pharmax
> tasks with a 2–6 month calendar. Those are the **tenant's** obligations
> and cannot be transferred to a vendor. Removing them takes roughly 3–5
> months off the critical path.
>
> The work does not vanish, it inverts. Pharmax's obligation is to be
> software a licensed pharmacy can operate **and prove it operated
> lawfully**: to record the tenant's credentials, enforce the limits those
> credentials impose, and produce the records an inspector asks for. None
> of that existed when this was written, because the plan was watching the
> wrong side of the boundary.

**Objective.** Make it possible for a licensed pharmacy to run its
regulated operation on Pharmax, and to evidence compliance to its own
board of pharmacy and to the DEA.

**Why it blocks.** A pharmacy cannot adopt software that has nowhere to
record its licence, cannot stop it shipping into a state it is not
licensed in, and cannot produce a perpetual inventory. Today
`PharmacySite` carries name, code, timezone, address and phone and no
credential fields at all; `deaNumber` and `npi` exist only on `Provider`,
the prescriber. There is no ship-to-state restriction anywhere in `apps`
or `packages`. These are product gaps that surface as the customer's
inspection finding, which makes them Pharmax's commercial problem.

| ID  | Task                                   | Acceptance criteria                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Depends on            | Est.   |
| --- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- | ------ |
| G-1 | Tenant credential model                | `PharmacySite` records state licence number and expiry, DEA registration and expiry, NPI, and NCPDP/NABP identifier, through a command with audit; expiry surfaces a warning before lapse and blocks on lapse                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Migration + PR        | 1.5 wk |
| G-2 | Ship-to-state licensure enforcement    | A site declares the states it is licensed to dispense into; `PurchaseShipmentLabel` and release-to-ship refuse a destination outside that set with a typed error; the check is enforced server-side, not in the UI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | PR + tests            | 1 wk   |
| G-3 | PDMP submission on the tenant's behalf | Per-state format and cadence; submitted under the **tenant's** PDMP credentials held in a credential store, never Pharmax's; submission failure alarms and is visible to the tenant                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | PR + runbook          | 2 wk   |
| G-4 | Controlled-substance recordkeeping     | 21 CFR 1304 perpetual inventory for CII derived from operational truth; biennial inventory report; DEA 222/CSOS receipt capture. Pharmax produces the record; the tenant files it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | PR                    | 2 wk   |
| G-5 | USP 795/797/800 SOP **templates**      | SOP templates aligned to the shipped `CompoundFormula` / `CompoundingRecord` models, BUD policy and hazardous-drug handling, written for a tenant to adopt and edit. Enablement content, not Pharmax's own SOPs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Template pack         | 1 wk   |
| G-6 | DSCSA verification                     | Extend the existing `DscsaTransaction` receipt model with saleable-return verification and suspect-product quarantine                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | PR                    | 1.5 wk |
| G-7 | Inspection-readiness reporting         | A tenant can produce, unaided, the reports an inspector asks for: dispensing log by date range, CS perpetual inventory, label reprint log with reasons, verification audit trail, and access history                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | PR                    | 1 wk   |
| G-8 | Retire the EasyPost integration        | **Gates F4 and therefore F8.** Stop offering `ShippingProvider.EASYPOST`: unregister the factory so no tenant can hold an ACTIVE EasyPost credential, and drop `USPS` / `DHL` from the offered `ShipmentCarrier` set — both were reachable only through the aggregator and neither has a direct adapter. **Deprecate, do not delete**: the enum values, `ShipmentTrackingSource.EASYPOST`, the `EasyPostWebhookEvent` model, its webhook route and both worker drains must survive for historical shipments and anything in flight, so removing enum values is out of scope. Finish with the Vendor Management Policy §6 termination steps — switch off, return-or-destroy, destruction certificate, status `terminated` | PR + `terminated` row | 1 wk   |

> **G-1 and G-2 are the two that gate G3**, because they are the ones a
> customer's compliance officer tests in the first review. G-3 through G-7
> can follow a design partner into production provided the partner's
> existing process covers them in the interim and that is written down.

> **EPCS is deliberately excluded from go-live — and being a vendor makes
> this constraint stronger, not weaker.** This is the one place where the
> scope correction cuts against Pharmax. Under **21 CFR 1311** the
> third-party audit or certification attaches to the **application
> provider**, so it is squarely Pharmax's obligation and cannot be
> delegated to a tenant. Shipping prescriber-side signing would make
> Pharmax both an electronic prescription application and a pharmacy
> application, triggering that audit plus re-certification on **every**
> change to controlled-substance functionality — a permanent tax on
> release velocity across a multi-tenant platform, not a one-off cost at
> one pharmacy.
>
> ADR-0037 remains **Proposed**. Until an audit passes, controlled-substance
> prescriptions must arrive on paper or through an already-certified
> external system. This belongs in the G-5 SOP templates and in the sales
> qualification script, not only in an ADR: a prospect whose volume is
> mostly electronically-prescribed controlled substances is not a
> candidate, and finding that out on the first call is worth a great deal.

---

### Workstream H — Vendor operations and customer enablement

> **Rewritten 2026-08-17.** This workstream previously assumed Pharmax
> employed the operators: it called for a signed SOP binder, trained staff,
> a competency assessment and a PIC signature on validation. A vendor
> cannot write its customer's SOPs or sign its customer's validation. What
> it can do — and must, or every onboarding is bespoke — is **produce the
> artifacts the customer needs and run its own operation well.** The
> estimates barely change; the deliverable changes from "our binder" to
> "a pack we hand over", which is reusable across every customer instead
> of once.

**Objective.** Be operable as a vendor, and make a tenant's own readiness
achievable without a Pharmax engineer sitting beside them.

**Why it blocks.** This is the workstream software teams skip and
regulators open with — the tenant's regulator. A validated platform whose
customer has untrained staff and no downtime procedure is still a
patient-safety incident waiting for its first outage, and the customer
will not distinguish between "the software failed" and "the software gave
us no way to cope when it failed."

| ID  | Task                  | Acceptance criteria                                                                                                                                                                                                                                                                                                                    | Evidence              | Est.   |
| --- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ------ |
| H1  | SOP **template** pack | Adoptable templates for intake, typing, PV1, filling, final verification, shipping, cancellation, recall, downtime and complaint handling — each referencing the actual Pharmax screen and command. The tenant edits, adopts and signs; Pharmax never signs a customer's SOP                                                           | Template pack         | 2 wk   |
| H2  | Validation pack       | **IQ and OQ authored by Pharmax** (environment as specified; each function meets spec) with a requirement → test → result traceability matrix, shipped so a tenant can execute **PQ** against its own site, staff and hardware and sign it. Pharmax's Quality owner signs the pack's accuracy; the **tenant** signs its own validation | Validation pack       | 2 wk   |
| H3  | Training material     | Role-based training content and a competency-assessment template the tenant delivers to its own staff; Pharmax trains the partner's trainer, not the partner's technicians                                                                                                                                                             | Training pack         | 1 wk   |
| H4  | Parallel-run support  | Reporting that lets a tenant reconcile Pharmax against its existing process for an agreed period, and a defined path for investigating every discrepancy to root cause                                                                                                                                                                 | Reconciliation report | 1.5 wk |
| H5  | Onboarding rehearsal  | The §7 onboarding executed end to end in staging against a synthetic tenant, including rollback                                                                                                                                                                                                                                        | Rehearsal log         | 0.5 wk |
| H6  | Downtime procedure    | Two halves: Pharmax's own customer-communication and status procedure for an outage, **and** a paper-fallback template for the tenant plus the platform capability to back-enter a paper-dispensed Rx without breaking the audit chain. **Rehearsed**, not merely written                                                              | Rehearsal log         | 1 wk   |
| H7  | Support model         | On-call rotation, escalation path, and a channel through which a tenant's pharmacist can reach a pharmacist — the clinical reviewer or a named alternate — during operating hours                                                                                                                                                      | Rotation document     | 0.3 wk |
| H8  | Onboarding runbook    | A repeatable sequence from signed MSA to first dispense: BAA, credential capture, org bootstrap, validation hand-off, training, parallel run, go-live. Exercised by someone who did not build the platform — that is the G4 test of whether onboarding still needs its author                                                          | Runbook + dry run     | 1 wk   |

---

## 5. Critical path

The critical path is **not** the code. It never was — but until the
2026-08-17 correction it was measured against the wrong finish line.
Removing state licensure and DEA registration removes the old longest pole
outright; **SOC 2 inherits the title**, and it inherits it for a
commercial reason rather than a regulatory one.

```
Week 1 — start every clock
  ├── F8 customer BAA to counsel   [calendar 1–3 wk] ──┐  ← gates the FIRST customer
  ├── F4 upstream BAAs             [calendar 2–8 wk] ──┤  ← §164.502(e)(1)(ii) gates F8
  ├── E1 pentest fieldwork         [calendar 7–10 wk] ─┤
  ├── B1 drug-knowledge licence    [calendar 4–12 wk] ─┤
  ├── F1 policies ratified         [DONE 2026-08-18] ──┤  ← F3 now unblocked
  └── F3 SOC 2 Type I → Type II    [calendar 6–24 mo] ─┤  ← longest pole, gates G4 only
                                                       │
D3 command integration harness ───────────────────────┤
G-1 → G-2 tenant credentials + ship-to-state ─────────┤  ← gates G3
C3 print agent in production ─────────────────────────┤
A6, D2, D4, D5, D6, E3…E6, H1…H8 (parallel) ──────────┤
                                                       ▼
                                              G2 → G3 → G4
```

**The ordering insight the old plan could not see.** F4 and F8 are not
parallel: § 164.502(e)(1)(ii) requires flow-down assurances from
subcontractors, so Pharmax cannot truthfully sign the subcontractor clause
of a customer BAA until the AWS and EasyPost BAAs are executed. The
cheapest item in the program is therefore also a hard predecessor of the
item that gates the first dollar of revenue. See
[`customer-baa-template.md`](./governance/customer-baa-template.md) §7.

**The things to start in Week 1 regardless of engineering capacity** are
F8, F4, E1, B1, F1 and the clinical-reviewer engagement. Between them they
consume a few days of anyone's attention and they set every date in §6.
Everything else can be compressed by adding capacity; these cannot.

**The single highest-leverage engineering task is D3** — a real-Postgres
command integration harness. 5,877 unit tests pass in 12 seconds against a
fake whose `$transaction` is `fn => fn(tx)`, so the four-table atomic write
that the whole architecture rests on is asserted constantly and proven
nowhere. Roughly two weeks converts the largest body of work in the
repository from assertion into evidence.

**The two highest-leverage product tasks are G-1 and G-2**, because they
are what a customer's compliance officer tests first and neither exists.

---

## 6. Indicative timeline

| Weeks   | Focus                                                                                                             | Gate   |
| ------- | ----------------------------------------------------------------------------------------------------------------- | ------ |
| 1       | Start every clock: F8 to counsel, E1, B1, clinical reviewer, SOC 2 auditor. F1 and AWS/Sentry BAAs already closed | **G0** |
| 1–4     | D3 command integration harness; C3 print agent to production; G-1 tenant credentials; land in-flight branches     |        |
| 4–8     | G-2 ship-to-state; A6 document intake; D2 load; D4, D5, D6 drills. A3 and D1 closed in #175 and #174              | **G1** |
| 6–14    | Pentest fieldwork; E2 remediation and retest; E3 OIDC; C6 DR region; C7 rotation; C8 incident log                 |        |
| 8–16    | B2, B3, B7, B8 as the drug-knowledge licence lands; B4, B5, B6; F2 close the Partial controls                     | **G2** |
| 10–18   | H1…H8 enablement pack and onboarding runbook; G-3…G-7; F5, F6, F7                                                 |        |
| 12–20   | Design-partner onboarding: BAA executed, credentials captured, validation handed over, parallel run               | **G3** |
| 6–24 mo | SOC 2 Type I issued; Type II observation window runs to completion                                                | **G4** |

Three ranges, because the three questions have materially different
answers and collapsing them into one number is what produced the old
estimate.

**Software feature-complete: 6 to 10 weeks.** Roughly 28 engineer-weeks
remain against a demonstrated throughput of about 4–5 engineer-weeks per
calendar week. Engineering has not been the binding constraint for some
time and is not now.

**Design partner in production: 3 to 4 months.** Gated by the customer
BAA — which is itself gated by the upstream BAAs — by G-1 and G-2, by a
print path proven on real hardware, and by the partner's own readiness,
which the partner controls and which a good enablement pack shortens. This
is where the previous version said 4–6 months and was wrong by the width of
a state licensure queue that was never Pharmax's to stand in.

**Generally available: 12 to 18 months.** Unchanged by the correction, and
now the number that matters most. Type I cannot begin until the policies
are ratified; the Type II observation window is 3–12 months after that. No
pharmacy compliance officer signs without the report, so this is the
constraint on revenue beyond hand-held design partners — and the one place
where starting a clock a week earlier buys a week of runway.

---

## 7. Design-partner onboarding (formerly "cutover plan")

Onboarding is a **capped, reversible, observed** event, not a switch flip.
It is run **jointly**: Pharmax owns the platform steps, the partner owns
every step that touches their licence, their staff and their patients. The
sequence below marks which is which, because the previous version assumed
one party did all of it.

**T-7 days — Pharmax.** Freeze non-critical deploys. Re-run `pnpm verify`,
the E2E suite, and a restore drill. Confirm every alarm has an action and
that a subscribed on-call endpoint actually rings.

**T-7 days — partner.** The partner's PIC confirms its pharmacy licence,
non-resident licences for every destination state, and DEA registration are
current and displayed. Pharmax records the credentials (G-1) and verifies
the ship-to-state set is enforced (G-2). Pharmax does not assess whether the
licences are adequate; it records what the PIC attests and enforces against
it.

**T-1 day — Pharmax.** Final `terraform plan` shows no drift. Confirm
backup retention ≥ 35 days and the latest restorable time is current.
Confirm the executed BAA is on file and the register row reads `executed`.

**T-1 day — partner.** Brief every operator on the abort criteria in §8.
Stage the paper downtime packet physically at the pharmacy, from the H6
template.

**T-0.**

1. Deploy via the approval-gated `deploy.yml`; migrations run as the
   one-off Fargate task before rollout.
2. Confirm the running image tag on **every** service — the matrix
   deploys them independently and the ECS circuit breaker can roll one
   back, leaving production on mixed versions.
3. Bootstrap the tenant organisation, site, clinic, buckets, and roles via
   `pnpm bootstrap:org`, including the credential set from G-1. Verify RLS
   fail-closed behaviour: an app-role connection with no tenancy GUC must
   return zero rows. Verify cross-tenant isolation against a second
   synthetic tenant — with more than one customer this stops being
   theoretical.
4. **The partner's operator** creates the first real prescription through
   the UI, and **the partner's pharmacist** verifies it. Two people watch,
   one from each party. Pharmax does not touch production PHI during
   onboarding; if a Pharmax engineer needs to, that is a break-glass
   session with its own record.
5. Walk it to `SHIPPED`. Verify at each stage: `command_log`,
   `order_event`, `audit_log`, `event_outbox` rows written; the SLA
   interval closed; the vial label physically correct on the partner's own
   printer stock.
6. Verify the billing event materialised and the invoice line appeared.
7. Hold at the agreed cap — **10 orders/day for five business days** is the
   recommended default — before any increase. The cap is a term agreed with
   the partner in writing, not a rule Pharmax imposes.

**T+1 through T+30.** Daily audit-chain verification reviewed by a human.
Daily reconciliation of dispensed versus shipped versus invoiced. Weekly
error-budget review. No volume increase while any SEV1 is open.

---

## 8. Abort criteria

**Either party may abort, and the mechanics differ.** The partner stops
intake and reverts to its paper procedure. Pharmax pauses the tenant,
convenes an incident, and — where PHI is implicated — discharges its
**Business Associate notification duty under 45 CFR § 164.410**: notify the
affected Covered Entity without unreasonable delay, statutory maximum 60
days, internal target 24 hours from confirmation
([Incident Response Policy §5.1](./policies/incident-response-policy.md)).
The customer cannot meet its own § 164.404 deadline to patients if Pharmax
is slow, so the internal target is the real one.

With more than one tenant, one further rule applies that a single-pharmacy
plan had no reason to state: **an incident affecting one tenant does not
authorise silence toward the others.** If the root cause is platform-wide,
every affected customer is notified, not only the one that reported it.

Stop intake, revert to the paper procedure, and convene an incident if
**any** of these occur:

- Any suspected cross-tenant data exposure. This is a SEV0 and a
  reportable event — no exceptions, no waiting to confirm. For a vendor
  this is also the single most existential failure mode there is: it is
  simultaneously a breach for **two** covered entities, and it is the exact
  risk every prospect's security review is probing for.
- Any tenant able to ship to a destination state outside its licensed set,
  or to dispense against a lapsed licence or DEA registration.
- Any dispense that reaches a patient having skipped PV1 or final
  verification.
- Audit chain verification fails and cannot be explained within one hour.
- Any PHI found in a log, metric, span attribute, or event payload.
- A label printed with wrong patient, drug, strength, or directions.
- Outbox depth or oldest non-terminal age exceeding the D2 threshold for
  more than 30 minutes.
- Loss of the pharmacist-reachable channel during operating hours.

Aborting is cheap at 10 orders/day and ruinous at 1,000. That asymmetry
is the entire reason for the volume cap.

---

## 9. Risk register deltas

Add to `docs/governance/risk-register.md` using its existing field
structure (Description, Likelihood, Impact, Composite, Current controls,
Residual rating, Owner, Review date, Mitigation plan):

| ID    | Risk                                                                                                                                                                                                                                                                                                          |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-023 | **Unscreened clinical dispensing.** No drug knowledge base means interactions, allergies and duplicate therapy are unscreened. Mitigation: B1–B3; until then, controlled by written SOP requiring manual pharmacist review against an external reference, which must be documented as a compensating control. |
| R-024 | **Production alarms with no action.** 14 of 18 alarms page nobody. Mitigation: C1.                                                                                                                                                                                                                            |
| R-025 | **Unvalidated intake path.** Prescriptions created by script rather than command bypass audit, RBAC and idempotency. Mitigation: A1; delete or gate the seed path before G3.                                                                                                                                  |
| R-026 | **Restore drill proved mechanism, not timing.** The 2026-07-23 drill restored a database containing zero organizations. Mitigation: D5.                                                                                                                                                                       |
| R-027 | **Vendor knowledge-base staleness.** Screening against an out-of-date drug database is worse than none because it is trusted. Mitigation: record the KB version on every screening result; alarm on staleness.                                                                                                |
| R-028 | **Mixed-version production after partial deploy.** The matrix deploys services independently and the circuit breaker rolls back individually. Mitigation: cutover step 2; post-deploy image-tag assertion in `deploy.yml`.                                                                                    |

Retire **R-004** (Clerk account takeover) — Clerk is retired.

---

## 10. Resourcing

Summing the task estimates gives two distinct pools, and conflating them
is how go-live plans slip:

| Pool                    | Total                                                                             | Who does it                             |
| ----------------------- | --------------------------------------------------------------------------------- | --------------------------------------- |
| Engineering build       | **~40 engineer-weeks** (A 4.5, B 7.3, C 6.3, D 6.0, E 4.8, F 3.8, G product 10.0) | Engineer + agents                       |
| Enablement / compliance | **~12 person-weeks** (H 8.8, G-5 1.0, policy ratification, training material)     | Ops lead, compliance, clinical reviewer |
| External calendar       | **12–20 weeks** to G3, largely concurrent; **6–24 months** for SOC 2              | Counsel, vendors, auditors, pentesters  |

Two changes from the previous version worth noting. Workstream G grew from
5 to 10 engineer-weeks because it became **product work** — tenant
credentials, ship-to-state enforcement, PDMP submission, inspection
reporting — where it used to be licence applications. And **state boards
left the external column entirely**, which is where the 3–5 months went.

A large fraction of the engineering pool is parallelisable, which is why
the timeline in §6 is shorter than 38 weeks. The operational pool is
**not** substitutable with engineering capacity — an engineer cannot
write the pharmacist's SOPs or sign the validation pack.

At the velocity this repository has demonstrated, one engineer plus
agents can carry Workstreams A, C, D and E. What that configuration
**cannot** provide is:

- a **licensed pharmacist under contract** for B3 clinical sign-off and to
  attest the H2 validation pack is clinically accurate. Not a PIC, and not
  an employee — but not optional either, because "who reviewed this
  clinically?" is asked in every customer's diligence;
- **legal counsel** for the customer BAA (F8), the governing-law and
  state-addendum decisions, and review of customer-supplied paper. This is
  new to the resourcing table and it sits on the path to the first dollar;
- an **independent reviewer** for segregation of duties on access reviews
  and break-glass — the program models SoD in code and must not violate it
  in practice;
- a **second on-call human**, because a one-person rotation is not a
  rotation, and because a customer contract will eventually specify a
  response time that one person cannot honour while asleep.

These four are hiring or contracting decisions. Counsel is on the path to
G3; the rest are on the path to G2. Treat all four as Week 1 actions
alongside the vendor clocks.

---

## 11. What "live" means

Pharmax is live when a prescription written by a real prescriber for a real
patient is entered — **by an operator employed by a licensed pharmacy that
is not Pharmax, under an executed Business Associate Agreement** — through
the operator console, screened clinically, verified twice by that
pharmacy's pharmacists, filled against a scanned lot, labelled on their
Zebra printer, shipped only to a state that pharmacy is licensed to ship
into, invoiced from operational truth, and fully reconstructable from
`command_log`, `order_event`, `audit_log` and `event_outbox` — with an
alarm that would have woken someone at Pharmax had any step failed, and a
tenant boundary that held while it did.

The clauses added to that sentence in the 2026-08-17 revision are the whole
correction in miniature: _not Pharmax_, _under an executed BAA_, _only to a
licensed state_, and _the tenant boundary held_. Each is a requirement the
previous version could not express, because it thought Pharmax was the
pharmacy and there was no boundary to hold.

Everything in this document exists to make that sentence true.

### 11.1 Environment preconditions — the adapters must be real

One clause in that sentence has a precondition the rest of this document
did not state: _"an alarm that would have woken someone at Pharmax had
any step failed."_

As of 2026-08-18 no alarm can wake anyone, because the production worker
is running an **in-memory notification channel**. It is not broken and it
does not warn — the fallback is deliberate, so that a missing environment
variable cannot stop the worker draining the outbox. The consequence is
narrower and worse than an outage: every control still runs, still
succeeds, and delivers its output nowhere.

The same fallback applies to the report archive, which is running
in-memory in production and therefore discards scheduled-run CSVs.

This is latent today because production has zero organizations. It
becomes active on the day the first tenant onboards — which is exactly
when nobody is reading a boot log.

**Gate: none of the following may be unset when the first tenant is
onboarded.** Verify from the worker boot log, not from Terraform, because
the question is what the running process resolved and not what the plan
intended.

| Variable                                  | Without it                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| `REPORT_ARCHIVE_S3_BUCKET`                | Scheduled-report CSVs exist only in process memory and vanish on restart |
| `REPORT_ARCHIVE_S3_KMS_KEY_ID`            | Same — both are required for the S3 adapter to be selected               |
| `RESEND_API_KEY`                          | No notification leaves the platform                                      |
| `NOTIFICATION_FROM_EMAIL`                 | Same — both are required for the Resend channel to be selected           |
| `COMPLIANCE_NOTIFY_RECIPIENT_EMAIL`       | A quarterly access review that finds something tells nobody              |
| `NIGHTLY_SECURITY_DIGEST_RECIPIENT_EMAIL` | The nightly security digest is computed and discarded                    |

**Status as of 2026-08-20: the infrastructure exists; two operator steps
remain.**

The reports bucket has been added (`module "s3_reports"` in
`infra/terraform/main.tf`, reusing the `s3-documents` profile with
`purpose = "reports"`), the worker task role has scoped write and read on
it, and both `REPORT_ARCHIVE_S3_*` variables are injected. That half needs
only an apply.

The notification half is provisioned but **switched off on purpose**. The
`resend-api-key` secret is created empty and referenced by nothing, behind
`notifications_enabled = false`. The order cannot be reversed:

1. Create the Resend account, verify the sending domain.
2. `terraform apply` — creates the empty secret.
3. `aws secretsmanager put-secret-value --secret-id <prefix>/resend-api-key …`
4. Set `notifications_enabled = true`, set the three addresses, apply again.

Enabling before populating fails the task with
`ResourceInitializationError`, turning a degraded notification path into a
worker that will not boot. That is the trap the Clerk decommission hit,
and it is why creating the secret and referencing it are two applies
rather than one.

**Resend still has no executed BAA**
([`baa-tracker.md`](./governance/baa-tracker.md)). It is `not requested`
and gated to non-PHI templates by `phiCapable: false`, with every template
carrying `phiAllowed: false` and the channel asserting it at the boundary.
That is sufficient for operational alerting — order numbers, escalation
reasons — and **not** sufficient for anything patient-facing. A BAA
becomes mandatory the moment a template flips.

Confirm from the boot log that the resolved adapters read `s3` and
`resend` rather than `in-memory`, and record the check in the go-live
evidence pack. Tracked as **R-028** in the
[risk register](./governance/risk-register.md).

Do not rely on warnings to surface this. Coverage is uneven: the report
archive and the nightly security digest each warn at boot, while the
notification channel and the access-review recipient warn about nothing.
A reader who has seen two warnings and no third will reasonably conclude
the third path is healthy, which is the opposite of what silence means
here.

One scheduling note, because it affects when this is checkable. The
quarterly access-review loop no-ops except on the first day of a
quarter — Q3 opened 1 July, so the next automatic run is **1 October**.
Waiting for the scheduler is a six-week feedback loop; run
`scripts/security/run-access-review.ts` directly instead, as
[`../compliance/first-cycle-runbook.md`](./compliance/first-cycle-runbook.md)
Session 1 does.

---

## 12. Annex — Track B (insurance billing), REJECTED

> **Closed 2026-08-15 by [ADR-0039](./adr/0039-cash-only-no-pbm-adjudication.md).**
> Track B is **rejected scope, not deferred work.** Nothing below is
> planned, estimated for, or resourced. It is retained for one reason: a
> future proposal to add insurance billing should have to argue against the
> full cost, and that cost is easier to underestimate than any other number
> in this document.
>
> If that argument is ever made and won, it needs a new ADR superseding
> 0039, and this annex becomes a program of its own rather than a section
> of this one.

| Item                       | Note                                                                                                                                                                                 | Est.                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| Claims bounded context     | A new `@pharmax/claims` package. Do not extend the B2B invoicing domain — third-party adjudication has a different lifecycle, different reversal semantics, and different retention. | 6 wk                         |
| NCPDP D.0                  | B1/B2 request-response, eligibility, DUR response segments, reversals (B2), reconciliation                                                                                           | 8 wk                         |
| Switch contract            | Change Healthcare, RelayHealth or equivalent, plus certification                                                                                                                     | **[calendar] 3–6 mo**        |
| Prior authorization        | ePA workflow; today only a PV1 rejection reason code exists                                                                                                                          | 4 wk                         |
| Copay + patient pay        | Patient-responsibility accounting, currently entirely absent                                                                                                                         | 3 wk                         |
| Surescripts / NCPDP SCRIPT | Inbound e-prescribing plus certification                                                                                                                                             | 6 wk + **[calendar] 3–6 mo** |
| 340B, EDI 850/855/856      | Only if the business requires them                                                                                                                                                   | 6 wk                         |

**Track B adds 6–12 months.** Deciding it late is far more expensive
than deciding it now, because the claims lifecycle influences the order
and billing models that Track A is about to harden.

---

## Change log

| Date       | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-08-02 | Initial program. Derived from a full-repository readiness audit plus live read-only inspection of `pharmax-prod-ue1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2026-08-17 | **Scope correction: Pharmax is a software vendor, not a pharmacy.** Added §0.1 stating the model. Replaced the PIC veto with a contracted clinical reviewer plus the customer's PIC. Re-gated G3 to "sellable to a design partner" and G4 to "generally available". Rewrote Workstream G from obtaining licences to enabling tenants to prove theirs (tenant credential model, ship-to-state enforcement, PDMP on the tenant's behalf, inspection reporting). Rewrote Workstream H from our SOPs and training to an enablement pack plus an onboarding runbook. Added B7 per-formula dose limits and B8 compensating control. Recorded D-1 as closed by ADR-0039/0040 and Track B as rejected. Rebuilt §5–§7 and §10–§11 around the corrected critical path. |
| 2026-08-18 | **EasyPost retired rather than signed.** The last BAA blocker on F8 §3.4 closes by removing the counterparty, not by signing it: EasyPost was a business associate because it stored recipient addresses in its own platform, whereas FedEx and UPS moving sealed parcels are conduits (HHS FAQ #245) under tenant-owned credentials. F4 therefore turns on two facts rather than a signature — the integration off in production, and counsel concurrence — with the code work tracked as **G-8**. Also records the service consequence nobody had written down: **USPS and DHL were reachable only through the aggregator** and have no direct adapter, so the decision accepts FedEx and UPS only.                                                        |
| 2026-08-18 | Closed F1 — #200 adopted the governance bundle with real effective dates, which unblocks F3. Partly closed F4: AWS and Sentry `executed`, FedEx/UPS/Vercel re-scoped to `N/A`, leaving **EasyPost** as the one PHI-receiving row still unsigned and therefore the single blocker on the customer BAA's flow-down clause. Corrected the Week 1 row and the §5 critical path accordingly.                                                                                                                                                                                                                                                                                                                                                                      |
