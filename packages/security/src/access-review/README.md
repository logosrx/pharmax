# Access Review

Produces the JSON-serializable `AccessReviewReport` that satisfies SOC 2 CC6.2
(periodic review of who has access to what).

## What the report contains

For each organization:

- A list of every active user, with:
  - The user's identity (id, email, displayName, status, Clerk linkage).
  - Every `user_role` assignment, with the role's code/name/scope and the
    tenancy-scope ids (site/clinic/team) it is restricted to.
  - The effective set of permission codes the user has via those roles.
- A reviewer's-eye summary highlighting:
  - Principals holding elevated roles (`OrgAdmin`, `Pharmacist`,
    `BillingManager`, `SecurityOfficer`, `ComplianceOfficer`,
    `PharmacistInCharge`).
  - Principals with `lastLoginAt` older than 90 days, or no `lastLoginAt`
    at all. (TODO: replace with Clerk session events once the Clerk
    `session.created.v1` outbox handler lands.)
  - Role assignments older than 365 days that should be re-justified.
  - Role codes that grant `patients.crypto_shred` — the highest-blast-radius
    permission in the platform.

The report does NOT contain PHI. It deliberately does NOT decrypt any
patient data. It does NOT include audit-log rows; auditors who need
the audit slice run a separate `verify-audit-chain-all-orgs.ts` script
and bundle the outputs together.

## How to run it

The `scripts/security/run-access-review.ts` CLI invokes the generator
once per organization. By default it **dual-writes** the evidence:

1. **Database (canonical)** — dispatches the `RecordAccessReviewSnapshot`
   tenant command, which persists an immutable `access_review_snapshot`
   row keyed by SHA-256 digest of the report, emits the
   `compliance.access_review_snapshot.recorded.v1` outbox event, and
   writes the matching `audit_log` + `command_log` entries. This is
   the row a SOC 2 auditor relies on; it is tamper-evident (the
   `digestSha256` column matches the canonical-JSON SHA-256 of the
   `report` column) and immutable (`access_review_snapshot` has no
   UPDATE / DELETE grants in production).
2. **JSON file (evidence pack)** — also writes the same report to
   `evidence/access-reviews/<YYYY-Q#>/<org-slug>.json` for the
   external evidence repository / Notion sign-off page.

```bash
pnpm tsx scripts/security/run-access-review.ts \
  --org=<org-uuid> \
  --as-user=<operator-email>
```

The operator (`--as-user`) must exist in the target organization, be
`ACTIVE`, and hold the `compliance.access_review.record` permission
(granted to `OrgAdmin` by default). The snapshot row records the
operator's id in `recordedByUserId` so SOC 2 reviewers can trace who
produced the evidence.

Flags:

- `--dry-run` — generate the report and print it to stdout; do not
  write the DB row or the JSON file. Use for previewing.
- `--skip-db` — skip the database write (back-compatible JSON-only
  mode for environments without a writable database).
- `--skip-file` — skip the JSON file write; print the resulting
  `<snapshotId>\t<digestSha256>` to stdout. Use in CI smoke checks.

The output path matches the SOC 2 evidence-repository convention in
`docs/compliance/evidence-collection-guide.md` (CC6.2 row). See
`docs/adr/0027-access-review-snapshot-persistence.md` for the design
rationale behind the database-canonical evidence model.

## How the reviewer signs off

1. Pull the report into Notion / Confluence / a Google Doc.
2. For each elevated principal: confirm with the assigning manager that
   the role is still needed.
3. For each stale assignment: re-justify or revoke (revocation goes
   through the standard `users.manage` permission, not this report).
4. For each inactive principal: deactivate if intent is to keep them
   off-platform, or document why their access is being retained.
5. Sign the document. Commit the signed PDF to the SOC 2 evidence
   repo next to the JSON.
6. Cross-reference the signed PDF against the `access_review_snapshot`
   row by quoting the row's `digestSha256` in the sign-off note. Any
   auditor can recompute the digest from the JSON file and confirm it
   matches the persisted row — a tamper-evidence check that closes
   the gap between the human sign-off and the canonical evidence row.

## Future work

- **Clerk-driven last-login:** the current `lastLoginAt` comes from
  the Pharmax `user` row, which is only updated by a successful
  sign-in callback. Wire the Clerk `session.created.v1` outbox handler
  and source this field from there. The TODO comment in
  `generate-access-review.ts` calls out the seam.
- **Diff view:** the next iteration will produce a structured diff
  against the previous quarter's report, so the reviewer only has to
  look at deltas.
- **Cross-org roll-up:** `scripts/security/run-access-review.ts` can
  iterate every organization and write one file per org; a future
  enhancement could roll the principals-with-elevated-roles list up
  into a single platform-wide summary.
