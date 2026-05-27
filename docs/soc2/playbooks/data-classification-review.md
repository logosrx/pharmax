# Playbook: Data Classification Review

| Field                | Value                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------- |
| Controls satisfied   | C1.1-1, C1.1-2, C1.1-3, C1.1-4, P3.1-1                                                |
| Cadence              | Annual (or on any new data-bearing column / new document type / new vendor PHI scope) |
| Owner                | Compliance Officer                                                                    |
| Reviewers            | CTO (engineering), Security Officer (PHI handling)                                    |
| Final sign-off       | Compliance Officer + Security Officer co-sign                                         |
| Evidence destination | `evidence/data-classification/<year>/`                                                |

## Purpose

Confirm Pharmax's data-classification policy is reflected in code: PHI
columns are encrypted, blind-index columns have documented purposes,
documents carry classification, retention windows are honored, and no
unclassified PHI field has crept into the schema.

## Inputs

- [`docs/policies/data-classification.md`](../../policies/data-classification.md)
  (four tiers: Public / Internal / Confidential / Restricted-PHI).
- `prisma/schema.prisma` at period-end commit.
- `packages/database/src/phi/blind-index-purposes.ts` purpose registry.
- `@pharmax/documents` document-storage port classification inputs
  (ADR-0021).
- Vendor inventory's "Data accessed" column.

## Procedure

### Step 1 — Schema sweep

Run the schema linter for context:

```sh
pnpm run check:schema
```

Confirm:

- Every `*Enc` column is `Json` (linter rule R7).
- Every `*Bi` column has a sibling PHI source (linter rule R6).
- Every tenant-scoped model has RLS policies (cross-check
  `pnpm run check:migrations`).

Then walk the schema models manually for PHI columns. For each PHI
column:

- Is it encrypted (suffix `Enc`)? If not, document why (e.g., it is
  a non-PHI identifier; this is rare).
- Is its blind-index purpose registered (suffix `Bi`)?
- Is its `@@map` snake_case and named consistently?

### Step 2 — Blind-index purpose registry review

Open `packages/database/src/phi/blind-index-purposes.ts`. Confirm:

- Every `*Bi` column in the schema has a registered purpose.
- No two purposes collide.
- Related-but-distinct purposes (`dobBi` vs `dobYearMonthBi`) do not
  cross-contaminate.

The contract test in the package enforces the above; the review is a
human re-read to catch semantic drift the test cannot.

### Step 3 — Document storage classification review

Walk every call site of the `@pharmax/documents` port and confirm:

- Every call provides a classification value.
- The bucket the call lands in matches the classification (PHI →
  HIPAA-eligible bucket; PUBLIC → public bucket if any).
- The signed-URL TTL for PHI classifications is short
  (≤ 5 minutes per ADR-0021).

### Step 4 — Vendor data-scope review

For each vendor in the inventory:

- Cross-check the "Data accessed" column against actual flows. If the
  vendor receives PHI by linkage (e.g. recipient address tied to a
  pharmacy order = PHI), the inventory must mark it as PHI and a BAA
  must be on file.
- Note any vendor whose data scope changed during the year.

### Step 5 — Retention window review

For each data class, confirm:

- The documented retention window in the data-classification policy
  is implemented somewhere — column-level shred path for PHI, S3
  lifecycle rules for documents, log retention for application logs
  (CloudWatch and Sentry), audit-log retention (perpetual; documented
  as such).
- Any drift between policy retention and actual retention is a
  control deficiency.

### Step 6 — Minimum-necessary review

Walk the PHI column set with the CTO and confirm each column is
actually used downstream. A PHI column that is collected but never
used is a HIPAA minimum-necessary violation candidate. Document the
finding; the remediation is either (a) demonstrate the downstream use,
or (b) deprecate the column with a shred plan.

### Step 7 — Final sign-off

The Compliance Officer and Security Officer co-sign:

`evidence/data-classification/<year>/signoff.pdf`

The sign-off enumerates the PHI column set, the blind-index purpose
set, the document classification audit results, the vendor data-scope
audit results, and any remediation items.

## Exception handling

- **Unclassified PHI column found.** Treat as a critical control
  deficiency. Classify the column immediately, retrofit envelope
  encryption, add a blind-index purpose if searchable, and document
  the gap in the risk register.
- **Vendor scope creep.** Either restructure the data flow to remove
  PHI from the vendor or execute a BAA before the next period.
- **Document storage call without classification.** TypeScript
  enforces the classification input at the port — the linter catches
  any bypass. If a bypass is found, treat as a CC8.1 / C1.1
  deficiency.
