# Go-Live Program

## 0. What this document is

`docs/IMPLEMENTATION_PLAN.md` records **what we have built**. This
document records **what must be true before a real prescription for a
real patient is dispensed through Pharmax**, and the order in which to
make it true.

The two differ more than they look. The implementation plan is organised
by capability and is largely complete: 103 command handlers, a traceable
`RECEIVED → SHIPPED` chain, RLS on 67+ tables, a live Multi-AZ production
cluster, and a real point-in-time restore drill with committed evidence.
Go-live is organised by **risk to a patient and to the licence**, and by
that measure the platform is not close, for three reasons that have
nothing to do with code quality:

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

| Role                       | Held by          | Authority                                                    |
| -------------------------- | ---------------- | ------------------------------------------------------------ |
| Program owner              | Engineering lead | Declares gates passed or failed                              |
| Pharmacist-in-charge (PIC) | Licensed RPh     | **Veto** on G2, G3, G4. No software argument overrides this. |
| Security owner             | Engineering lead | Owns Workstream E, signs pentest closure                     |
| Compliance owner           | Engineering lead | Owns Workstream F, signs auditor readiness                   |
| Quality owner              | Engineering lead | Owns validation (H2); signs IQ/OQ/PQ                         |

On a solo-plus-agents team one person wears several of these hats. That
is acceptable for every hat except **PIC**, which must be a licensed
pharmacist and cannot be the same person who wrote the code they are
attesting to. Segregation of duties is already modelled in the command
bus (`sodRules`); it must also hold at the program level.

---

## 1. D-1 — the scope decision that governs everything

**This decision is due by end of Week 1. Nothing else in this program
can be correctly sequenced until it is made.**

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

**This program plans Track A.** Track B is scoped in Annex §12 and is
deliberately _not_ interleaved, because starting it before G3 would
destabilise a codebase that is otherwise nearly ready to dispense.

Record the decision as an ADR (`docs/adr/0038-payer-model-scope.md`)
whichever way it goes. A decision this expensive must not live only in
someone's memory.

---

## 2. Gate model

Five gates. Each has exit criteria that are **artifacts, not opinions**.

| Gate   | Name                         | Meaning                                                                           | Blocking veto        |
| ------ | ---------------------------- | --------------------------------------------------------------------------------- | -------------------- |
| **G0** | Scope locked, clocks started | The fork is decided and every calendar-bound clock is running                     | Program owner        |
| **G1** | Pilot feature-complete       | An operator can take an Rx from intake to shipped label without touching a script | Program owner        |
| **G2** | Validated and secure         | Pentest clean, validation signed, system proven under load                        | PIC + Security owner |
| **G3** | Limited production           | First real patient, capped volume, heightened monitoring                          | PIC                  |
| **G4** | General availability         | Volume caps removed, normal on-call                                               | PIC + Program owner  |

### Gate exit criteria

**G0 — Scope locked, clocks started**

- [ ] ADR-0038 merged recording the Track A/B decision
- [ ] Pentest vendor under contract with a scheduled fieldwork window
- [ ] Drug-knowledge vendor (First Databank or Medi-Span) in commercial conversation with a written quote
- [ ] SOC 2 auditor engaged; Type I readiness date agreed
- [ ] All BAAs in `docs/governance/baa-tracker.md` moved off `TBD` to `requested`, `executed`, or `N/A — justified`
- [ ] On-call rotation named, with a human who answers a phone

**G1 — Pilot feature-complete**

- [ ] Workstream A complete: a prescription can be created through the UI and through the v1 API
- [ ] Workstream C1–C4 complete: alarms route to a pager; print-agent runs in production
- [ ] Workstream D1 complete: an E2E test dispenses a synthetic order through the real UI
- [ ] `pnpm verify` green; zero `Partial` SOC 2 controls newly introduced

**G2 — Validated and secure**

- [ ] Pentest final report received; **zero open Critical or High** findings (or formally risk-accepted by PIC and Security owner, recorded in the risk register)
- [ ] IQ/OQ/PQ validation pack signed by PIC (H2)
- [ ] Load test demonstrates the documented NFRs with headroom (D2)
- [ ] DUR screening live and clinically reviewed by PIC (B3)
- [ ] All three chaos drills executed with committed evidence (D4)
- [ ] Restore drill re-executed against a database containing real data volume (D5)

