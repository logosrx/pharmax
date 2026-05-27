# SOC 2 evidence collection scripts

This directory holds the scripts that produce the periodic SOC 2
evidence pack. Each script:

- Reads from the Pharmax PostgreSQL database via the singleton
  `@pharmax/database` Prisma client.
- Wraps every cross-tenant read in `withSystemContext` so RLS does not
  block the export and so the read is itself attributable in the
  audit trail.
- Outputs a CSV or JSON file under `evidence/<YYYY-Q#>/<script>.csv`
  by default. The output directory is overridable with `--out-dir`.
- Honors `--dry-run` (no file write; preamble + row count to stdout).
- Honors `--from` / `--to` for time-bounded exports.
- Honors `--help` (prints usage; exits 0 without touching the DB).
- Defends against PHI in the output at write time. `organizationId`
  and `userId` are exported as opaque UUIDs; PHI columns are never
  read.
- Documents anything it CANNOT export and why (e.g.,
  `export-incident-log.ts` notes that the `incident_log` table is
  not yet implemented and emits a stub artifact).

The companion documentation is at
[`docs/soc2/`](../../docs/soc2/), and the artifacts are catalogued in
[`docs/soc2/evidence-inventory.md`](../../docs/soc2/evidence-inventory.md).

## Quick reference

| Script                             | Output                                          | Cadence           | Controls         |
| ---------------------------------- | ----------------------------------------------- | ----------------- | ---------------- |
| `export-user-roster.ts`            | `user-roster.csv`                               | Quarterly         | CC6.1-1, CC6.5-1 |
| `export-access-grants.ts`          | `access-grants.csv`                             | Quarterly         | CC6.1-2, CC6.2-1 |
| `export-clerk-session-log.ts`      | `clerk-session-log.csv`                         | Quarterly         | CC6.1-1, CC6.5-1 |
| `export-change-control-summary.ts` | `change-control-summary.csv`                    | Quarterly         | CC8.1-1, CC8.1-2 |
| `export-vendor-inventory.ts`       | `vendor-inventory.csv`                          | Annual, on-change | CC9.2-1, P6.1-1  |
| `export-audit-chain-summary.ts`    | `audit-chain-summary.csv`                       | Quarterly         | CC7.2-2, PI1.4-2 |
| `export-incident-log.ts`           | `incident-log.csv` (or `incident-log-stub.txt`) | Quarterly         | CC7.3-1, CC7.4-1 |
| `run-quarterly-evidence-pack.ts`   | `manifest.json` + the seven above               | Quarterly         | (orchestrator)   |

## Running individual scripts

```sh
# Print usage and exit (no DB access):
pnpm exec tsx scripts/soc2/export-user-roster.ts --help

# Generate the user roster CSV for the current quarter:
pnpm exec tsx scripts/soc2/export-user-roster.ts \
  --from=2026-04-01 \
  --to=2026-06-30

# Print the data to stdout without writing the file:
pnpm exec tsx scripts/soc2/export-user-roster.ts \
  --from=2026-04-01 \
  --to=2026-06-30 \
  --dry-run
```

Every script writes to `evidence/<YYYY-Q#>/<script>.csv` by default,
where `<YYYY-Q#>` is derived from `--to`. Override with `--out-dir`.

## Running the full quarterly pack

```sh
pnpm exec tsx scripts/soc2/run-quarterly-evidence-pack.ts \
  --from=2026-04-01 \
  --to=2026-06-30
```

This runs each script in turn, captures the output into the same
`evidence/<YYYY-Q#>/` folder, and writes a `manifest.json` enumerating
every artifact (name, size, sha256, row count). The manifest is the
auditor's index into the pack.

## Required environment

All scripts that touch the database require:

| Variable                 | Purpose                                                                                                                                                                                                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`           | Postgres connection string.                                                                                                                                                                                                 |
| `PHARMAX_LOCAL_KMS_SEED` | ≥ 32-char seed for the dev KMS adapter. Required even though the scripts do not decrypt — `@pharmax/crypto` validates the seed at boot. Must match the value used by `apps/web` and `apps/worker` for envelope consistency. |

`--help` does NOT require these to be set.

## Interpreting outputs

Every CSV has a deterministic header row and ASCII-only values.
Quoting follows RFC 4180; commas in field values are double-quoted,
embedded double-quotes are doubled.

Every row in a script's output is attributable to a continuous control
in [`docs/soc2/controls-inventory.md`](../../docs/soc2/controls-inventory.md).
An auditor reading a row should be able to navigate to the control
implementation via the TSC mapping.

## What these scripts will NOT export

- **PHI.** No script reads patient, prescription, or address columns.
  The output is structural metadata only.
- **Secrets.** No script reads or emits any secret, key material, or
  webhook signing value.
- **Vendor-provided artifacts.** Vendor SOC 2 reports, BAA PDFs, and
  the like are vendor deliverables stored under
  `evidence/vendor-soc2/<year>/` and `evidence/baa/<vendor>/`; the
  scripts here index but do not generate them.

## Adding a new script

1. Place the script in this directory.
2. Follow the existing CLI contract (`--help`, `--dry-run`,
   `--from`, `--to`, `--out-dir`).
3. Use `withSystemContext` for cross-tenant reads.
4. Defend against PHI at write time.
5. Add an entry to the "Quick reference" table above and the
   `evidence-inventory.md` artifact table.
6. Wire the new script into `run-quarterly-evidence-pack.ts` if it
   should run as part of the quarterly pack.
