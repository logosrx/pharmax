#!/usr/bin/env tsx
// scripts/check-prisma-drift.ts
//
// Migration <-> schema drift guard.
//
// `prisma validate` (run by `pnpm prisma:validate`) only proves the
// schema PARSES. It does NOT prove that replaying the committed
// migrations actually reproduces `schema.prisma`. This repo writes
// migration SQL BY HAND (see any prisma/migrations/*/migration.sql),
// which is exactly where the migration history silently diverges from
// the declared model — a renamed index, a forgotten unique constraint,
// a DB-level default the schema doesn't carry. That divergence is what
// produces surprise statements the next time someone runs
// `prisma migrate dev`.
//
// This guard replays every migration into a throwaway shadow database
// and asks Prisma to diff the result against the schema datamodel:
//
//   prisma migrate diff
//     --from-migrations ./prisma/migrations
//     --to-schema       ./prisma/schema.prisma
//   (Prisma 7: `--to-schema-datamodel` was renamed to `--to-schema`,
//    and the shadow DB comes from `prisma.config.ts`'s
//    `shadowDatabaseUrl`, sourced from `SHADOW_DATABASE_URL` below,
//    rather than the removed `--shadow-database-url` flag.)
//
// The summary it prints is compared against a COMMITTED baseline
// (prisma/migrations/drift-baseline.txt). The baseline captures the
// drift we already know about and have accepted (e.g. partial unique
// indexes Prisma 5 cannot model, intentional index aliases). The guard
// fails only when the LIVE drift differs from the baseline — i.e. a NEW
// divergence was introduced, or an accepted one was resolved (good news;
// refresh the baseline to lock it in).
//
// Regenerate the baseline after an intentional reconciliation:
//   UPDATE_DRIFT_BASELINE=1 pnpm check:drift
//
// Shadow database:
//   The shadow DB must be reachable and empty (Prisma resets it). Set
//   PRISMA_DRIFT_SHADOW_DATABASE_URL, or the script derives one from
//   DATABASE_URL (db name + "_drift_shadow"), or falls back to
//   postgresql://postgres:postgres@localhost:5432/pharmax_drift_shadow.
//   Create it once with, e.g.:
//     docker exec pharmax-postgres psql -U postgres \
//       -c 'CREATE DATABASE pharmax_drift_shadow;'
//
// Exit codes:
//   0  Live drift matches the baseline (in sync), OR no reachable
//      shadow database (SKIPPED — loud, so CI without Postgres is not
//      silently green forever; integration CI provisions the DB).
//   1  Live drift differs from the baseline (NEW or RESOLVED drift).
//   2  Internal error (prisma invocation failed for a non-connection
//      reason, baseline unreadable, etc.).

import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(ROOT, "prisma", "migrations");
const SCHEMA_PATH = join(ROOT, "prisma", "schema.prisma");
const BASELINE_PATH = join(MIGRATIONS_DIR, "drift-baseline.txt");

const NO_DIFF_SENTINEL = "No difference detected.";
const BASELINE_HEADER_PREFIX = "#";

/**
 * Strip CRs, drop leading/trailing blank lines, and rstrip every line.
 * `prisma migrate diff` pads its summary with leading blank lines and
 * trailing whitespace that are not semantically meaningful.
 */
export function normalizeDiffOutput(raw: string): string {
  const lines = raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\s+$/u, ""));
  while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  const joined = lines.join("\n");
  return joined === NO_DIFF_SENTINEL ? "" : joined;
}

/**
 * Parse the committed baseline file: drop the leading `#` comment
 * header and normalize the remainder the same way live output is
 * normalized, so the two are comparable byte-for-byte.
 */
export function parseBaseline(raw: string): string {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  // Drop a contiguous leading block of comment / blank lines (the
  // human-readable header). The first non-comment, non-blank line
  // begins the captured diff body.
  let start = 0;
  while (
    start < lines.length &&
    (lines[start]!.trim() === "" || lines[start]!.startsWith(BASELINE_HEADER_PREFIX))
  ) {
    start += 1;
  }
  return normalizeDiffOutput(lines.slice(start).join("\n"));
}

