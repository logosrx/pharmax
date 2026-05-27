#!/usr/bin/env tsx
// scripts/soc2/run-quarterly-evidence-pack.ts
//
// Orchestrator. Runs every SOC 2 evidence-collection script in turn
// and writes a `manifest.json` enumerating the resulting artifacts.
// The manifest is the auditor's index into the quarterly evidence
// pack.
//
// Failure semantics: a single script failure does NOT abort the
// pack. The orchestrator records the failure in the manifest and
// continues. The exit code is non-zero if any script failed so a
// CI/cron wrapper notices.
//
// Usage:
//   pnpm exec tsx scripts/soc2/run-quarterly-evidence-pack.ts \
//     --from=<YYYY-MM-DD> \
//     --to=<YYYY-MM-DD> \
//     [--out-dir=evidence/<YYYY-Q#>] \
//     [--dry-run]
//
// Required env (forwarded to each child script):
//   DATABASE_URL              Postgres connection string.
//   PHARMAX_LOCAL_KMS_SEED    >=32 chars.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const USAGE = `
Usage: pnpm exec tsx scripts/soc2/run-quarterly-evidence-pack.ts \\
  --from=<YYYY-MM-DD> \\
  --to=<YYYY-MM-DD> \\
  [--out-dir=evidence/<YYYY-Q#>] \\
  [--dry-run]

Runs every scripts/soc2/export-*.ts in turn into <out-dir>.
Writes <out-dir>/manifest.json describing the pack.

Required env:
  DATABASE_URL              Postgres connection string.
  PHARMAX_LOCAL_KMS_SEED    >=32 chars.
`.trim();

interface ParsedArgs {
  readonly from: string;
  readonly to: string;
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
  if (typeof values.from !== "string" || typeof values.to !== "string") {
    process.stderr.write(`--from and --to are required.\n\n${USAGE}\n`);
    process.exit(1);
  }
  return {
    from: values.from,
    to: values.to,
    ...(typeof values["out-dir"] === "string" ? { outDir: values["out-dir"] } : {}),
    dryRun: values["dry-run"] === true,
  };
}

function currentQuarterLabel(d: Date): string {
  const year = d.getUTCFullYear();
  const quarter = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${year}-Q${quarter}`;
}

interface ScriptResult {
  readonly script: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly stdoutTail: string;
  readonly stderrTail: string;
}

function runScript(scriptPath: string, args: ReadonlyArray<string>): Promise<ScriptResult> {
  return new Promise<ScriptResult>((resolveP) => {
    const start = Date.now();
    let stdoutBuf = "";
    let stderrBuf = "";
    const child = spawn("pnpm", ["exec", "tsx", scriptPath, ...args], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      resolveP({
        script: scriptPath,
        exitCode: code ?? -1,
        durationMs: Date.now() - start,
        stdoutTail: stdoutBuf.slice(-500),
        stderrTail: stderrBuf.slice(-500),
      });
    });
    child.on("error", (err) => {
      resolveP({
        script: scriptPath,
        exitCode: -1,
        durationMs: Date.now() - start,
        stdoutTail: stdoutBuf.slice(-500),
        stderrTail: `${stderrBuf}\nspawn error: ${err.message}`.slice(-500),
      });
    });
  });
}

interface ArtifactEntry {
  readonly name: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

function listArtifacts(dir: string): ReadonlyArray<ArtifactEntry> {
  let entries: ReadonlyArray<string>;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: ArtifactEntry[] = [];
  for (const e of entries) {
    if (e === "manifest.json") continue;
    const full = join(dir, e);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const buf = readFileSync(full);
    const sha256 = createHash("sha256").update(buf).digest("hex");
    out.push({ name: e, sizeBytes: buf.byteLength, sha256 });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

const SCRIPTS_IN_ORDER: ReadonlyArray<string> = [
  "export-user-roster.ts",
  "export-access-grants.ts",
  "export-clerk-session-log.ts",
  "export-change-control-summary.ts",
  "export-vendor-inventory.ts",
  "export-audit-chain-summary.ts",
  "export-incident-log.ts",
];

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));

  if (typeof process.env["DATABASE_URL"] !== "string") {
    process.stderr.write("DATABASE_URL is required.\n");
    process.exit(1);
  }
  const seed = process.env["PHARMAX_LOCAL_KMS_SEED"];
  if (typeof seed !== "string" || seed.length < 32) {
    process.stderr.write("PHARMAX_LOCAL_KMS_SEED is required (>=32 chars).\n");
    process.exit(1);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "..", "..");
  const toDate = new Date(`${args.to}T23:59:59.999Z`);
  const outDir = args.outDir ?? resolve(repoRoot, "evidence", currentQuarterLabel(toDate));

  mkdirSync(outDir, { recursive: true });

  const childArgs: ReadonlyArray<string> = [
    `--from=${args.from}`,
    `--to=${args.to}`,
    `--out-dir=${outDir}`,
    ...(args.dryRun ? ["--dry-run"] : []),
  ];

  const results: ScriptResult[] = [];
  for (const scriptName of SCRIPTS_IN_ORDER) {
    const scriptPath = join(here, scriptName);
    process.stdout.write(`[quarterly-pack] running ${scriptName}…\n`);
    const result = await runScript(scriptPath, childArgs);
    results.push(result);
    if (result.exitCode === 0) {
      process.stdout.write(`[quarterly-pack] ✓ ${scriptName} (${result.durationMs}ms)\n`);
    } else {
      process.stderr.write(
        `[quarterly-pack] ✗ ${scriptName} (exit=${result.exitCode}, ${result.durationMs}ms)\n` +
          `  stderr tail: ${result.stderrTail.trim()}\n`
      );
    }
  }

  const artifacts = listArtifacts(outDir);
  const manifest = {
    pack: currentQuarterLabel(toDate),
    period: { from: args.from, to: args.to },
    generatedAt: new Date().toISOString(),
    dryRun: args.dryRun,
    scripts: results.map((r) => ({
      script: r.script.replace(`${repoRoot}/`, ""),
      exitCode: r.exitCode,
      durationMs: r.durationMs,
    })),
    artifacts,
    notes: {
      controls:
        "Each artifact maps to one or more controls in " +
        "docs/soc2/trust-service-criteria-mapping.md. The artifact " +
        "table in docs/soc2/evidence-inventory.md is the index.",
      phiPosture:
        "No artifact in this pack contains PHI. Operator email and " +
        "display names ARE included (workforce identifiers); patient " +
        "PHI is never read.",
      secretsPosture:
        "No artifact in this pack contains secrets. KMS key material, " +
        "API keys, and webhook signing values are out of scope.",
    },
  };

  const manifestPath = resolve(outDir, "manifest.json");
  if (args.dryRun) {
    process.stdout.write(`[quarterly-pack] dry-run — would write ${manifestPath}\n`);
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } else {
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    process.stdout.write(
      `[quarterly-pack] wrote ${manifestPath} — ${artifacts.length} artifact(s), ${results.length} script(s)\n`
    );
  }

  const failures = results.filter((r) => r.exitCode !== 0).length;
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((cause: unknown) => {
  process.stderr.write(
    `\n[quarterly-pack] FATAL: ${cause instanceof Error ? cause.message : String(cause)}\n`
  );
  process.exit(1);
});
