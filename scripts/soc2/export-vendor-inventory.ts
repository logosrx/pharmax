#!/usr/bin/env tsx
// scripts/soc2/export-vendor-inventory.ts
//
// SOC 2 evidence script. Renders docs/governance/vendor-inventory.md
// into a structured CSV suitable for the quarterly evidence pack and
// for cross-referencing against BAA tracker entries.
//
// The source of truth remains the markdown file (it carries the prose
// commentary an auditor needs). This script is a faithful projection
// — every vendor row in the markdown table becomes one CSV row.
// Fields that are `[TBD by ...]` placeholders in the markdown are
// preserved verbatim in the CSV so the auditor can see what is still
// pending.
//
// Primary evidence for CC9.2-1 (vendor risk assessment) and P6.1-1
// (disclosure to third parties).
//
// PHI posture: no PHI by construction — vendor names are public
// information.
//
// Usage:
//   pnpm exec tsx scripts/soc2/export-vendor-inventory.ts \
//     [--from=<YYYY-MM-DD> --to=<YYYY-MM-DD>] \
//     [--out-dir=evidence/<YYYY-Q#>] \
//     [--dry-run]
//
// Note: --from / --to are accepted for parity with the other scripts
// but are not used (vendor inventory is current-state, not a window).
//
// No required env — this script reads a file from the repo.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

const USAGE = `
Usage: pnpm exec tsx scripts/soc2/export-vendor-inventory.ts \\
  [--from=<YYYY-MM-DD> --to=<YYYY-MM-DD>] \\
  [--out-dir=evidence/<YYYY-Q#>] \\
  [--dry-run]

Outputs:
  <out-dir>/vendor-inventory.csv

No required env.
`.trim();

interface ParsedArgs {
  readonly to: Date;
  readonly outDir?: string;
  readonly dryRun: boolean;
}

function parseCliArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      from: { type: "string" },
      to: { type: "string" },
      "out-dir": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help === true) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  const toValue = typeof values.to === "string" ? values.to : undefined;
  const to = toValue === undefined ? new Date() : new Date(`${toValue}T23:59:59.999Z`);
  if (Number.isNaN(to.getTime())) {
    process.stderr.write(`--to must be YYYY-MM-DD.\n\n${USAGE}\n`);
    process.exit(1);
  }
  return {
    to,
    ...(typeof values["out-dir"] === "string" ? { outDir: values["out-dir"] } : {}),
    dryRun: values["dry-run"] === true,
  };
}

function currentQuarterLabel(d: Date): string {
  const year = d.getUTCFullYear();
  const quarter = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${year}-Q${quarter}`;
}

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function rowToCsv(values: ReadonlyArray<string>): string {
  return values.map(csvEscape).join(",");
}

interface VendorRow {
  readonly cells: ReadonlyArray<string>;
}

/**
 * Parse a markdown table from a string. Returns null if no recognizable
 * vendor table is found. We look for the table whose header row matches
 * the documented inventory shape (starts with `Vendor`).
 */
function extractVendorTable(markdown: string): {
  header: ReadonlyArray<string>;
  rows: ReadonlyArray<VendorRow>;
} | null {
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const headerLine = lines[i];
    if (headerLine === undefined) continue;
    const headerTrim = headerLine.trim();
    if (!headerTrim.startsWith("|")) continue;
    if (!/^\|\s*Vendor\s*\|/i.test(headerTrim)) continue;
    const sepLine = lines[i + 1];
    if (sepLine === undefined) continue;
    if (!/^\|[\s:|-]+\|$/.test(sepLine.trim())) continue;
    const header = splitMarkdownRow(headerTrim);
    const rows: VendorRow[] = [];
    for (let j = i + 2; j < lines.length; j++) {
      const line = lines[j];
      if (line === undefined) break;
      const trim = line.trim();
      if (!trim.startsWith("|")) break;
      const cells = splitMarkdownRow(trim);
      rows.push({ cells });
    }
    return { header, rows };
  }
  return null;
}

function splitMarkdownRow(line: string): ReadonlyArray<string> {
  // Markdown rows look like `| a | b | c |`. We strip leading/trailing
  // bars, split on `|`, trim each cell, and strip markdown `**bold**`.
  const trimmed = line.replace(/^\|/, "").replace(/\|$/, "");
  const parts = trimmed.split("|").map((c) => c.trim());
  return parts.map((c) => c.replace(/^\*\*(.+?)\*\*$/, "$1"));
}

function main(): void {
  const args = parseCliArgs(process.argv.slice(2));

  const repoRoot = process.cwd();
  const inventoryPath = resolve(repoRoot, "docs", "governance", "vendor-inventory.md");
  let markdown: string;
  try {
    markdown = readFileSync(inventoryPath, "utf8");
  } catch {
    process.stderr.write(
      `[vendor-inventory] could not read ${inventoryPath} — vendor inventory not found.\n`
    );
    process.exit(1);
  }

  const table = extractVendorTable(markdown);
  if (table === null) {
    process.stderr.write(
      `[vendor-inventory] no recognizable vendor table found in ${inventoryPath}.\n` +
        `Expected a markdown table whose header row starts with "| Vendor |".\n`
    );
    process.exit(1);
  }

  const header = table.header;
  const lines: string[] = [rowToCsv(header)];
  for (const row of table.rows) {
    const padded = header.map((_h, idx) => row.cells[idx] ?? "");
    lines.push(rowToCsv(padded));
  }
  const body = `${lines.join("\n")}\n`;

  const outDir = args.outDir ?? resolve(repoRoot, "evidence", currentQuarterLabel(args.to));
  const outPath = resolve(outDir, "vendor-inventory.csv");

  if (args.dryRun) {
    process.stdout.write(
      `[vendor-inventory] dry-run — would write ${outPath} (${table.rows.length} vendors)\n`
    );
    process.stdout.write(body);
  } else {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, body, "utf8");
    process.stdout.write(`[vendor-inventory] wrote ${outPath} — ${table.rows.length} vendors\n`);
  }

  process.exit(0);
}

try {
  main();
} catch (cause: unknown) {
  process.stderr.write(
    `\n[vendor-inventory] FATAL: ${cause instanceof Error ? cause.message : String(cause)}\n`
  );
  process.exit(1);
}
