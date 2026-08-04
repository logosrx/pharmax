// Loading one RxNorm Prescribable Content release into the global
// reference tables — versioned, checksummed, idempotent, and
// atomically swapped.
//
// THE INVARIANT EVERYTHING HERE SERVES: screening must never observe a
// half-loaded release. Rows are written under a release row whose
// status is STAGED, which no reader resolves; promotion to LIVE
// happens in one transaction that also retires the previous LIVE row.
// A reader that resolved the live release id before the swap keeps
// reading a complete (old) release; one that resolves after reads a
// complete (new) one. There is no interleaving in which a screen sees
// part of each — the pointer moves, the rows never mutate.
//
// IDEMPOTENCY is the checksum, not the version string: re-running the
// job over byte-identical input is a no-op, a half-finished earlier
// attempt (STAGED or FAILED row with the same checksum) is torn down
// and reloaded, and a release OLDER than what is live is refused —
// checked cheaply up front and authoritatively inside the swap
// transaction, so two concurrent ingestions cannot leapfrog each
// other. The database backs the whole protocol with a partial unique
// index: at most one LIVE row can exist no matter what this code does.
//
// PHI: none, structurally. This module reads NLM release files and
// writes nomenclature tables; it has no access to any patient-bearing
// model and nothing it logs or throws carries anything but versions,
// counts and checksums.

import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

import type { PrismaClient } from "@pharmax/database";

import { RxnormReleaseModelBuilder, type RxnormReleaseModel } from "./rrf.js";
import { parseRxnormVersion } from "./version.js";

export const RXNORM_INGEST_ERRORS = Object.freeze({
  VERSION_INVALID: "RXNORM_VERSION_INVALID",
  FILES_MISSING: "RXNORM_RELEASE_FILES_MISSING",
  RELEASE_EMPTY: "RXNORM_RELEASE_EMPTY",
  RELEASE_NOT_NEWER: "RXNORM_RELEASE_NOT_NEWER",
  RELEASE_SUPERSEDED: "RXNORM_RELEASE_SUPERSEDED",
} as const);

/** Ingest failure with a stable, log-safe code. Never carries PHI. */
export class RxnormIngestError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RxnormIngestError";
    this.code = code;
  }
}

/** The three RRF files the mapping chain reads. */
const REQUIRED_FILES = Object.freeze(["RXNCONSO.RRF", "RXNREL.RRF", "RXNSAT.RRF"] as const);

const INSERT_BATCH_SIZE = 2000;

export interface IngestRxnormReleaseInput {
  /**
   * A client whose connection role holds the write grants on the
   * rxnorm_* tables (see the 20260809000000 migration): the singleton
   * client run from an operator shell, or the integration harness's.
   * The tables are global, so no tenancy frame is required — and the
   * job must never enter one, because ingestion has no tenant and no
   * business reading tenant rows.
   */
  readonly db: PrismaClient;
  /**
   * Directory containing the extracted release (the `rrf/` layout of
   * the NLM archive is also accepted). A file path, never a URL: what
   * gets loaded is what an operator checksummed and staged, not
   * whatever a remote endpoint serves at run time.
   */
  readonly directory: string;
  /** Release version token, MMDDYYYY (from the NLM archive name). */
  readonly version: string;
  readonly now?: Date;
}

export type IngestAction = "LOADED" | "ALREADY_LIVE";

export interface IngestRxnormReleaseSummary {
  readonly action: IngestAction;
  readonly releaseId: string;
  readonly version: string;
  readonly releasedOn: Date;
  readonly checksumSha256: string;
  readonly ndcCount: number;
  readonly ingredientLinkCount: number;
  /** See `RxnormReleaseModel.ndcsWithoutIngredients`. */
  readonly ndcsWithoutIngredients: number;
}

function resolveReleaseFiles(directory: string): ReadonlyArray<{ name: string; path: string }> {
  for (const base of [directory, join(directory, "rrf")]) {
    const candidates = REQUIRED_FILES.map((name) => ({ name, path: join(base, name) }));
    if (candidates.every((f) => existsSync(f.path))) return candidates;
  }
  throw new RxnormIngestError(
    RXNORM_INGEST_ERRORS.FILES_MISSING,
    `Release directory does not contain ${REQUIRED_FILES.join(", ")} (looked in the directory and its rrf/ subdirectory).`
  );
}

async function sha256OfFiles(
  files: ReadonlyArray<{ name: string; path: string }>
): Promise<string> {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.name);
    hash.update("\u0000");
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(file.path);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("end", resolve);
      stream.on("error", reject);
    });
    hash.update("\u0000");
  }
  return hash.digest("hex");
}

async function eachLine(path: string, onLine: (line: string) => void): Promise<void> {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) onLine(line);
}

async function parseRelease(
  files: ReadonlyArray<{ name: string; path: string }>
): Promise<RxnormReleaseModel> {
  const builder = new RxnormReleaseModelBuilder();
  const byName = new Map(files.map((f) => [f.name, f.path]));
  // Order is irrelevant to correctness (edges orient at build time),
  // but reading CONSO first keeps peak memory to the index maps.
  await eachLine(byName.get("RXNCONSO.RRF")!, (line) => builder.addConsoLine(line));
  await eachLine(byName.get("RXNREL.RRF")!, (line) => builder.addRelLine(line));
  await eachLine(byName.get("RXNSAT.RRF")!, (line) => builder.addSatLine(line));
  return builder.build();
}

function chunk<T>(items: ReadonlyArray<T>, size: number): ReadonlyArray<ReadonlyArray<T>> {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size) as T[]);
  return out;
}

