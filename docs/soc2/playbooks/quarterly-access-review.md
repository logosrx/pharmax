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
- Clerk session log for the quarter (last login per user).
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
pnpm tsx scripts/soc2/export-clerk-session-log.ts \
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

For every termination in the quarter:

- Confirm the corresponding `clerk_webhook_event` row exists with
  `eventType = 'user.deleted'` (or `'user.updated'` flipping to
  banned, depending on the off-boarding flow).
- Confirm the Pharmax `User.status` flipped to `INACTIVE` within 24
  hours of termination.
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
- **Discrepancy between Clerk and Pharmax user state.** Run the Clerk
  webhook backfill (see [`docs/RUNBOOK.md`](../../RUNBOOK.md)
  "Webhook backfill" section) and re-run the review for the affected
  org.
- **Org with no users.** Document and skip; a no-user org is either
  pre-launch or post-decommission.
