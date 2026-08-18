# First-Cycle Runbook

| Field          | Value                |
| -------------- | -------------------- |
| Owner          | CTO                  |
| Approver       | CEO                  |
| Effective date | 2026-08-18           |
| Last reviewed  | 2026-08-18           |
| Next review    | 2027-08-18           |
| Version        | 1.0                  |
| Distribution   | Internal — All staff |

## Why this exists

Every control in the policy bundle is designed. **None has operated.**
`evidence/access-reviews/`, `evidence/training/`, `evidence/policies/` and
`evidence/drills/` are absent directories, not empty ones.

That gap is the single largest constraint on the compliance posture, and it is
not one that more engineering can close. An assessor does not grade the policy;
they sample the artifact the policy says gets produced. Until each control has
run once, there is nothing to sample.

This runbook exists to make the first run of each control short. Every session
below is scoped to be executed by **one person**, with the data pre-pulled and
the decisions pre-framed, because a compliance exercise that needs a free
afternoon does not happen.

**Doing each of these once is worth more than doing any of them well.** A rough
first cycle that produces a filed artifact beats a perfect plan that produces
nothing, because the second cycle starts from the first one's output.

## The concentrated-roles problem, stated honestly

The policies assign work across CTO, Security Officer, Compliance Officer and
CEO. Today those are the same person.

**Do not fabricate separation that does not exist.** Signing an access review as
"Security Officer" and again as "CEO" to satisfy a form is worse than signing it
once as the person who did it — it converts an organisational reality into an
apparent misrepresentation, and it is the kind of thing that turns a finding
into a credibility problem.

The honest handling, which is also the defensible one:

1. **Sign in the role you are acting in**, and record that roles are
   concentrated. One signature from a named individual wearing an identified
   hat.
2. **Record it as a risk**, with its compensating controls, in the
   [risk register](../governance/risk-register.md): the hash-chained audit log,
   digest-sealed access-review snapshots, append-only evidence tables, and CI
   gates that no single person can silently bypass. These are genuinely strong
   and they are the reason concentration is survivable here.
3. **Note the intended separation point** — the headcount or funding event at
   which the roles split.

HIPAA does not require separation of duties for these activities. SOC 2 cares,
but it cares about _disclosed_ concentration far less than about _discovered_
concentration.

## Order

Do them in this order. It front-loads the artifact that gets sampled first and
leaves the longest-lead item running in the background.

| #   | Session                    | Time     | Produces                                       |
| --- | -------------------------- | -------- | ---------------------------------------------- |
| 0   | Verify what already runs   | 20 min   | Confidence, or a bug                           |
| 1   | Quarterly access review    | 45 min   | `evidence/access-reviews/<YYYY-Q#>/`           |
| 2   | SOC 2 evidence pack        | 15 min   | `evidence/<YYYY-Q#>/manifest.json`             |
| 3   | Policy adoption record     | 30 min   | `evidence/policies/2026/`                      |
| 4   | Security training          | 90 min   | `evidence/training/2026/`                      |
| 5   | Incident-response tabletop | 60 min   | `evidence/dr-drills/2026/incident-tabletop.md` |
| 6   | DR restore drill           | half day | `evidence/drills/2026/<drill-id>/`             |
| 7   | Annual risk assessment     | 90 min   | Updated register + SRA                         |

Sessions 1–5 are a single working day. Sessions 6 and 7 want their own slots.

---

## Session 0 — Verify what already runs (20 min)

Several controls are already automated. Confirm they are **emitting**, not merely
configured — a scheduler that boots and never runs is the most expensive kind of
false comfort, because it looks green.

```bash
aws sso login --profile pharmax-prod
```

Then check, in order:

1. **Compliance probes.** `QUARTERLY_ACCESS_REVIEW_ENABLED` defaults to `true`,
   so the worker loop should be live. Confirm `compliance_check_run` rows exist
   for the current period.
2. **Daily Merkle root.** `MERKLE_SIGNER_KMS_KEY_ID` is wired in the ECS task
   definition. Confirm signed manifests are landing in the audit-archive bucket
   and that the freshness gauge is not stale.
