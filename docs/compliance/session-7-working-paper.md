# Session 7 Working Paper — First Annual Risk Assessment

| Field     | Value                                                                      |
| --------- | -------------------------------------------------------------------------- |
| Prepared  | 2026-08-21                                                                 |
| For       | [First-cycle runbook](./first-cycle-runbook.md) Session 7, 90 minutes      |
| Status    | **Draft input. Nothing here is in the register until you adjudicate it.**  |
| Procedure | [risk-assessment-procedure.md](../governance/risk-assessment-procedure.md) |

## How to use this

The register has 29 entries. This paper proposes **eight additions**, one
**scoring change**, and records **four adjudications** so you do not
re-litigate them.

Scores are proposed, not assigned. Likelihood × impact on the register's
existing 1–5 scale, triage threshold composite ≥ 16. Where I think the
score is arguable I have said so rather than picking a number and moving
on — a register whose numbers were never contested is a register nobody
read.

Work down the list, change what you disagree with, then tell me and I
will apply the result to the register and refresh the SRA.

---

## Part 1 — Proposed new entries

### P-1. Concentration of privilege in a single identity

**This is the one the runbook names in its definition of done**, and it is
the only proposal here that is certain to be an entry rather than a
judgement call.

One identity holds AWS Administrator on both accounts, GitHub admin, sole
production deploy approval, and — through the management account — the
ability to rewrite every other grant. Verified in the 2026-Q3 access
review: a single Identity Center user in all three groups.

- **Proposed likelihood 2** — this is not an attack, it is a standing
  condition. Likelihood expresses the chance it is _exploited or
  becomes harmful_, not that it exists.
- **Proposed impact 5** — an actor who obtains that identity obtains
  everything, and there is no second party to notice.
- **Composite 10.** Arguable: you could justify impact 4 on the grounds
  that Object Lock and the audit chain survive a hostile administrator,
  which is genuinely true and is the strongest thing in the compensating
  set.
- **Compensating controls, all verified present**: hash-linked audit
  chain with daily KMS-signed Merkle roots; CloudTrail to an Object Lock
  COMPLIANCE bucket, which is the only control here that survives a
  hostile administrator; RLS enforced in the database independent of
  application code; branch protection plus a pre-commit hook refusing
  direct commits; deploy approval retained as a deliberate pause rather
  than claimed as four-eyes.
- **Expiry**: first engineering hire. The Identity Center groups needed
  to split these duties already exist and are staffed by one person
  across all three.

### P-2. Unaudited PHI disclosure on the label-purchase route

`apps/web/app/api/ops/orders/[orderId]/purchase-shipment-label/route.ts`
decrypts a patient's name and full home address via
`resolvePurchaseContext` and transmits them to a carrier, with **no
`patient.viewed` audit record**.

What makes this a finding rather than an oversight is the asymmetry: the
sibling rate-quote path audits the identical disclosure and **fails
closed**, with fifteen lines of comment explaining why the audit belongs
inside the decrypting function. Someone reasoned this through carefully
for one path and the other was left alone.

- **Proposed likelihood 4** — it happens on every label purchase, so the
  unaudited disclosure is certain once orders flow. Likelihood is about
  the gap being exercised, not about an attacker.
- **Proposed impact 3** — the disclosure itself is permitted; what is
  missing is the record of it. Bounded because `PurchaseShipmentLabel`
  writes its own audit row, so the _action_ is attributable even though
  the PHI _read_ is invisible to the access-log projection and to the
  anomaly detector that keys on `patient.viewed`.
- **Composite 12.**
- **Mitigation**: move the `auditPatientView` call inside
  `resolvePurchaseContext`, so no future caller can obtain the address
  without recording it. That is strictly better than adding it to the
  route, which leaves the next caller to remember.

### P-3. No accounting of disclosures, and the customer BAA promises one

§164.528 requires a covered entity to account for certain disclosures for
six years. There is no ledger, model, or command anywhere in the
codebase. What exists is an access log of internal _uses_, which is a
different control.

The aggravating fact: `customer-baa-template.md` commits to customers
that "disclosure accounting is queryable per patient," and its own
verification column says **"VERIFY — confirm a per-Individual disclosure
query exists and is scoped."** It does not.

- **Proposed likelihood 3** — requires a customer to exercise the right,
  which requires a customer.
- **Proposed impact 4** — a signed BAA asserting a capability that does
  not exist is a contractual exposure on top of the regulatory one, and
  it is the kind of finding that colours an assessor's view of every
  other claim.
- **Composite 12.**
- **Note**: this is a decision, not just a risk. Either build the ledger
  or amend the template. Amending is legitimate and free; shipping the
  promise unbuilt is not.

### P-4. Patient rights have no implementation

No implementation of access (§164.524), amendment (§164.526), or
restriction (§164.522).

The mitigating argument is real: Pharmax is a business associate, and
individuals exercise these rights against the covered entity. But
§164.504(e)(2)(ii)(E)–(F) obliges a BA to **make PHI available** so the
covered entity can discharge its duty, and there is no API, export, or
command through which a pharmacy customer could satisfy a §164.524
request.

- **Proposed likelihood 2** — needs a tenant, then a patient request.
- **Proposed impact 3** — blocks a customer from meeting their own
  obligation, which becomes their incident and your contract problem.
- **Composite 6.** Below the triage threshold; accepted with a target
  date rather than an active plan.

### P-5. Emergency access has no invocable entry point

Distinct from R-029, which covers four-eyes and sole-operator
contingency. This is narrower: `openBreakGlassSession` has **zero
production callers**. The only references are its own test, the barrel
export, and a runbook instructing an engineer to hand-write TypeScript
against the library.

