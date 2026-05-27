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

The `scripts/security/run-access-review.ts` CLI invokes this generator
once per organization and writes the JSON to
`evidence/access-reviews/<YYYY-Q#>/<org-slug>.json`.

```bash
pnpm tsx scripts/security/run-access-review.ts --org=<org-uuid>
```

The output path matches the SOC 2 evidence-repository convention in
`docs/compliance/evidence-collection-guide.md` (CC6.2 row).

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