**G3 — Limited production**

- [ ] Pharmacy licences, DEA registration, and PDMP enrolment in hand for the launch state (G1 workstream in §4.G)
- [ ] SOPs written, staff trained, competency assessed (H1, H3)
- [ ] Parallel run completed with zero unexplained discrepancies (H4)
- [ ] Downtime/paper procedure rehearsed (H6)
- [ ] Volume cap and abort criteria agreed in writing (§8)

**G4 — General availability**

- [ ] 30 consecutive days at G3 with no SEV0/SEV1 attributable to Pharmax
- [ ] SOC 2 Type I report issued; Type II observation window running
- [ ] Auditor readiness checklist (`docs/compliance/auditor-readiness-checklist.md`, 48 items) fully checked
- [ ] Error budget policy in force and not exhausted

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
and a pharmacy. A pharmacist verifying PV1 without interaction, allergy,
and duplicate-therapy screening is doing so unaided, and a board
inspector will ask which knowledge base you use. There is no defensible
answer that is "none".

| ID  | Task                           | Acceptance criteria                                                                                                                                                                                                | Evidence                          | Depends on | Est.                   |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- | ---------- | ---------------------- |
| B1  | Drug knowledge vendor          | Signed licence with First Databank or Medi-Span; BAA executed if PHI crosses the boundary                                                                                                                          | Contract + BAA row                | G0         | **[calendar] 4–12 wk** |
| B2  | `@pharmax/drug-knowledge` port | Adapter interface with a deterministic in-repo fake; no vendor SDK imported outside the package; vendor data version recorded on every screening result                                                            | Merged PR + ADR                   | B1         | 2 wk                   |
| B3  | DUR engine at PV1              | Interaction, allergy, duplicate-therapy and dose-range screening run before `ApprovePV1`; each alert requires pharmacist acknowledgement with a reason; alerts persisted immutably with the knowledge-base version | Merged PR + PIC clinical sign-off | B2, A1     | 2 wk                   |
| B4  | Patient allergy capture        | Allergy list on `Patient`, encrypted, editable through a command; allergy screening cannot silently pass on an empty list — absence must be an explicit "no known allergies" attestation                           | Migration + PR                    | —          | 1 wk                   |
| B5  | Counseling record              | Offer-to-counsel recorded per dispense; refusal captured; visible on order timeline                                                                                                                                | Migration + PR                    | —          | 0.5 wk                 |
| B6  | Med guides + auxiliary labels  | FDA Medication Guide attached where required; auxiliary warning label rules driven by the knowledge base rather than hand-maintained                                                                               | Merged PR                         | B2         | 1 wk                   |

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

| ID  | Task                         | Acceptance criteria                                                                                                                                                                                                    | Evidence                                      | Depends on | Est.   |
| --- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------- | ------ |
| D1  | E2E suite                    | Playwright in CI against a seeded stack; the golden path (intake → typing → PV1 → fill → label → final → ship) passes headless; also covers PV1 rejection, hold/release, and cancellation                              | Green CI job                                  | A1, A3     | 2 wk   |
| D2  | Load + soak                  | Documented NFRs (orders/day, concurrent operators, queue-read p95) then k6 proving them with headroom; 24-hour soak with no leak or lock escalation; **row-lock contention on the hot order path measured explicitly** | Load report                                   | C2         | 1.5 wk |
| D3  | Integration depth            | Raise DB-bound integration coverage beyond the current 61 tests to cover every command that writes `order_event`; assert outbox and audit rows are written in the same transaction                                     | Coverage delta                                | —          | 1 wk   |
| D4  | Execute the chaos drills     | All three scenarios in `docs/operations/chaos-drills.md` run for real: printer outage, queue backpressure, Stripe outage. Tooling exists; execution does not.                                                          | Evidence packs under `evidence/chaos-drills/` | C1, C3     | 0.5 wk |
| D5  | Restore drill at real volume | Re-run the restore drill against a database with production-scale data. The 2026-07-23 drill was clean but **vacuous — zero organizations, zero orders**; it proved the mechanism, not the timing.                     | Drill evidence pack                           | —          | 0.5 wk |
| D6  | Migration rehearsal          | Every migration replayed against a prod-sized dataset with lock-time measured; any migration holding an exclusive lock beyond the agreed budget is rewritten                                                           | Rehearsal log                                 | D5         | 0.5 wk |

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

