#!/usr/bin/env tsx
// scripts/check-wip.ts
//
// Reports when the working tree is drifting toward an unmergeable pile.
//
// Why this exists. On 2026-08-02 this repo carried 211 uncommitted files
// spanning roughly twenty unrelated features, all sitting on `main` (the
// recovered stash was labelled literally "On main: pre-merge drafts").
// Splitting that into PRs took a day of conflict resolution, force
// pushes and worktrees — and it was LOSSY: the ADR-0033 provider-portal
// seed fixtures and two billing event exports were silently dropped, and
// only resurfaced weeks later when someone audited a leftover stash by
// chance.
//
// The pile was able to grow because every other guard in this repo sits
// DOWNSTREAM of `git commit`: pre-commit lints staged files, pre-push
// typechecks, CI does the rest. None of them can observe work that was
// never committed, so an empty terminal looked exactly like a clean
// tree. This check is the one that looks upstream.
//
// It deliberately does NOT run from pre-commit. Blocking or nagging at
// commit time punishes the exact action we want people to take more
// often; the whole failure mode here was committing too rarely. It runs
// from the Cursor `stop` hook (end of each agent turn — the moment
// accumulation actually happens) and on demand via `pnpm check:wip`.
//
// Signals, in rough order of how strongly they predict a painful split:
//
//   1. FAN-OUT — how many top-level areas the changes touch. This is a
//      better signal than raw file count: 30 files inside
//      packages/billing is a feature, while 30 files spread across
//      twelve packages is a pile that cannot become one PR.
//   2. ON TRUNK — uncommitted work on `main`. Self-reinforcing: work on
//      the trunk makes committing feel wrong, so it doesn't happen, so
//      the pile grows and committing feels even less safe.
//   3. VOLUME — raw changed-file count.
//   4. UNTRACKED SOURCE — brand-new source files. These are the ones a
//      lossy split loses ENTIRELY rather than partially, because there
//      is no diff against a committed version to notice them by.
//
// Exit codes:
//   0  No findings, or findings reported in advisory mode (the default).
//   1  Findings present and --strict was passed.
//   2  Internal error (not a git repository / git failure).

import { execFileSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * Branches that must stay clean. Committing here is blocked by
 * .husky/pre-commit; this check surfaces the condition earlier.
 */
export const TRUNK_BRANCHES: ReadonlyArray<string> = ["main", "master"];

/** Changed files above which a single reviewable PR is unlikely. */
export const FILE_COUNT_THRESHOLD = 20;

/**
 * Distinct top-level areas above which the work almost certainly wants
 * to be more than one PR. Kept low on purpose — crossing four areas
 * usually means several features are in flight at once.
 */
export const AREA_COUNT_THRESHOLD = 4;

/**
 * Mirrored in .cursor/hooks/wip-report.sh, which reimplements the fast
 * path in pure git so the hook needs no Node on PATH. The unit test
 * asserts the two stay in sync; if you change a threshold here, change
 * it there.
 */
const SOURCE_EXTENSIONS: ReadonlyArray<string> = [".ts", ".tsx", ".js", ".mjs", ".cjs", ".prisma"];

/** One line of `git status --porcelain` output, already parsed. */
export interface StatusEntry {
  /** Two-character porcelain status code, e.g. " M", "??", "A ". */
  readonly code: string;
  readonly path: string;
}

export interface WorkingTreeInput {
  readonly branch: string;
  readonly entries: ReadonlyArray<StatusEntry>;
}

export interface Finding {
  readonly signal: "fan-out" | "on-trunk" | "volume" | "untracked-source";
  readonly message: string;
  readonly remedy: string;
}

/**
 * Derives the "area" a path belongs to: the package or app that owns it.
 * `apps/web/src/x.ts` -> `apps/web`, `packages/billing/y.ts` ->
 * `packages/billing`, `prisma/seed.ts` -> `prisma`, `README.md` ->
 * `(root)`.
 */
export function areaOf(path: string): string {
  const parts = path.split("/");
  if (parts.length === 1) {
    return "(root)";
  }
  if ((parts[0] === "apps" || parts[0] === "packages") && parts.length > 2) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0] ?? "(root)";
}

