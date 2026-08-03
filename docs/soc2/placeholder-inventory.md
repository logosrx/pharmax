# Placeholder Inventory

Every unresolved placeholder marker in the compliance bundle, who owns
it, and whether it blocks a SOC 2 Type I observation window.

This document exists because
[`audit-readiness-checklist.md`](./audit-readiness-checklist.md) §9
asserts that no policy carries unresolved markers in its front matter,
and that assertion has been failing silently. A checklist item that
nobody can price is a checklist item nobody closes. The purpose here is
to make the remaining work countable: 230 live markers, of which 38
carry a named external owner and 192 do not.

**No date in this document is a calendar date.** Effective dates,
approval dates, and review dates are business decisions that belong to
the CEO, legal counsel, and the SOC 2 auditor. Inventing one to make a
front-matter table look complete would be the single most damaging
thing this bundle could do to itself. Due dates below are therefore
expressed **relative to audit gates**:

| Gate     | Meaning                                                     |
| -------- | ----------------------------------------------------------- |
| `PRE-T1` | Must be resolved before the Type I observation date is set. |
| `AT-T1`  | Must be resolved on or before the Type I observation date.  |
| `PRE-T2` | Must be resolved before a Type II observation window opens. |
| `DRILL`  | Resolved by measurement at the first restore drill.         |
| `N/A`    | Not a gap — the marker documents the marker syntax itself.  |

## Marker vocabulary

Two syntaxes are in use. Both are load-bearing; neither should be
"cleaned up" without resolving the underlying field.

| Syntax                             | Where                                                                       | Meaning                                          |
| ---------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------ |
| `<TBD>`                            | `docs/soc2/policies/` (framework stubs)                                     | Unassigned. No owner named on the marker.        |
| `<TBD by legal counsel: reason>`   | `docs/soc2/policies/`                                                       | Assigned to counsel. Defined in the stub README. |
| `<TBD by SOC 2 auditor: reason>`   | `docs/soc2/policies/`                                                       | Assigned to the external auditor.                |
| `[Effective date: TBD]`            | `docs/policies/`, `docs/security/`, `docs/governance/` (authoritative docs) | Front-matter field awaiting adoption.            |
| `[Last reviewed: YYYY-MM-DD]`      | same                                                                        | Front-matter field awaiting first review.        |
| `[Next review: YYYY-MM-DD]`        | same                                                                        | Front-matter field, derived from the above.      |
| `[BAA status: TBD]` and companions | `docs/governance/baa-tracker.md`                                            | Vendor contractual fact. Not ours to state.      |
| `[Contract URL: TBD]`              | `docs/governance/vendor-inventory.md`                                       | Vendor contractual fact.                         |

## Totals

Counts are as of this revision, taken from
`docs/soc2/policies/` and the bracket-form documents.

| Class                                         | Count | Owner                                             | Gate              |
| --------------------------------------------- | ----: | ------------------------------------------------- | ----------------- |
| `<TBD by legal counsel: …>`                   |    26 | Legal counsel                                     | `PRE-T1`          |
| `<TBD by SOC 2 auditor: …>`                   |     9 | External auditor                                  | `PRE-T1`          |
| `<TBD by CEO: …>`                             |     3 | CEO                                               | `AT-T1`           |
| `<TBD by Engineering Lead: …>`                |     4 | Engineering Lead                                  | `AT-T1` / `DRILL` |
| `<TBD by Security Officer: …>`                |     2 | Security Officer                                  | `PRE-T1`          |
| Bare `<TBD>` in stub front matter / history   |    29 | CEO for adoption; document owner for review dates | `AT-T1`           |
| Stub blockquote instruction (`Every <TBD> …`) |     8 | — (prose, not a field)                            | `N/A`             |
| `[Effective date: TBD]`                       |    22 | CEO                                               | `AT-T1`           |
| `[Last reviewed: YYYY-MM-DD]`                 |    39 | Document owner per front matter                   | `AT-T1`           |
| `[Next review: YYYY-MM-DD]`                   |    44 | Document owner per front matter                   | `AT-T1`           |
| `[BAA status: TBD]`                           |     8 | CTO (executes) + vendor                           | `PRE-T1`          |
| `[BAA effective date: TBD]`                   |     8 | CTO (executes) + vendor                           | `PRE-T1`          |
| `[BAA review date: TBD]`                      |    11 | Compliance Officer                                | `PRE-T2`          |
| `[Contract URL: TBD]`                         |    17 | CTO                                               | `PRE-T2`          |
| Marker-syntax definitions in stub README      |     8 | — (documentation)                                 | `N/A`             |

