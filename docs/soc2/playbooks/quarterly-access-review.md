# Playbook: Quarterly Access Review

| Field                | Value                                                                           |
| -------------------- | ------------------------------------------------------------------------------- |
| Controls satisfied   | CC6.1-1, CC6.1-2, CC6.2-1, CC6.2-2, CC6.5-1, P6.1-1                             |
| Cadence              | Quarterly (within first 30 days of the new quarter, covering the prior quarter) |
| Owner                | Security Officer                                                                |
| Reviewers            | Per-organization: the OrgAdmin for that organization                            |
| Final sign-off       | Security Officer                                                                |
| Evidence destination | `evidence/access-reviews/<YYYY-Q#>/`                                            |

## Purpose

Confirm that every Pharmax user has only the access required for their
role, that all access changes during the quarter were authorized, and
that no terminated user retains active access.

## Inputs

- Current state of `user`, `user_role`, `role`, and `role_permission`
  tables.
- `audit_log` rows for the quarter filtered to grant / revoke /
  break-glass / role-template-change events.
- Session log for the quarter — `auth_session` (operator console) and
  `portal_session` (provider portal), covering both session issue and
  session revocation with reason.
- Terminations from the People system for the quarter.

## Procedure

### Step 1 — Generate per-org access review reports

```sh
# Once per active organization (run for each org returned by
# `SELECT id FROM organization WHERE deletedAt IS NULL`):
pnpm tsx scripts/security/run-access-review.ts \
  --org=<organization-uuid>
```

This writes `evidence/access-reviews/<YYYY-Q#>/<org-slug>.json`.

Confirm every active organization has a report. The current set of
orgs comes from
`pnpm tsx scripts/soc2/export-vendor-inventory.ts --dry-run`'s
preamble (not the vendor list — that script also prints the active org
count) or directly from a quick query.

### Step 2 — Capture the auxiliary exports

```sh
pnpm tsx scripts/soc2/export-user-roster.ts \
  --from=<quarter-start> --to=<quarter-end>
pnpm tsx scripts/soc2/export-access-grants.ts \
  --from=<quarter-start> --to=<quarter-end>
pnpm tsx scripts/soc2/export-session-log.ts \
  --from=<quarter-start> --to=<quarter-end>
```

These produce the per-period CSV evidence under
`evidence/<YYYY-Q#>/`.

### Step 3 — Per-org reviewer walk-through

For each organization, the OrgAdmin reviews their report:

- Confirm every active user belongs in the organization and has the
  right role(s) and scope(s).
- Confirm every `staleAssignments` entry (last login > 90 days) is
  intentional or remove the assignment.
- Confirm every `principalsWithElevatedRoles` entry is justified.
- Note any unexpected grant in the quarter's `audit_log` slice.

Each finding is one of:

- **No change** — the grant is correct.
- **Revoke** — the grant is no longer needed; open a ticket to revoke
  via the standard command path (no direct DB edits).
- **Defer** — the grant is under review; document the rationale and
  the target date.

### Step 4 — Termination cross-check

Deprovisioning is **admin-initiated only**. ADR-0030 removed the
identity provider's automated `user.deleted` lane and nothing replaced
it, which is why CC6.5-1 is carried as Partial in
[`controls-inventory.md`](../controls-inventory.md). This step is
therefore not a formality that confirms automation worked — it is the
only control that detects an off-boarding nobody performed. Treat a
missing row as a finding, not as a data-quality issue.

For every termination in the quarter:

- Confirm a `DeactivateUser` entry exists in `command_log` and
  `audit_log` for that user.
- Confirm `session-revocations.csv` has that user's sessions with
  `revokedReason = USER_TERMINATED`. A user with no revocation row and
  no active-session row at termination had no live session; note that
  rather than treating the absence as evidence.
- Confirm the Pharmax `User.status` is `SUSPENDED` or `TERMINATED`
  within 24 hours of termination. (`UserStatus` has no `INACTIVE`
  member — an earlier revision of this step asked for one.)
- Confirm `user_role` rows for that user are removed (or remain only
  as historical records — the audit chain covers the revocation).

Document any miss with a remediation plan.

### Step 5 — Final sign-off

The Security Officer reviews every per-org reviewer outcome, the
auxiliary exports, and the termination cross-check, and signs:

`evidence/access-reviews/<YYYY-Q#>/signed/<org-slug>.pdf`

The sign-off is a one-page PDF naming the reviewer, the date, the
findings count by category, and the remediation tracker reference.

A copy of every sign-off PDF is bundled into the quarterly evidence
pack manifest.

## Exception handling

- **Reviewer unavailable.** The CTO is the alternate; the absence is
  noted in the sign-off.
- **A terminated user has no `DeactivateUser` record.** There is no
  backfill to run — identity is in-house and there is no upstream
  provider to reconcile against. Off-board the user through
  `DeactivateUser` now, record the gap between the termination date
  and the deactivation as a finding, and file a corrective ticket.
  This is the CC6.5-1 Partial status showing up in practice.
- **Org with no users.** Document and skip; a no-user org is either
  pre-launch or post-decommission.