**Objective.** Be able to hand an auditor a folder and answer questions
from evidence rather than memory.

The machinery here is genuinely good and mostly needs finishing, not
building: a TSC control matrix with real control IDs, a HIPAA Security
Risk Analysis, a control matrix mapping §164.308/310/312, and a
quarterly evidence pack orchestrator producing SHA-256 manifests.

| ID  | Task                              | Acceptance criteria                                                                                                                                                     | Evidence                        | Depends on | Est.                   |
| --- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ---------- | ---------------------- |
| F1  | Ratify the policies               | Every `[Effective date: TBD]` and `<TBD>` in `docs/policies/` and `docs/soc2/policies/` resolved and dated. Nine SOC 2 policy files are labelled **"THIS IS A STUB"**.  | Signed, dated policies          | —          | 1 wk                   |
| F2  | Close the `Partial` controls      | `CC1.2-1`, `CC2.3-1`, `CC7.2-3`, `CC7.5-1`, `A1.2-2`, `A1.3-1`, `P1.1-1`, `P4.1-1` moved to `Implemented` with evidence, or formally scoped out                         | Updated `controls-inventory.md` | C1–C8      | 1.5 wk                 |
| F3  | SOC 2 Type I → Type II            | Type I report issued, then the observation window opened                                                                                                                | Auditor report                  | F1, F2, E2 | **[calendar] 3–12 mo** |
| F4  | Execute BAAs                      | AWS, EasyPost, FedEx, UPS, Sentry, Vercel, Resend moved off `TBD`. No PHI may flow to a counterparty without one.                                                       | `baa-tracker.md` all resolved   | G0         | **[calendar] 2–8 wk**  |
| F5  | Workforce training                | `docs/governance/security-training-program.md` delivered and attested by every person with production access                                                            | Attestation records             | —          | 0.3 wk                 |
| F6  | Auditor readiness checklist       | All 48 items in `docs/compliance/auditor-readiness-checklist.md` checked                                                                                                | Completed checklist             | F1–F5      | 0.5 wk                 |
| F7  | HIPAA §164.316 + breach procedure | Add an explicit §164.316 documentation-retention row to the control matrix (currently mapped mainly to §164.530(j)), and a state-by-state breach notification procedure | Updated docs                    | —          | 0.5 wk                 |

---

### Workstream G — Pharmacy regulatory

**Objective.** Be legally permitted to dispense.

**Why it blocks.** No amount of software quality substitutes for a
licence. These items are almost entirely external and must start early.

| ID  | Task                               | Acceptance criteria                                                                                                     | Depends on | Est.                        |
| --- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------- |
| G-1 | Pharmacy licence(s)                | Resident licence for the dispensing state; non-resident licences for every state shipped into                           | —          | **[calendar] 2–6 mo/state** |
| G-2 | DEA registration                   | Registration current for every schedule dispensed at the registered address                                             | G-1        | **[calendar] 4–8 wk**       |
| G-3 | PDMP reporting                     | Enrolled with each state's PDMP; automated submission in the required format and cadence; submission failures alarm     | G-1        | 1.5 wk + calendar           |
| G-4 | Controlled-substance recordkeeping | 21 CFR 1304 perpetual inventory for CII; biennial inventory procedure; DEA 222/CSOS ordering path                       | G-2        | 2 wk                        |
| G-5 | USP 795/797/800 SOPs               | Written SOPs aligned to the shipped `CompoundFormula` / `CompoundingRecord` models; BUD policy; hazardous-drug handling | —          | 1 wk                        |
| G-6 | DSCSA verification                 | Extend the existing `DscsaTransaction` receipt model with saleable-return verification and suspect-product quarantine   | —          | 1.5 wk                      |
| G-7 | Board inspection readiness         | Mock inspection against the state's checklist; findings closed                                                          | G-1…G-6    | 0.5 wk                      |