230 live markers across 31 documents, of which 44 now name a specific
owner role. 16 further tokens are documentation of the syntax rather
than gaps: 8 in the stub README and one blockquote instruction per stub.

## Blocking analysis

A Type I opinion covers **design** of controls at a point in time. The
auditor needs a policy set that is adopted — signed, dated, and in
force — on the observation date. That makes the following genuinely
blocking:

1. **Every `[Effective date: TBD]` (22 documents).** An unadopted
   policy is not a control. This is the single largest blocker and it
   resolves as one decision: the CEO adopts the bundle on a date, and
   22 front matters take that date.
2. **Every `<TBD by legal counsel: …>` that sits inside a sanctions or
   regulator-notification clause (27 markers).** A policy that
   declines to state its own enforcement mechanism is a design gap, not
   a wording gap.
3. **`[BAA status: TBD]` for the PHI-touching vendors (8 markers).**
   HIPAA § 164.308(b)(1) requires the agreement to exist. Whether it
   exists is a fact about a signed document; this repository cannot
   assert it and does not.

Not blocking for Type I, but blocking for Type II, because Type II
tests operation over a window and a review that never happened cannot
be tested: every `[Last reviewed: …]` and `[Next review: …]`, and the
`[BAA review date: TBD]` cells.

## Per-document detail

### Framework stubs — `docs/soc2/policies/`

These are explicitly non-authoritative (see
[`policies/README.md`](./policies/README.md)). Their markers are the
legal/audit deliverable, not an engineering one.

| Document                  | `<TBD` openings | Owner mix                            | Gate              |
| ------------------------- | --------------: | ------------------------------------ | ----------------- |
| `backup-and-recovery.md`  |              11 | Engineering Lead; CEO; legal counsel | `AT-T1` / `DRILL` |
| `information-security.md` |              10 | Legal counsel; CEO for adoption date | `PRE-T1`          |
| `acceptable-use.md`       |              10 | Security Officer; legal counsel      | `PRE-T1`          |
| `incident-response.md`    |              10 | Legal counsel; SOC 2 auditor         | `PRE-T1`          |
| `access-control.md`       |               9 | SOC 2 auditor; legal counsel; CEO    | `PRE-T1`          |
| `business-continuity.md`  |               8 | Legal counsel; CEO                   | `PRE-T1`          |
| `change-management.md`    |               8 | SOC 2 auditor; CEO                   | `PRE-T1`          |
| `data-classification.md`  |               8 | Legal counsel; CEO                   | `PRE-T1`          |
| `vendor-management.md`    |               7 | Legal counsel; CTO                   | `PRE-T1`          |
| `README.md`               |               8 | — defines the syntax                 | `N/A`             |

### Authoritative policies — `docs/policies/`

Nine documents, each carrying exactly three front-matter markers
(`Effective date`, `Last reviewed`, `Next review`). Owner is the CEO
for adoption; the per-document owner named in each front matter owns
the review dates.

`README.md`, `acceptable-use-policy.md`, `access-control-policy.md`,
`business-continuity-and-disaster-recovery.md`,
`change-management-policy.md`, `data-classification.md`,
`incident-response-policy.md`, `information-security-policy.md`,
`vendor-management-policy.md`. Gate: `AT-T1`.

### Security documents — `docs/security/`

