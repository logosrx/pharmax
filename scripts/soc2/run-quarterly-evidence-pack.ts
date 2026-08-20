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
// CI/cron wrapper notices, and the manifest carries `complete: false`
// so a human reading it later — when the exit code is long gone — sees
// the conclusion rather than having to scan for a non-zero exitCode.
//
// Provenance: the manifest records the host, port and database name it
// read from (never the credentials). Without that, a pack generated
// from a seeded development database is byte-indistinguishable from one
// generated against production — same artifact names, same columns, and
// seed fixtures realistic enough that the contents do not give it away.
// An auditor sampling the folder cannot tell, and neither can the
// operator who produced it. Recording the source is what keeps an
// honest mistake distinguishable from a fabrication.
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
import { mkdirSync, readdirSync, readFileSync, writeFileSync, type Dirent } from "node:fs";
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

interface PackSource {
  readonly host: string;
  readonly port: string;
  readonly database: string;
  readonly looksNonProduction: boolean;
}

/**
 * Hostnames that are never production. Used to warn, not to block: a
 * local pack is legitimate as a smoke test, and refusing to produce one
 * would just push people to run the child scripts by hand where nothing
 * records provenance at all.
 */
const NON_PRODUCTION_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "0.0.0.0",
  "host.docker.internal",
]);

const NON_PRODUCTION_HINTS: ReadonlyArray<string> = ["dev", "staging", "test", "local", "sandbox"];

/**
 * Describes WHERE the pack's data came from, so the manifest can say so.
 *
 * Without this a pack generated from a seeded development database is
 * byte-indistinguishable from one generated against production: the
 * artifacts have the same names, the same columns, and seed fixtures are
 * realistic enough that the contents do not give it away either. An
 * auditor sampling the folder a year later has no way to tell, and
 * neither has the operator who produced it.
 *
 * That makes an honest mistake indistinguishable from a fabrication,
 * which is the property worth removing. The connection string's
 * credentials are deliberately NOT recorded — host, port and database
 * name identify the source without putting a password in an artifact
 * that gets emailed to auditors.
 */
function describeSource(databaseUrl: string): PackSource {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return {
      host: "(unparseable DATABASE_URL)",
      port: "",
      database: "",
      // Fail toward suspicion: a source we cannot identify is not one we
      // should quietly treat as production.
      looksNonProduction: true,
    };
  }
  const host = parsed.hostname;
  const database = parsed.pathname.replace(/^\//, "");
  const haystack = `${host} ${database}`.toLowerCase();
  return {
    host,
    port: parsed.port,
    database,
    looksNonProduction:
      NON_PRODUCTION_HOSTS.has(host) || NON_PRODUCTION_HINTS.some((h) => haystack.includes(h)),
  };
}

interface ArtifactEntry {
  readonly name: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

function listArtifacts(dir: string): ReadonlyArray<ArtifactEntry> {
  let entries: ReadonlyArray<Dirent>;
  try {
    // The listing itself reports the entry type. Stat-then-read would
    // be a check-then-use race, and this manifest is the integrity
    // record for the pack — the bytes we hash MUST be the bytes we
    // decided to include. Symlinks stay eligible; `readFileSync`
    // follows them, as the old `statSync` check did.
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: ArtifactEntry[] = [];
  for (const e of entries) {
    if (e.name === "manifest.json") continue;
    if (!e.isFile() && !e.isSymbolicLink()) continue;
    let buf: Buffer;
    try {
      buf = readFileSync(join(dir, e.name));
    } catch {
      continue;
    }
    const sha256 = createHash("sha256").update(buf).digest("hex");
    out.push({ name: e.name, sizeBytes: buf.byteLength, sha256 });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

const SCRIPTS_IN_ORDER: ReadonlyArray<string> = [
  "export-user-roster.ts",
  "export-access-grants.ts",
  "export-session-log.ts",
  "export-change-control-summary.ts",
  "export-vendor-inventory.ts",
  "export-audit-chain-summary.ts",
  "export-incident-log.ts",
];

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));

  const databaseUrl = process.env["DATABASE_URL"];
  if (typeof databaseUrl !== "string") {
    process.stderr.write("DATABASE_URL is required.\n");
    process.exit(1);
  }
  const source = describeSource(databaseUrl);
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

  // Said before the work rather than after, so an operator who is about
  // to produce a pack from the wrong database finds out while they still
  // care, not once the folder looks finished.
  if (source.looksNonProduction) {
    process.stderr.write(
      `\n[quarterly-pack] ⚠ SOURCE DOES NOT LOOK LIKE PRODUCTION\n` +
        `  reading from ${source.host}${source.port === "" ? "" : `:${source.port}`}/${source.database}\n` +
        `  writing to   ${outDir}\n` +
        `  This pack is a smoke test, not evidence. Do not file it, and do not\n` +
        `  leave it in evidence/ where the next reader will assume otherwise.\n` +
        `  The manifest records the source so the distinction survives you.\n\n`
    );
  }

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
  const failureCount = results.filter((r) => r.exitCode !== 0).length;
  const manifest = {
    pack: currentQuarterLabel(toDate),
    period: { from: args.from, to: args.to },
    generatedAt: new Date().toISOString(),
    dryRun: args.dryRun,
    // Provenance. Credentials are excluded on purpose — this file is
    // handed to auditors.
    source: {
      host: source.host,
      port: source.port,
      database: source.database,
      looksNonProduction: source.looksNonProduction,
    },
    // A reader a year from now sees a list of script entries and would
    // otherwise have to scan for a non-zero exitCode to notice the pack
    // is partial. The exit code is gone by then; the manifest is what
    // remains, so it states the conclusion rather than only the inputs.
    complete: failureCount === 0,
    failedScriptCount: failureCount,
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

  process.exit(failureCount > 0 ? 1 : 0);
}

main().catch((cause: unknown) => {
  process.stderr.write(
    `\n[quarterly-pack] FATAL: ${cause instanceof Error ? cause.message : String(cause)}\n`
  );
  process.exit(1);
});