export interface DriftComparison {
  /** Live drift equals the accepted baseline. */
  readonly inSync: boolean;
  /** Meaningful lines present now but absent from the baseline (NEW drift). */
  readonly added: ReadonlyArray<string>;
  /** Meaningful lines in the baseline but absent now (RESOLVED drift). */
  readonly removed: ReadonlyArray<string>;
}

/** A "meaningful" line is a non-blank diff bullet or table header. */
function meaningfulLines(normalized: string): string[] {
  return normalized
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Compare live drift against the baseline. Equality (after
 * normalization) is the pass condition; the added/removed sets exist
 * only to render an actionable report.
 */
export function compareDrift(liveNormalized: string, baselineNormalized: string): DriftComparison {
  const inSync = liveNormalized === baselineNormalized;
  const liveSet = new Set(meaningfulLines(liveNormalized));
  const baseSet = new Set(meaningfulLines(baselineNormalized));
  const added = [...liveSet].filter((l) => !baseSet.has(l)).sort();
  const removed = [...baseSet].filter((l) => !liveSet.has(l)).sort();
  return { inSync, added, removed };
}

/** Resolve the shadow database URL from env, DATABASE_URL, or a default. */
export function resolveShadowUrl(env: NodeJS.ProcessEnv): string {
  const explicit = env.PRISMA_DRIFT_SHADOW_DATABASE_URL;
  if (typeof explicit === "string" && explicit.length > 0) return explicit;

  const primary = env.DATABASE_URL;
  if (typeof primary === "string" && primary.length > 0) {
    try {
      const u = new URL(primary);
      const dbName = u.pathname.replace(/^\//, "") || "pharmax";
      u.pathname = `/${dbName}_drift_shadow`;
      // Drop query params (pgbouncer/role options) — the shadow DB is a
      // plain, owner-connected scratch database.
      u.search = "";
      return u.toString();
    } catch {
      // Fall through to the default below.
    }
  }
  return "postgresql://postgres:postgres@localhost:5432/pharmax_drift_shadow";
}

/** Heuristic: did prisma fail because the shadow DB is unreachable/missing? */
export function isConnectionFailure(stderr: string): boolean {
  return /P1001|P1003|Can't reach database server|database .* does not exist|Connection refused|ECONNREFUSED/i.test(
    stderr
  );
}

interface DiffResult {
  readonly ok: boolean;
  readonly skip: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

function runMigrateDiff(shadowUrl: string): DiffResult {
  // Prisma 7: `--shadow-database-url` was removed from `migrate diff`;
  // the shadow connection is read from `prisma.config.ts`, which sources
  // it from `SHADOW_DATABASE_URL`. We still derive that URL dynamically
  // here (per the repo's shadow-DB convention) and inject it into the
  // child env. `prisma.config.ts` also resolves `datasource.url` from
  // DIRECT_URL/DATABASE_URL; `migrate diff` does not connect to those in
  // this mode, but the config still reads them, so keep them defined.
  const childEnv = {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL ?? shadowUrl,
    DIRECT_URL: process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? shadowUrl,
    SHADOW_DATABASE_URL: shadowUrl,
  };
  const r = spawnSync(
    "pnpm",
    [
      "exec",
      "prisma",
      "migrate",
      "diff",
      "--from-migrations",
      MIGRATIONS_DIR,
      "--to-schema",
      SCHEMA_PATH,
    ],
    { cwd: ROOT, env: childEnv, encoding: "utf8" }
  );
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  if (r.error) {
    return { ok: false, skip: false, stdout, stderr: `${stderr}\n${r.error.message}` };
  }
  // Without --exit-code, prisma exits 0 whether or not a diff exists; a
  // non-zero status here means a real failure.
  if (r.status !== 0) {
    return { ok: false, skip: isConnectionFailure(stderr), stdout, stderr };
  }
  return { ok: true, skip: false, stdout, stderr };
}

function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function buildBaselineFile(liveNormalized: string): string {
  const header = [
    "# prisma/migrations/drift-baseline.txt",
    "#",
    "# ACCEPTED drift between the migration history and schema.prisma,",
    "# captured by `scripts/check-prisma-drift.ts`. Everything below this",
    "# header is verbatim `prisma migrate diff` summary output.",
    "#",
    "# This is NOT a TODO list of bugs — most entries are divergence",
    "# Prisma 5 cannot model (partial unique indexes), intentional index",
    "# aliases, or FK ordering. The guard's job is to fail when this set",
    "# CHANGES, so a NEW, unreviewed divergence cannot slip in.",
    "#",
    "# Regenerate after an intentional reconciliation (review the diff!):",
    "#   UPDATE_DRIFT_BASELINE=1 pnpm check:drift",
    "",
  ].join("\n");
  const body = liveNormalized === "" ? `${NO_DIFF_SENTINEL}\n` : `${liveNormalized}\n`;
  return `${header}${body}`;
}

function main(): void {
  const shadowUrl = resolveShadowUrl(process.env);
  const diff = runMigrateDiff(shadowUrl);

  if (!diff.ok) {
    if (diff.skip) {
      process.stdout.write(
        "[check-prisma-drift] SKIPPED — no reachable shadow database.\n" +
          `  shadow url (db name only): ${safeDbLabel(shadowUrl)}\n` +
          "  Drift is NOT verified. Provision the shadow DB to enable this guard, e.g.:\n" +
          "    docker exec pharmax-postgres psql -U postgres -c 'CREATE DATABASE pharmax_drift_shadow;'\n" +
          "  or set PRISMA_DRIFT_SHADOW_DATABASE_URL.\n"
      );
      process.exit(0);
    }
    process.stderr.write(
      `[check-prisma-drift] FATAL: prisma migrate diff failed:\n${diff.stderr.trim()}\n`
    );
    process.exit(2);
  }

  const live = normalizeDiffOutput(diff.stdout);

  if (process.env.UPDATE_DRIFT_BASELINE === "1") {
    try {
      writeFileSync(BASELINE_PATH, buildBaselineFile(live), "utf8");
    } catch (err) {
      process.stderr.write(
        `[check-prisma-drift] FATAL: cannot write ${BASELINE_PATH}: ${describeError(err)}\n`
      );
      process.exit(2);
    }
    const count = meaningfulLinesCount(live);
    process.stdout.write(
      `[check-prisma-drift] baseline updated — ${count} accepted drift line(s) written to\n  ${BASELINE_PATH}\n`
    );
    process.exit(0);
  }

  let baselineRaw: string;
  try {
    baselineRaw = readFileSync(BASELINE_PATH, "utf8");
  } catch (err) {
    process.stderr.write(
      `[check-prisma-drift] FATAL: cannot read ${BASELINE_PATH}: ${describeError(err)}\n` +
        "  Generate it once with: UPDATE_DRIFT_BASELINE=1 pnpm check:drift\n"
    );
    process.exit(2);
  }
  const baseline = parseBaseline(baselineRaw);
  const cmp = compareDrift(live, baseline);

  if (cmp.inSync) {
    const n = meaningfulLinesCount(baseline);
    process.stdout.write(
      `[check-prisma-drift] ok — live migration↔schema drift matches the accepted baseline (${n} line(s)).\n`
    );
    process.exit(0);
  }

  process.stderr.write(
    "[check-prisma-drift] DRIFT CHANGED — the migration history no longer reconciles\n" +
      "to schema.prisma in the way the committed baseline records.\n\n"
  );
  if (cmp.added.length > 0) {
    process.stderr.write(
      `NEW drift (present now, not in baseline) — ${cmp.added.length} line(s):\n`
    );
    for (const l of cmp.added) process.stderr.write(`  + ${l}\n`);
    process.stderr.write("\n");
  }
  if (cmp.removed.length > 0) {
    process.stderr.write(
      `RESOLVED drift (in baseline, gone now) — ${cmp.removed.length} line(s):\n`
    );
    for (const l of cmp.removed) process.stderr.write(`  - ${l}\n`);
    process.stderr.write("\n");
  }
  process.stderr.write(
    "Fix by one of:\n" +
      "  1. NEW drift is a real bug — fix the migration SQL or schema.prisma so\n" +
      "     replaying migrations reproduces the schema.\n" +
      "  2. The change is intentional/accepted (or RESOLVED drift) — review it,\n" +
      "     then refresh the baseline: UPDATE_DRIFT_BASELINE=1 pnpm check:drift\n"
  );
  process.exit(1);
}

function meaningfulLinesCount(normalized: string): number {
  return meaningfulLines(normalized).length;
}

/** Show only the db name from a URL so credentials never hit stdout. */
function safeDbLabel(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, "");
  } catch {
    return "(unparseable url)";
  }
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main();
}