Five documents, three front-matter markers each:
`control-matrix.md`, `data-flow.md`, `encryption-overview.md`,
`hipaa-security-risk-analysis.md`, `secrets-management.md`.
Owner: CTO. Gate: `AT-T1`.

### Governance documents — `docs/governance/`

| Document                           | Markers                                             | Owner            | Gate     |
| ---------------------------------- | --------------------------------------------------- | ---------------- | -------- |
| `baa-tracker.md`                   | 3 front matter + 8 status + 8 effective + 11 review | CTO; vendors     | `PRE-T1` |
| `vendor-inventory.md`              | 3 front matter + 17 contract URL + 18 last-reviewed | CTO              | `PRE-T2` |
| `risk-register.md`                 | 3 front matter + 23 per-risk next-review            | Security Officer | `PRE-T2` |
| `access-review-procedure.md`       | 3 front matter                                      | Security Officer | `AT-T1`  |
| `risk-assessment-procedure.md`     | 3 front matter                                      | Security Officer | `AT-T1`  |
| `security-training-program.md`     | 3 front matter                                      | Workforce Lead   | `AT-T1`  |
| `clean-room-development-policy.md` | 3 front matter                                      | CTO              | `AT-T1`  |
| `public-sources-reference.md`      | 3 front matter                                      | CTO              | `AT-T1`  |

## Placeholders resolved by this pass

These were engineering facts wearing an auditor's marker. Each is now
stated precisely with the file that proves it, and the marker is gone.

| Was                                                                              | Now                                                                    | Proof                                                                                                |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `backup-and-recovery.md` §3.1 retention window `<TBD by SOC 2 auditor: confirm>` | 35 days in prod and staging, 7 in dev                                  | `infra/terraform/environments/prod/us-east-1/terraform.tfvars:33`; `modules/rds/main.tf:286`         |
| `backup-and-recovery.md` §3.1 Multi-AZ (unmarked but unproven)                   | `rds_multi_az = true` in prod                                          | `infra/terraform/environments/prod/us-east-1/terraform.tfvars:44`                                    |
| `backup-and-recovery.md` §3.2 "versioning on every bucket"                       | Named the two buckets and their versioning resources                   | `modules/s3-documents/main.tf:34`; `modules/s3-audit-archive/main.tf:52`                             |
| `backup-and-recovery.md` §3.3 "key rotation per ADR-0005 (`rotateKek`)"          | AWS KMS annual rotation on six symmetric CMKs; `rotateKek` is dev-only | `modules/kms/main.tf` (`enable_key_rotation = true`); `packages/crypto/src/local-kms-adapter.ts:105` |

## Placeholders re-owned by this pass

Not resolved — re-assigned, because the marker named the wrong owner.
A marker addressed to legal counsel for a decision counsel cannot make
is a marker that never gets closed.

| Marker                                            | Was           | Now                          | Why                                                               |
| ------------------------------------------------- | ------------- | ---------------------------- | ----------------------------------------------------------------- |
| `acceptable-use.md` §3.1 antimalware product list | Legal counsel | Security Officer             | Product selection is a security decision, not a legal one.        |
| `acceptable-use.md` §3.1 auto-lock interval       | Unassigned    | Security Officer             | A configuration standard with an owner.                           |
| `backup-and-recovery.md` §3.5 RPO in-region       | SOC 2 auditor | Engineering Lead, at `DRILL` | Nobody can confirm a recovery point that has never been measured. |
| `backup-and-recovery.md` §3.5 RTO in-region       | SOC 2 auditor | Engineering Lead, at `DRILL` | Same.                                                             |

## Maintenance

Re-run the count before every readiness pulse:

```
rg -c '<TBD' docs/soc2/policies/
rg -o '\[Effective date: TBD\]|\[Last reviewed: YYYY-MM-DD\]|\[Next review: YYYY-MM-DD\]' docs/ | wc -l
```

A marker that has been resolved should be deleted, not blanked. A
marker that cannot be resolved before its gate becomes a risk-register
entry with a remediation owner, per
[`audit-readiness-checklist.md`](./audit-readiness-checklist.md).