/**
 * Load one release. Returns a summary; throws `RxnormIngestError` for
 * every refusal, with the release row (when one was created) marked
 * FAILED so a later run can tell "never started" from "died mid-load".
 */
export async function ingestRxnormRelease(
  input: IngestRxnormReleaseInput
): Promise<IngestRxnormReleaseSummary> {
  const now = input.now ?? new Date();

  const parsedVersion = parseRxnormVersion(input.version);
  if (parsedVersion === null) {
    throw new RxnormIngestError(
      RXNORM_INGEST_ERRORS.VERSION_INVALID,
      `"${input.version}" is not an MMDDYYYY RxNorm release version.`
    );
  }
  const { version, releasedOn } = parsedVersion;

  const files = resolveReleaseFiles(input.directory);
  const checksumSha256 = await sha256OfFiles(files);

  // Idempotency and retry handling, keyed on the checksum.
  const existing = await input.db.rxnormRelease.findUnique({ where: { checksumSha256 } });
  if (existing !== null) {
    if (existing.status === "LIVE") {
      return {
        action: "ALREADY_LIVE",
        releaseId: existing.id,
        version: existing.version,
        releasedOn: existing.releasedOn,
        checksumSha256,
        ndcCount: existing.ndcCount,
        ingredientLinkCount: existing.ingredientLinkCount,
        ndcsWithoutIngredients: 0,
      };
    }
    if (existing.status === "SUPERSEDED") {
      throw new RxnormIngestError(
        RXNORM_INGEST_ERRORS.RELEASE_SUPERSEDED,
        `Release ${existing.version} was already live once and has been superseded; re-loading it would move the knowledge backwards.`
      );
    }
    // STAGED or FAILED: a previous attempt died. Tear it down and
    // reload from scratch — deleting the release row cascades to its
    // data rows, so the retry starts clean.
    await input.db.rxnormRelease.delete({ where: { id: existing.id } });
  }

  // Cheap up-front refusal; re-checked authoritatively in the swap
  // transaction below.
  const liveBefore = await input.db.rxnormRelease.findFirst({ where: { status: "LIVE" } });
  if (liveBefore !== null && liveBefore.releasedOn >= releasedOn) {
    throw new RxnormIngestError(
      RXNORM_INGEST_ERRORS.RELEASE_NOT_NEWER,
      `Release ${version} (released ${releasedOn.toISOString().slice(0, 10)}) is not newer than the live release ` +
        `${liveBefore.version} (released ${liveBefore.releasedOn.toISOString().slice(0, 10)}); refusing to load.`
    );
  }

  const model = await parseRelease(files);
  if (model.ndcToProduct.size === 0) {
    throw new RxnormIngestError(
      RXNORM_INGEST_ERRORS.RELEASE_EMPTY,
      "Parsed release resolved zero NDC-to-ingredient mappings; refusing to load an empty knowledge base."
    );
  }

  const staged = await input.db.rxnormRelease.create({
    data: { version, releasedOn, checksumSha256, status: "STAGED" },
    select: { id: true },
  });

  try {
    const ndcRows = [...model.ndcToProduct.entries()].map(([ndc11, productRxcui]) => ({
      releaseId: staged.id,
      ndc11,
      productRxcui,
    }));
    const ingredientRows = [...model.productIngredients.entries()].flatMap(
      ([productRxcui, ingredients]) =>
        ingredients.map((ingredient) => ({
          releaseId: staged.id,
          productRxcui,
          ingredientRxcui: ingredient.rxcui,
          ingredientTty: ingredient.tty,
          ingredientName: ingredient.name,
        }))
    );

    for (const batch of chunk(ndcRows, INSERT_BATCH_SIZE)) {
      await input.db.rxnormNdcProduct.createMany({ data: [...batch] });
    }
    for (const batch of chunk(ingredientRows, INSERT_BATCH_SIZE)) {
      await input.db.rxnormProductIngredient.createMany({ data: [...batch] });
    }

    // The swap. One transaction retires the previous LIVE release and
    // promotes this one; the partial unique index turns any race two
    // concurrent ingestions could contrive into a constraint failure
    // instead of two live releases.
    await input.db.$transaction(async (tx) => {
      const live = await tx.rxnormRelease.findFirst({ where: { status: "LIVE" } });
      if (live !== null) {
        if (live.releasedOn >= releasedOn) {
          throw new RxnormIngestError(
            RXNORM_INGEST_ERRORS.RELEASE_NOT_NEWER,
            `Release ${version} is not newer than ${live.version}, which went live while this load was staging; refusing to swap.`
          );
        }
        await tx.rxnormRelease.update({
          where: { id: live.id },
          data: { status: "SUPERSEDED", supersededAt: now },
        });
      }
      await tx.rxnormRelease.update({
        where: { id: staged.id },
        data: {
          status: "LIVE",
          loadedAt: now,
          ndcCount: ndcRows.length,
          ingredientLinkCount: ingredientRows.length,
        },
      });
    });

    return {
      action: "LOADED",
      releaseId: staged.id,
      version,
      releasedOn,
      checksumSha256,
      ndcCount: ndcRows.length,
      ingredientLinkCount: ingredientRows.length,
      ndcsWithoutIngredients: model.ndcsWithoutIngredients,
    };
  } catch (cause) {
    // Mark the attempt FAILED (best-effort) so the release table
    // itself records that a load died here — and so the checksum row
    // steers a retry into the teardown path above.
    await input.db.rxnormRelease
      .update({
        where: { id: staged.id },
        data: {
          status: "FAILED",
          failedReason: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause),
        },
      })
      .catch(() => undefined);
    throw cause;
  }
}