- **Proposed likelihood 4** — the moment it is needed it will not be
  used, because at 3am nobody writes a script.
- **Proposed impact 3** — the access still happens, via direct `psql`;
  what is lost is the `break_glass_action` record of what was touched.
  So the harm is forensic, not access-control.
- **Composite 12.**
- **Mitigation**: a CLI in `scripts/security/` matching the existing
  Merkle and chain-verify pattern. Small.
- **Alternative**: fold into R-029 as a third residual rather than
  opening a new entry. I lean toward folding — same subject, and the
  register is already dense.

### P-6. System commands record no actor

`execute-system-command.ts` hardcodes `actorUserId: null` on both
`command_log` and `audit_log`. Correct for webhook- and worker-driven
commands. The gap is that there is **no mechanism to attribute a system
command to a human when one initiated it**, and 22 `SystemCommand`
definitions exist including `MarkInvoiceVoided` and
`MarkInvoiceUncollectible`.

- **Proposed likelihood 2** — needs an operator-reachable system command
  to be exercised.
- **Proposed impact 3** — an audit row with no actor fails the unique
  user identification standard for that action.
- **Composite 6.**

### P-7. Runtime database role is asserted nowhere

Audit-log immutability and all tenant RLS rest on the application
connecting as `pharmax_app` or `pharmax_system`. That role selection
lives in a hand-composed connection string, documented only as a comment
in `infra/terraform/modules/secrets/main.tf`. **No code asserts the
connected role at boot.** If `DATABASE_URL` ever pointed at the table
owner or a superuser, both the `REVOKE` and `FORCE ROW LEVEL SECURITY`
would be bypassed and nothing would notice.

- **Proposed likelihood 2** — requires a misconfiguration, but a silent
  one with no feedback.
- **Proposed impact 5** — it silently removes two of the three controls
  the whole tenancy story rests on.
- **Composite 10.**
- **Mitigation**: a one-line `SELECT current_user, usesuper` check at
  boot. This is the cheapest item in this paper by a wide margin
  relative to what it protects.

### P-8. Security training has never occurred

A **required** implementation specification under §164.308(a)(5), at
absolute zero, with the platform still named in placeholder brackets.

- **Proposed likelihood 5** — it is not a risk of something happening,
  it is a present state of non-compliance.
- **Proposed impact 3** — a required specification with no evidence is a
  finding in any assessment, though it harms nobody directly.
- **Composite 15.** The highest in this paper, and deliberately so: it is
  the item an assessor finds first and the cheapest to close.

---

## Part 2 — Proposed scoring change

### R-001, PHI exfiltration via application exploit — control claim needs correcting

Composite 15, the register's highest. Its current-controls column credits
"PHI redaction at the logger **and at Sentry**."

That claim was **false when written and is true today**: the 2026-08-19
tabletop verified that the worker and print-agent truncated exception
values without pattern-redacting them, and [#220] fixed it on 2026-08-20.

No score change proposed. But the text should record that the control was
absent for the period the entry claimed it, because R-001 is the
highest-rated risk in the register and an assessor will read its
controls column closely.

---

## Part 3 — Adjudications, so you do not re-litigate

**Already recorded, no action:** password breach screening (R-026),
break-glass four-eyes (R-029), Sentry PHI leak (R-018, raised to Elevated
2026-08-20), documented-guarantee pattern (R-027), degraded adapters
(R-028), no MDM (R-014).

**GO_LIVE §9 proposals**, renumbered R-030 to R-035 in [#231]:

- **R-031, alarms with no action — closed before it opened.**
  `check-alarm-actions.ts` is a pre-merge guard in `verify`, written
  because of that incident. Record as closed with the reason.
- **R-032, unvalidated intake path — still live.**
  `scripts/seed-demo-orders.ts` line 313 calls
  `prisma.prescription.create()` directly, bypassing the bus.
- **R-033, restore drill proved mechanism not data — still live.**
  Verified against the drill's own `verify.json`: every row count zero.
- **R-030, R-034, R-035** (unscreened dispensing, KB staleness,
  mixed-version deploy) — not yet adjudicated. R-035 is worth attention
  because the deploy matrix rolls services back independently, which the
  workspace rules already flag.

---

## Part 4 — The structural finding

**The triage threshold is set above the register's own ceiling.**

The threshold is composite ≥ 16. The highest entry scores 15. By the
register's own rule, **zero of 29 entries require an active mitigation
plan** — and none of the eight proposals above would reach it either.

I do not think this was deliberate. But a threshold positioned one point
above the maximum observed score is self-nullifying, and an assessor who
notices will ask whether the scoring was calibrated to avoid the
threshold or the threshold set to avoid the scoring.

Three ways out, and this is a Session 7 decision:

1. **Lower the threshold** to ≥ 12, which would activate R-001 and the
   seven entries at composite 12.
2. **Re-score honestly upward.** Several entries are plausibly
   under-scored — R-001 at impact 3 for total PHI exfiltration is
   defensible only because envelope encryption means raw DB access
   yields ciphertext.
3. **Justify the ceiling explicitly** — state that no risk currently
   reaches 16 and why, which is a legitimate position if argued.

Doing nothing is the only option that is not defensible, because the
register currently promises a triage behaviour it can never perform.

---

## What I will do once you have adjudicated

1. Write the accepted entries into the register in its existing format.
2. Apply the threshold decision.
3. Refresh `docs/security/hipaa-security-risk-analysis.md` to match.
4. Record the session in the register's reconciliation note with the
   date and what changed.
5. Prepare the SRA for signature.
