#!/usr/bin/env tsx
// scripts/operations/ingest-rxnorm-release.ts
//
// Load one RxNorm "Current Prescribable Content" release into the
// global drug-knowledge reference tables, or report the state of what
// is loaded. The operational surface over
// `@pharmax/drug-knowledge`'s `ingestRxnormRelease`, which owns the
// actual protocol (checksums, refuse-older, staged rows, atomic
// promotion — see that module's header).
//
// Getting a release: download RxNorm_full_prescribe_MMDDYYYY.zip from
// the NLM (https://www.nlm.nih.gov/research/umls/rxnorm/docs/prescribe.html
// — public, no UMLS licence required), extract it, and point --dir at
// the extracted directory. A FILE path by design: what gets loaded is
// what an operator staged and checksummed, never whatever a remote
// endpoint happens to serve mid-job, and tests never embed a download
// URL.
//
// Usage:
//   # Load a release (version inferred from the directory name when
//   # it still carries the NLM archive name):
//   pnpm rxnorm:ingest -- --dir=/path/to/RxNorm_full_prescribe_07072026
//
//   # Or state the version explicitly (MMDDYYYY):
//   pnpm rxnorm:ingest -- --dir=/path/to/extracted --version=07072026
//
//   # Report what is live + staleness, without loading anything:
//   pnpm rxnorm:ingest -- --check
//
// Required env:
//   DATABASE_URL   Postgres connection string whose role holds the
//                  rxnorm_* write grants (pharmax_system or the
//                  owner; pharmax_app is SELECT-only by design).
//
// Exits:
//   0  loaded, already live (idempotent re-run), or --check printed.
//   1  refused (older release, bad version, missing files) or failed.
//   2  bad arguments.
//
// Idempotent: re-running over byte-identical input is a no-op; a
// half-finished earlier attempt is torn down and reloaded; an older
// release than the live one is refused. Concurrency is safe end to
// end — the swap transaction re-checks recency and a partial unique
// index caps LIVE releases at one.
//
// PHI: none, structurally. This job reads NLM files and touches only
// the global nomenclature tables; it runs before/outside any tenancy
// and never reads a patient-bearing row. Its output is versions,
// counts and checksums.

import { basename } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

import { prisma } from "@pharmax/database";
import {
  assessRxnormStaleness,
  ingestRxnormRelease,
  rxnormVersionFromArchiveName,
  RxnormIngestError,
} from "@pharmax/drug-knowledge";

interface CliArgs {
  readonly dir: string | null;
  readonly version: string | null;
  readonly check: boolean;
}

export function parseCliArgs(argv: ReadonlyArray<string>): CliArgs | null {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        dir: { type: "string" },
        version: { type: "string" },
        check: { type: "boolean", default: false },
      },
      strict: true,
    });
  } catch {
    return null;
  }
  const dir = typeof parsed.values["dir"] === "string" ? parsed.values["dir"] : null;
  const version = typeof parsed.values["version"] === "string" ? parsed.values["version"] : null;
  const check = parsed.values["check"] === true;
  if (!check && dir === null) return null;
  return { dir, version, check };
}

async function printLiveState(now: Date): Promise<void> {
  const live = await prisma.rxnormRelease.findFirst({
    where: { status: "LIVE" },
    select: {
      version: true,
      releasedOn: true,
      loadedAt: true,
      ndcCount: true,
      ingredientLinkCount: true,
    },
  });
  if (live === null) {
    process.stdout.write(
      "No LIVE RxNorm release. PV1 screening reports NOT_PROVISIONED knowledge coverage " +
        "(informational SCR_KNOWLEDGE_UNAVAILABLE on every prescription) until one is ingested.\n"
    );
    return;
  }
  const staleness = assessRxnormStaleness({ releasedOn: live.releasedOn, now });
  process.stdout.write(
    `LIVE release ${live.version} (released ${live.releasedOn.toISOString().slice(0, 10)}, ` +
      `loaded ${live.loadedAt?.toISOString() ?? "?"}): ` +
      `${String(live.ndcCount)} NDCs, ${String(live.ingredientLinkCount)} ingredient links.\n`
  );
  if (staleness.stale) {
    process.stdout.write(
      `⚠ STALE: ${String(staleness.ageDays)} days old (threshold ${String(staleness.thresholdDays)}). ` +
        "Newly marketed NDCs will raise knowledge gaps at PV1; ingest the current NLM release.\n"
    );
  } else {
    process.stdout.write(
      `Freshness: ${String(staleness.ageDays)} days old (threshold ${String(staleness.thresholdDays)}).\n`
    );
  }
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args === null) {
    process.stderr.write(
      "Usage: pnpm rxnorm:ingest -- --dir=<extracted-release-dir> [--version=MMDDYYYY]\n" +
        "       pnpm rxnorm:ingest -- --check\n"
    );
    process.exit(2);
  }
  if (typeof process.env["DATABASE_URL"] !== "string") {
    process.stderr.write("DATABASE_URL is required.\n");
    process.exit(2);
  }

  const now = new Date();

  if (args.check) {
    await printLiveState(now);
    return;
  }

  const dir = args.dir!;
  const version = args.version ?? rxnormVersionFromArchiveName(basename(dir))?.version ?? null;
  if (version === null) {
    process.stderr.write(
      "Could not infer the release version from the directory name; pass --version=MMDDYYYY " +
        "(the token from the NLM archive name, RxNorm_full_prescribe_MMDDYYYY.zip).\n"
    );
    process.exit(2);
  }

  const summary = await ingestRxnormRelease({ db: prisma, directory: dir, version, now });

  if (summary.action === "ALREADY_LIVE") {
    process.stdout.write(
      `Release ${summary.version} is already LIVE (checksum ${summary.checksumSha256.slice(0, 12)}…); nothing to do.\n`
    );
  } else {
    process.stdout.write(
      `✓ Release ${summary.version} is LIVE: ${String(summary.ndcCount)} NDCs, ` +
        `${String(summary.ingredientLinkCount)} ingredient links ` +
        `(checksum ${summary.checksumSha256.slice(0, 12)}…).\n`
    );
    if (summary.ndcsWithoutIngredients > 0) {
      process.stdout.write(
        `  ${String(summary.ndcsWithoutIngredients)} NDC(s) in the release resolved no ingredients and were not loaded ` +
          "(they would otherwise read as ingredient-free and screen clear).\n"
      );
    }
  }
  await printLiveState(now);
}

const RUNNING_AS_SCRIPT =
  typeof process.argv[1] === "string" && process.argv[1].endsWith("ingest-rxnorm-release.ts");
if (RUNNING_AS_SCRIPT) {
  main()
    .catch((cause: unknown) => {
      if (cause instanceof RxnormIngestError) {
        process.stderr.write(`[${cause.code}] ${cause.message}\n`);
      } else {
        process.stderr.write(
          `${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}\n`
        );
      }
      process.exitCode = 1;
    })
    .finally(() => {
      void prisma.$disconnect();
    });
}
