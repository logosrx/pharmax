# Infrastructure Access Review — Worksheet

Copy this file into `evidence/access-reviews/<YYYY-Q#>/` and fill it in. The
completed, signed copy is the artifact; this file is only the shape of it.

This worksheet covers the infrastructure half of the [access review
procedure](../governance/access-review-procedure.md) §3 — the privileged access
that exists outside the application's own RBAC tables. It is a complement to the
per-tenant report from `scripts/security/run-access-review.ts`, not a substitute
for it.

## Why this exists as its own worksheet

`run-access-review.ts` reads `User` and `UserRole` for one organization. Before
the first tenant exists that report is empty — and an empty report invites the
conclusion that there is nothing to review, which is false. The access that can
reach the production database, the KMS keys wrapping every tenant DEK, and the
deploy pipeline is entirely outside those tables and entirely real.

Once tenants exist, both reports run each quarter and both are signed.

---

## 1. Header

| Field               | Value |
| ------------------- | ----- |
| Quarter             |       |
| Date performed      |       |
| Reviewer            |       |
| Report generated at |       |
| Tenants in scope    |       |

Generate the report first:

```bash
pnpm tsx scripts/security/access-review/infrastructure-access.ts
```

It writes `evidence/access-reviews/<YYYY-Q#>/infrastructure-access.csv` and exits
non-zero if any source could not be read. **Do not sign a review with a
`*** COLLECTION FAILED ***` row still in it** — an unread source is an
unreviewed one, and a signature over it asserts something that was never
checked.

## 2. Scope statement

State plainly what this review did and did not cover. An auditor's first
question about a thin review is whether it was thin because the surface was
small or because the look was.

- **Covered by the script:** AWS account root posture, AWS IAM users, AWS
  Identity Center instances, KMS customer-managed key policies, GitHub
  collaborators, GitHub deploy keys, GitHub production-environment reviewers.
- **Covered manually below:** vendor portals, the Identity Center management
  account, database roles.
- **Deliberately out of scope:** _(state it, with the reason)_
- **Application RBAC (`run-access-review.ts`):** _(ran / not run — if not run,
  say why. "Zero organizations exist" is a complete reason.)_

## 3. Walk the CSV

Every row gets a `decision` and a `decision_reason`. The four decisions are from
procedure §5.2:

| Decision      | Meaning                                                                                                                                               |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `keep`        | Access is appropriate and current.                                                                                                                    |
| `reduce`      | Broader than needed; corrective filed to narrow it.                                                                                                   |
| `remove`      | No longer needed; corrective filed to remove it.                                                                                                      |
| `investigate` | Unfamiliar principal or unexpected pattern. Escalates to [incident response](../policies/incident-response-policy.md) at SEV2 pending classification. |

**A row left blank is itself a finding.** The report proves the data was pulled;
the decision column proves a human formed a view. Only the second one is the
control.

Pay particular attention to rows the script annotated in `notes` — missing MFA,
access keys past 90 days, administrator policies, write-capable deploy keys, key
policies naming principals beyond IAM delegation, and any section that returned
`(none found)`.

## 4. Manual surfaces

The script cannot reach these. Record each one.

| Surface                                                                                                                                                             | Who has access | Decision | Reason |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | -------- | ------ |
| AWS Identity Center — permission sets, users, groups, account assignments (enumerate from the **management account**; a member-account credential cannot see these) |                |          |        |
| Sentry — organization members and their roles                                                                                                                       |                |          |        |
| 1Password — vault membership and group access                                                                                                                       |                |          |        |
| Stripe — dashboard users _(if in use)_                                                                                                                              |                |          |        |
| PostgreSQL roles — `pharmax_app`, `pharmax_system`, and any human-attached role                                                                                     |                |          |        |
| Domain registrar and DNS                                                                                                                                            |                |          |        |

If a surface is not in use this quarter, write "not in use" rather than leaving
it blank. The distinction between "checked, nothing there" and "not checked" is
the entire value of the row.

## 5. Cross-checks

From procedure §5.3. Each is a yes/no with a note.

- [ ] **Departed users.** Every departure since the last review is absent from
      every surface above.
- [ ] **Role changes.** Every role change since the last review took effect —
      old access gone, new access present.
- [ ] **Privileged-access list.** No unexpected holder of AWS root, GitHub
      admin, Stripe owner, or `pharmax_system`.
- [ ] **BAA-vs-integration.** Every active PHI-flowing integration is backed by
      an executed BAA ([tracker](../governance/baa-tracker.md)).
- [ ] **Separation of duties.** No principal holds both `PV1_APPROVE` and
      `FINAL_APPROVE` on the same scope outside a documented training exception.
- [ ] **Service identities.** Webhook and print-agent identities have no
      human-attached interactive access.
- [ ] **KMS grants.** Reviewed as part of the CSV walk (risk register R-KMS).
- [ ] **Training completion.** Current status recorded
      ([program](../governance/security-training-program.md)).

## 6. Concentration of privilege

While Pharmax is a single-operator organization, one person holds AWS
administrator, GitHub admin, production deploy approval, and database access
simultaneously. Separation of duties is not achievable at this headcount, and
claiming otherwise in a policy would be the kind of false assurance that is
worse than an acknowledged gap.

Record the position each quarter rather than restating it once and forgetting
it, because the honest answer changes the moment a second person is hired:

- **Compensating controls relied on this quarter:** _(e.g. immutable audit
  chain with daily Merkle signing, CloudTrail to a COMPLIANCE-locked bucket,
  branch protection, deploy approval as a deliberate pause rather than a second
  pair of eyes)_
- **Has headcount changed?** _(if yes, the concentration position must be
  revisited and duties split where now possible)_
- **Break-glass:** who can reach production if the sole administrator is
  unavailable, and how is that access controlled and logged?

The last question is a contingency requirement under 45 CFR § 164.308(a)(7), not
only an access one.

## 7. Findings and corrective actions

| #   | Finding | Severity | Corrective | Owner | Due | Status |
| --- | ------- | -------- | ---------- | ----- | --- | ------ |
| 1   |         |          |            |       |     |        |

Carry anything unresolved into the next quarter's review and confirm closure
there. A corrective that neither closed nor carried forward is how a finding
becomes a repeat finding.

## 8. Sign-off

> I performed the infrastructure access review described above for the quarter
> stated in §1. I walked every row of the generated report and recorded a
> decision for each. The manual surfaces in §4 were reviewed as recorded. The
> findings in §7 are complete to the best of my knowledge, and the corrective
> actions listed have been filed.

| Field     | Value |
| --------- | ----- |
| Name      |       |
| Role      |       |
| Signature |       |
| Date      |       |

File the signed copy, the CSV with decisions filled in, and any exported vendor
listings together under `evidence/access-reviews/<YYYY-Q#>/`. Retain for six
years per 45 CFR § 164.530(j).