3. **Audit-chain verification.** Confirm the verifier has run and passed.
4. **CI scanning.** Already proven — CodeQL, Gitleaks and dependency review run
   on every pull request.

**If any of the first three has never emitted, stop and fix that before
continuing.** An automated control that has silently never run is a worse
finding than a manual one that has never been performed, because the policy
claims it is continuous.

Record the result in `evidence/policies/2026/automated-control-verification.md`
— one line per control, with the date checked and what was observed.

---

## Session 1 — Quarterly access review (45 min)

The most-sampled SOC 2 control, and the one whose absence is most conspicuous.

**Prerequisites:** production database connection, the organization UUID, your
operator email.

```bash
pnpm tsx scripts/security/run-access-review.ts \
  --org=<organization-uuid> \
  --as-user=<your-operator-email>
```

The script writes a digest-sealed `access_review_snapshot` row and a JSON report
to `evidence/access-reviews/<YYYY-Q#>/<org-slug>.json`. Run with `--dry-run`
first if you want to see the output before it is recorded.

Then walk the report and, for each section, decide and note:

- **Users** — is every account still a current worker? Anyone departed?
- **Elevated roles** — is each still justified? Elevated is `OrgAdmin`,
  `Pharmacist`, `BillingManager`, `SecurityOfficer`, `ComplianceOfficer`,
  `PharmacistInCharge`.
- **Inactive principals** — no login in 90 days. Disable or justify.
- **Stale assignments** — older than 365 days without re-justification.
- **High-risk permissions** — particularly crypto-shred.
- **Folded-in items** (see [access-review-procedure](../governance/access-review-procedure.md) §1.1):
  KMS grants, vendor portal access, BAA-vs-integration cross-check,
  privileged-access list, training completion status.

Write a short summary — what you looked at, what you changed, what you accepted
and why — and sign it. File the signed PDF next to the JSON.

**The signature is the artifact.** The JSON proves the data was pulled; the
signature proves a human looked at it and formed a view. Only the second one is
the control.

---

## Session 2 — SOC 2 evidence pack (15 min)

```bash
pnpm exec tsx scripts/soc2/run-quarterly-evidence-pack.ts \
  --from=2026-07-01 --to=2026-09-30
```

Emits user roster, access grants, session log, audit-chain summary, change
control, vendor inventory and incident log into `evidence/<YYYY-Q#>/` with a
manifest.