> **EPCS is deliberately excluded from Track A go-live.** ADR-0037 is
> still **Proposed**, and shipping prescriber-side signing would make
> Pharmax both an electronic prescription application and a pharmacy
> application under 21 CFR 1311, triggering a third-party audit and
> re-certification on every change to controlled-substance
> functionality. Until that audit passes, controlled-substance
> prescriptions must arrive on paper or by an already-certified external
> system. This constraint belongs in the SOPs (G-5), not just in an ADR.

---

### Workstream H — Operational readiness

**Objective.** Make the pharmacy, not just the software, ready.

**Why it blocks.** This is the workstream software teams skip and
regulators open with. A validated system with untrained staff and no
downtime procedure is a patient-safety incident waiting for its first
outage.

| ID  | Task                       | Acceptance criteria                                                                                                                                                                          | Evidence           | Est.   |
| --- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------ |
| H1  | SOP set                    | Written SOPs for intake, typing, PV1, filling, final verification, shipping, cancellation, recall, downtime, and complaint handling — each referencing the actual Pharmax screen and command | Signed SOP binder  | 2 wk   |
| H2  | Computer system validation | IQ (environment as specified), OQ (each function meets spec), PQ (real workflows by real staff on real hardware). Traceability matrix from requirement → test → result. **PIC signs.**       | Validation pack    | 2 wk   |
| H3  | Training + competency      | Every operator trained per role and competency-assessed; records retained                                                                                                                    | Training records   | 1 wk   |
| H4  | Parallel run               | An agreed period running Pharmax alongside the existing process; every discrepancy investigated to root cause and closed                                                                     | Reconciliation log | 1.5 wk |
| H5  | Cutover rehearsal          | The §7 cutover executed end to end in staging, including rollback                                                                                                                            | Rehearsal log      | 0.5 wk |
| H6  | Downtime procedure         | Paper fallback and post-outage reconciliation written and **rehearsed** — including how a paper-dispensed Rx is back-entered without breaking the audit chain                                | Rehearsal log      | 0.5 wk |
| H7  | Support model              | On-call rotation, escalation path, and a pharmacist-reachable channel for clinical questions during operating hours                                                                          | Rotation document  | 0.3 wk |

---

## 5. Critical path

The critical path is **not** the code. Ordered by finish date:

```
G0 decision (Wk 1)
  ├── B1 drug-knowledge licence   [calendar 4–12 wk] ──┐
  ├── E1 pentest fieldwork        [calendar 7–10 wk] ──┤
  ├── F4 BAAs                     [calendar 2–8 wk]  ──┤
  └── G-1/G-2 licence + DEA       [calendar 2–6 mo]  ──┤  ← longest pole
                                                       │
A1 → A3 → D1 ─────────────────────────────────────────┤
B2 → B3 (needs B1) ───────────────────────────────────┤
C1..C8, D2..D6 (parallel, no external dependency) ────┤
                                                       ▼
                                                   G2 → G3
```

**The four things to start in Week 1 regardless of engineering capacity**
are B1, E1, F4, and G-1. They consume almost no engineering time and they
dominate the finish date. Everything else can be compressed by adding
people; these cannot.

**The single highest-leverage engineering task is A1.** It is roughly a
week and a half of work that connects a finished machine to the outside
world.

---

## 6. Indicative timeline (Track A)

| Weeks | Focus                                                                                         | Gate   |
| ----- | --------------------------------------------------------------------------------------------- | ------ |
| 1     | D-1 decision; start every calendar clock (B1, E1, F4, G-1); C1 alarm routing; C4 verification | **G0** |
| 2–5   | A1, A2, A3, A4, A7; C3, C5, C8; D1; E4, E6                                                    |        |
| 6     | Buffer + integration; staging pentest environment prepared                                    | **G1** |
| 6–12  | D2, D3, D4, D5, D6; E3; G-3…G-6; pentest fieldwork runs                                       |        |
| 9–14  | B2, B3, B4, B5, B6 as the drug-knowledge licence lands; E2 remediation and retest             |        |
| 10–16 | F1, F2, F5, F6, F7; H1…H7 ops readiness and validation; G-7                                   | **G2** |
| 16–20 | Limited production: first real patient, capped volume                                         | **G3** |
| 20–24 | Volume ramp; SOC 2 Type I; Type II window opens                                               | **G4** |

