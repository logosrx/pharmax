# Playbook: Vendor Risk Review

| Field                | Value                                                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Controls satisfied   | CC9.2-1, P6.1-1                                                                                                                     |
| Cadence              | Annual (each vendor refreshed on its renewal cycle) plus on-event (new vendor / decommissioning)                                    |
| Owner                | Compliance Officer                                                                                                                  |
| Reviewers            | CTO (security implications), Security Officer (PHI handling)                                                                        |
| Final sign-off       | Compliance Officer                                                                                                                  |
| Evidence destination | `evidence/vendor-soc2/<year>/`, `evidence/baa/<vendor>/`, `evidence/vendor-onboarding/<vendor>/`, `evidence/vendor-decom/<vendor>/` |

## Purpose

Confirm every vendor with access to Pharmax data has been assessed,
has the contractual instruments in place (BAA, SOC 2 report,
data-processing addendum where applicable), and that the vendor
inventory matches the systems' actual third-party dependencies.

## Inputs

- [`docs/governance/vendor-inventory.md`](../../governance/vendor-inventory.md).
- [`docs/governance/baa-tracker.md`](../../governance/baa-tracker.md).
- Actual vendor inventory derived from code (env-var inspection,
  outbound-call inspection, Terraform vendor modules).
- Vendor SOC 2 reports under `evidence/vendor-soc2/<year>/`.

## Procedure

### Step 1 — Generate the system-of-record vendor list

```sh
pnpm tsx scripts/soc2/export-vendor-inventory.ts \
  --from=<period-start> --to=<period-end>
```

Output: `evidence/<YYYY-Q#>/vendor-inventory.csv` enumerating every
vendor referenced in:

- `apps/web/src/server/env.ts` (and the equivalent in `apps/worker/`)
- Imported SDKs in `package.json` files that look like vendor clients
  (`@aws-sdk/*`, `stripe`, `easypost`, `@clerk/*`, `@sentry/*`, etc.)
- Terraform vendor modules in `infra/terraform/`

### Step 2 — Drift check

Compare the system-of-record list (step 1 output) to the inventory in
`docs/governance/vendor-inventory.md`. Every vendor present in the
system but absent from the inventory is a gap; every vendor in the
inventory not present in the system is a candidate for decommissioning.

### Step 3 — Per-vendor refresh

For each vendor in the inventory:

- **SOC 2 report.** Confirm current-year report is on file. If the
  vendor's renewal cycle has passed, request the new report.
- **BAA status.** For PHI-touching vendors, confirm BAA is executed
  and within validity window. Cross-reference
  `docs/governance/baa-tracker.md`.
- **Data scope.** Confirm the inventory's "Data accessed" column
  matches what the vendor actually receives — e.g. a vendor whose
  scope creeped to include patient identifiers needs a BAA review.
- **Sub-processors.** Confirm the vendor's published sub-processor
  list is on file under `evidence/vendor-subprocessors/<year>/`.
- **Termination posture.** Confirm Pharmax can offboard the vendor
  within the contractually agreed window without data exfiltration
  risk.

### Step 4 — New-vendor onboarding (per-event branch)

When a new vendor is added during the year, the **vendor onboarding**
sub-playbook runs:

1. Engineering opens a vendor-evaluation PR including:
   - Vendor name, category, data scope (PHI or not).
   - Expected sub-processors.
   - Authentication and credential management plan.
2. Compliance Officer evaluates:
   - SOC 2 report on file.
   - BAA executed if PHI-touching.
   - Data-processing addendum where required.
3. CTO + Security Officer co-approve.
4. Inventory row added; vendor questionnaire archived at
   `evidence/vendor-onboarding/<vendor>/questionnaire.pdf`.

### Step 5 — Vendor decommissioning (per-event branch)

When a vendor is decommissioned:

1. Engineering removes the SDK and the env-var configuration.
2. Compliance Officer issues a decommissioning notice and confirms:
   - All Pharmax data removed per the vendor's deletion policy.
   - Deletion certificate received where applicable.
   - Inventory row updated with decommissioning date; row retained
     for lineage.
3. Decommissioning checklist archived at
   `evidence/vendor-decom/<vendor>/checklist.pdf`.

### Step 6 — Final sign-off

The Compliance Officer signs:

`evidence/vendor-risk/<year>/signoff.pdf`

The sign-off lists every vendor reviewed, every gap remediated, every
new vendor onboarded, every vendor decommissioned, and any open items.

## Exception handling

- **Vendor SOC 2 lapsed.** If a vendor's SOC 2 has expired and the
  new report is not yet available, request the bridge letter; if the
  bridge letter is also missing, log the vendor as `Partial` in the
  control inventory and add to the risk register.
- **Vendor refused BAA.** Either replace the vendor or restructure
  the data scope to remove PHI from the flow. A vendor that touches
  PHI without a BAA is a critical incident.
- **Inventory drift.** Treat as a CC9.2 deficiency; reconcile before
  signing the quarterly evidence pack.