const isUntracked = (code: string): boolean => code.trim() === "??";

const looksLikeSource = (path: string): boolean =>
  SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext));

/** Pure evaluation, so the thresholds are testable without a git repo. */
export function evaluateWorkingTree(input: WorkingTreeInput): ReadonlyArray<Finding> {
  const findings: Finding[] = [];
  const { branch, entries } = input;

  if (entries.length === 0) {
    return findings;
  }

  const areas = new Set(entries.map((e) => areaOf(e.path)));

  if (areas.size > AREA_COUNT_THRESHOLD) {
    findings.push({
      signal: "fan-out",
      message:
        `${entries.length} uncommitted file(s) across ${areas.size} areas ` +
        `(${[...areas].sort().slice(0, 6).join(", ")}${areas.size > 6 ? ", …" : ""}). ` +
        "Work spanning this many areas cannot become one reviewable PR.",
      remedy:
        "Commit the areas separately on their own branches now, while you still " +
        "remember which change belongs to which feature.",
    });
  }

  if (TRUNK_BRANCHES.includes(branch)) {
    findings.push({
      signal: "on-trunk",
      message:
        `${entries.length} uncommitted file(s) on "${branch}". Work on the trunk ` +
        "makes every commit feel like the wrong move, which is how it stops " +
        "happening at all.",
      remedy: "git switch -c <feature-branch>   # then commit — the changes come with you",
    });
  }

  if (entries.length > FILE_COUNT_THRESHOLD && areas.size <= AREA_COUNT_THRESHOLD) {
    // Only report volume on its own when fan-out did not already fire,
    // so a single pile doesn't produce two near-identical complaints.
    findings.push({
      signal: "volume",
      message: `${entries.length} uncommitted file(s) (threshold ${FILE_COUNT_THRESHOLD}).`,
      remedy: "Commit what is already coherent; leave only the in-progress edit dirty.",
    });
  }

  const untrackedSource = entries.filter((e) => isUntracked(e.code) && looksLikeSource(e.path));
  if (untrackedSource.length > 0) {
    findings.push({
      signal: "untracked-source",
      message:
        `${untrackedSource.length} new source file(s) are untracked. These are the ` +
        "ones a later split loses entirely — there is no committed version to " +
        "diff them against, so nothing notices they went missing.",
      remedy: `git add ${untrackedSource
        .slice(0, 3)
        .map((e) => e.path)
        .join(" ")}${untrackedSource.length > 3 ? " …" : ""}`,
    });
  }

  return findings;
}

export function parseStatusPorcelain(raw: string): ReadonlyArray<StatusEntry> {
  return raw
    .split("\n")
    .filter((line) => line.length > 3)
    .map((line) => ({
      code: line.slice(0, 2),
      // Renames appear as "old -> new"; the destination is what matters.
      path: line.slice(3).split(" -> ").at(-1) ?? line.slice(3),
    }));
}

function readWorkingTree(): WorkingTreeInput {
  const git = (args: ReadonlyArray<string>): string =>
    execFileSync("git", [...args], { encoding: "utf8" });

  return {
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
    entries: parseStatusPorcelain(git(["status", "--porcelain", "--untracked-files=all"])),
  };
}

function main(): void {
  const strict = process.argv.includes("--strict");
  const findings = evaluateWorkingTree(readWorkingTree());

  if (findings.length === 0) {
    process.stdout.write("[check-wip] ok — working tree is not accumulating\n");
    return;
  }

  const out = strict ? process.stderr : process.stdout;
  out.write(`[check-wip] ${findings.length} signal(s) that work is piling up:\n`);
  for (const f of findings) {
    out.write(`  ${f.signal}: ${f.message}\n    ${f.remedy}\n`);
  }

  if (strict) {
    process.exit(1);
  }
}

const RUNNING_AS_SCRIPT = process.argv[1] === fileURLToPath(import.meta.url);
if (RUNNING_AS_SCRIPT) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`[check-wip] internal error: ${String(err)}\n`);
    process.exit(2);
  }
}