With [#205](https://github.com/logosrx/pharmax/pull/205) merged this now includes
a real `incident-log.csv` and `breach-register.csv` rather than the stub.

Skim the manifest for anything that looks wrong — an empty export where you
expect rows usually means a filter or a date range, not an absence.

---

## Session 3 — Policy adoption record (30 min)

The bundle took effect 2026-08-18 in the repository. That fact needs an evidence
artifact outside the repository, because "git says so" is not a signature.

1. Export the adopted bundle to PDF.
2. Sign the adoption — one signature, in your acting role, with the
   concentrated-roles note from above.
3. File at `evidence/policies/2026/`.
4. Record your own acknowledgement of the bundle. Even solo, the
   acknowledgement record is what §164.308(a)(5) asks for, and starting the
   register now means it is not reconstructed later.

---

## Session 4 — Security training (90 min)

Per [security-training-program](../governance/security-training-program.md).

Solo does not mean skipped — it means you are both the deliverer and the
audience, and the evidence is a completion record either way.

1. Complete HIPAA awareness training and core security training. Any reputable
   provider is fine; the program does not mandate a vendor.
2. Save the completion certificates.
3. Record the acknowledgement.
4. File under `evidence/training/2026/`.

The artifact an assessor wants is a **completion record with a date and a name**,
not a curriculum.

---

## Session 5 — Incident-response tabletop (60 min)

Per [incident-response playbook](../soc2/playbooks/incident-response.md) §"Annual
tabletop". Log lands at `evidence/dr-drills/2026/incident-tabletop.md`.

Solo tabletop works: you walk the scenario and write down what you would do,
where you would look, and what you could not answer. **The gaps are the output.**
A tabletop that surfaces nothing was performed wrong.

Run at least one scenario to a **completed four-factor breach assessment** using
[breach-risk-assessment-template](./breach-risk-assessment-template.md), per
[Breach Notification Policy](../policies/breach-notification-policy.md) §11.

Suggested first scenario, because it is the one your architecture actually
makes plausible:

> A carrier API error echoes a patient's name and street address into an
> exception message. The worker's Sentry initialiser does not pattern-redact.
> The event reaches Sentry. Sentry has an executed BAA as of 2026-08-18.
>
> Walk it: When was it discovered, and when _should_ it have been? Was the PHI
> unsecured? Does an exception apply? Work all four factors. What can the audit
> chain actually prove about whether it was viewed? Is it a breach? Who gets
> notified, on what clock, and does any state law shorten it?

That scenario is not hypothetical — it is the residual risk left open by the
worker/print-agent scrubber gap, so the exercise doubles as a live assessment.

---

## Session 6 — DR restore drill (half day)

The one that cannot be substituted with a tabletop. A restore never performed is
a restore you do not have.

Tooling exists and is phased:

```bash
pnpm drill:preflight            # read-only checks
pnpm drill:provision-commands   # prints the commands; you run them
pnpm drill:verify               # validates the restored instance
pnpm drill:teardown-commands    # prints teardown
pnpm drill:finalize             # writes the evidence bundle
```

Destructive steps are deliberately printed for a human rather than executed.

**Learn from the Q3 drill.** It ran against an empty database — 0 organisations,
0 rows — so it proved the mechanics and nothing about the data. Restore against a
snapshot with real row counts and assert them in the verify phase, or the drill
will again evidence only that the tooling runs.

---

## Session 7 — Annual risk assessment (90 min)

Per [risk-assessment-procedure](../governance/risk-assessment-procedure.md).
The bundle schedules this for Q2; the first one runs now because the register
needs a baseline before it can be refreshed.

Solo agenda:

1. Walk the [risk register](../governance/risk-register.md) top to bottom.
   Composite ≥ 16 needs an active mitigation plan.
2. Update the [HIPAA SRA](../security/hipaa-security-risk-analysis.md) for what
   changed: AWS and Sentry BAAs executed, MFA extended to all elevated roles,
   PHI event classification corrected, Sentry scrubbing added to the web tier.
3. Add the risks this cycle surfaced and are not yet recorded:
   - concentrated roles (above);
   - worker and print-agent Sentry initialisers not pattern-redacting;
   - MFA not revalidated on existing sessions or on role grant;
   - `order.shipment.label_purchased.v1` rejecting `FEDEX`/`UPS`, which will
     silently drop shipping audit events once EasyPost is removed.
4. Fold in the cross-incident pattern review (nothing to review this cycle —
   record that).
5. Fold in the training-program review.
6. Write the executive summary and sign.

---

## Definition of done

- [ ] Session 0 — automated controls confirmed emitting, result filed
- [ ] Session 1 — signed access review in `evidence/access-reviews/2026-Q3/`
- [ ] Session 2 — evidence pack manifest in `evidence/2026-Q3/`
- [ ] Session 3 — signed policy adoption in `evidence/policies/2026/`
- [ ] Session 4 — training completion records in `evidence/training/2026/`
- [ ] Session 5 — tabletop log with one completed four-factor assessment
- [ ] Session 6 — restore drill against non-empty data, evidence bundle filed
- [ ] Session 7 — updated register and SRA, signed
- [ ] Concentrated roles recorded as a risk with compensating controls

When all nine are checked, every control in the bundle has operated once and the
evidence locker holds a sampled-able artifact for each. That is the difference
between a designed control set and an operating one — and it is the majority of
the remaining distance to an audit-ready posture.

## Revision history

| Version | Date       | Author | Change                                                                                                                                                            |
| ------- | ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.0     | 2026-08-18 | CEO    | Initial. Sequences the first execution of every control in the adopted bundle, scoped for solo execution, with the concentrated-roles position stated explicitly. |