**Realistic range: 4 to 6 months to G3**, driven by whichever of the
drug-knowledge licence and the state licensure finishes last, not by
engineering. If state licensure is already in hand, the range compresses
to roughly 3 to 4 months. If it is not started until G1, add three
months.

---

## 7. Cutover plan

Cutover is a **capped, reversible, observed** event, not a switch flip.

**T-7 days.** Freeze non-critical deploys. Re-run `pnpm verify`, the E2E
suite, and a restore drill. Confirm every alarm has an action and every
on-call phone rings. PIC confirms licences and DEA registration are
current and displayed.

**T-1 day.** Final `terraform plan` shows no drift. Confirm backup
retention ≥ 35 days and the latest restorable time is current. Brief
every operator on the abort criteria in §8. Stage the paper downtime
packet physically in the pharmacy.

**T-0.**

1. Deploy via the approval-gated `deploy.yml`; migrations run as the
   one-off Fargate task before rollout.
2. Confirm the running image tag on **every** service — the matrix
   deploys them independently and the ECS circuit breaker can roll one
   back, leaving production on mixed versions.
3. Bootstrap the production organisation, site, clinic, buckets, and
   roles via `pnpm bootstrap:org`. Verify RLS fail-closed behaviour: an
   app-role connection with no tenancy GUC must return zero rows.
4. Create the first real prescription through the UI. Two people watch.
5. Walk it to `SHIPPED`. Verify at each stage: `command_log`,
   `order_event`, `audit_log`, `event_outbox` rows written; the SLA
   interval closed; the vial label physically correct.
6. Verify the billing event materialised and the invoice line appeared.
7. Hold at **10 orders/day for five business days** before any increase.

**T+1 through T+30.** Daily audit-chain verification reviewed by a human.
Daily reconciliation of dispensed versus shipped versus invoiced. Weekly
error-budget review. No volume increase while any SEV1 is open.

---

## 8. Abort criteria

Stop intake, revert to the paper procedure, and convene an incident if
**any** of these occur:

- Any suspected cross-tenant data exposure. This is a SEV0 and a
  reportable event — no exceptions, no waiting to confirm.
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

| Pool                     | Total                                                                                       | Who does it                     |
| ------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------- |
| Engineering build        | **~38 engineer-weeks** (A 6.1, B 6.5, C 6.3, D 6.0, E 4.8, F 3.8, G engineering 5.0)        | Engineer + agents               |
| Operational / regulatory | **~11 person-weeks** (H 7.8, G-5 and G-7 1.5, plus policy ratification and training effort) | PIC, ops lead, compliance       |
| External calendar        | **20–26 weeks**, largely concurrent                                                         | Vendors, auditors, state boards |

A large fraction of the engineering pool is parallelisable, which is why
the timeline in §6 is shorter than 38 weeks. The operational pool is
**not** substitutable with engineering capacity — an engineer cannot
write the pharmacist's SOPs or sign the validation pack.

At the velocity this repository has demonstrated, one engineer plus
agents can carry Workstreams A, C, D and E. What that configuration
**cannot** provide is:

- a **licensed pharmacist** for B3 clinical sign-off, H2 validation
  signature, and every PIC veto;
- an **independent reviewer** for segregation of duties on access
  reviews and break-glass — the program models SoD in code and must not
  violate it in practice;
- a **second on-call human**, because a one-person rotation is not a
  rotation.

These three are hiring or contracting decisions, and they are on the
critical path for G2. Treat them as Week 1 actions alongside the vendor
clocks.

---

## 11. What "live" means

Pharmax is live when a prescription written by a real prescriber for a
real patient is entered through the operator console, screened
clinically, verified twice by a pharmacist, filled against a scanned lot,
labelled on a Zebra printer, shipped with tracking, invoiced from
operational truth, and fully reconstructable from `command_log`,
`order_event`, `audit_log` and `event_outbox` — with an alarm that would
have woken someone had any step failed.

Everything in this document exists to make that sentence true.

---

## 12. Annex — Track B (insurance billing)

Only if D-1 selects Track B. Not interleaved with Track A; sequenced
after G3.

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

| Date       | Change                                                                                                                |
| ---------- | --------------------------------------------------------------------------------------------------------------------- |
| 2026-08-02 | Initial program. Derived from a full-repository readiness audit plus live read-only inspection of `pharmax-prod-ue1`. |
