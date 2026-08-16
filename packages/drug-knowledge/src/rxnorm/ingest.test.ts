// The versioned release-load protocol against an in-memory Prisma
// double. What the double proves: the checksum idempotency ladder
// (ALREADY_LIVE / SUPERSEDED / teardown-and-reload), the refusal to
// load stale releases, the FAILED marking on a mid-load crash, and
// the STAGED→LIVE swap retiring exactly one previous LIVE. Behaviour
// against real Postgres — including the partial unique index that
// backs "at most one LIVE" under true concurrency — is pinned in
// packages/integration-tests/src/rxnorm-drug-knowledge.test.ts.
//
// FIXTURE DATA IS SYNTHETIC by clean-room rule: fake RXCUIs in the
// 9xxxxx range, fake NDCs in the 99999… labeler space. Only the FILE
// FORMAT is real (public NLM RxNorm Technical Documentation).

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import type { PrismaClient } from "@pharmax/database";

import { ingestRxnormRelease, RxnormIngestError, RXNORM_INGEST_ERRORS } from "./ingest.js";

// -- RRF line constructors (public column layouts) ---------------------

/** RXNCONSO: 18 fields. rxcui[0], SAB[11], TTY[12], STR[14], SUPPRESS[16]. */
function conso(rxcui: string, tty: string, name: string): string {
  const f = new Array<string>(18).fill("");
  f[0] = rxcui;
  f[11] = "RXNORM";
  f[12] = tty;
  f[14] = name;
  f[16] = "N";
  return f.join("|");
}

/** RXNREL: 16 fields. rxcui1[0], rxcui2[4], RELA[7], SAB[10]. */
function rel(a: string, b: string, rela: string): string {
  const f = new Array<string>(16).fill("");
  f[0] = a;
  f[4] = b;
  f[7] = rela;
  f[10] = "RXNORM";
  return f.join("|");
}

/** RXNSAT: 13 fields. rxcui[0], ATN[8], SAB[9], ATV[10]. */
function sat(rxcui: string, ndc: string): string {
  const f = new Array<string>(13).fill("");
  f[0] = rxcui;
  f[8] = "NDC";
  f[9] = "RXNORM";
  f[10] = ndc;
  return f.join("|");
}

// One resolvable chain (IN 900001 → SCDC 910001 → SCD 920001 with NDC
// 99999000101) plus one no-ingredient product (SCD 920002, NDC
// 99999000401) that the model drops and counts.
function releaseFileContents(variant: string): Record<string, string> {
  return {
    "RXNCONSO.RRF": [
      conso("900001", "IN", `FIXTURE-INGREDIENT-${variant}`),
      conso("910001", "SCDC", `FIXTURE-COMPONENT-${variant}`),
      conso("920001", "SCD", `FIXTURE-DRUG-${variant}`),
      conso("920002", "SCD", `FIXTURE-DRUG-NO-ING-${variant}`),
    ].join("\n"),
    "RXNREL.RRF": [
      rel("920001", "910001", "consists_of"),
      rel("900001", "910001", "has_ingredient"),
    ].join("\n"),
    "RXNSAT.RRF": [sat("920001", "99999000101"), sat("920002", "99999000401")].join("\n"),
  };
}

const tempDirs: string[] = [];

async function writeReleaseDir(input: {
  variant: string;
  layout?: "flat" | "rrf";
  omit?: string;
  files?: Record<string, string>;
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pharmax-rxnorm-"));
  tempDirs.push(dir);
  const base = input.layout === "rrf" ? join(dir, "rrf") : dir;
  if (input.layout === "rrf") await mkdir(base, { recursive: true });
  const files = input.files ?? releaseFileContents(input.variant);
  for (const [name, contents] of Object.entries(files)) {
    if (name === input.omit) continue;
    await writeFile(join(base, name), contents, "utf8");
  }
  return dir;
}

// -- In-memory Prisma double -------------------------------------------

type FakeReleaseStatus = "STAGED" | "LIVE" | "SUPERSEDED" | "FAILED";

interface FakeReleaseRow {
  id: string;
  version: string;
  releasedOn: Date;
  checksumSha256: string;
  status: FakeReleaseStatus;
  ndcCount: number;
  ingredientLinkCount: number;
  loadedAt: Date | null;
  supersededAt: Date | null;
  failedReason: string | null;
}

interface FakeNdcRow {
  releaseId: string;
  ndc11: string;
  productRxcui: string;
}

interface FakeIngredientRow {
  releaseId: string;
  productRxcui: string;
  ingredientRxcui: string;
  ingredientTty: string;
  ingredientName: string;
}

class FakeRxnormDb {
  public releases: FakeReleaseRow[] = [];
  public ndcRows: FakeNdcRow[] = [];
  public ingredientRows: FakeIngredientRow[] = [];
  /** Invoked before the first rxnormNdcProduct.createMany of a load. */
  public onFirstNdcCreateMany: (() => void) | null = null;
  /** When set, rxnormRelease.update for this id throws once. */
  public updateThrowsForId: string | null = null;
  private seq = 0;

  readonly rxnormRelease = {
    findUnique: async (args: { where: { checksumSha256: string } }) =>
      this.releases.find((r) => r.checksumSha256 === args.where.checksumSha256) ?? null,
    findFirst: async (args: { where: { status: FakeReleaseStatus } }) =>
      this.releases.find((r) => r.status === args.where.status) ?? null,
    create: async (args: {
      data: {
        version: string;
        releasedOn: Date;
        checksumSha256: string;
        status: FakeReleaseStatus;
      };
    }) => {
      const row: FakeReleaseRow = {
        id: `release-${++this.seq}`,
        version: args.data.version,
        releasedOn: args.data.releasedOn,
        checksumSha256: args.data.checksumSha256,
        status: args.data.status,
        ndcCount: 0,
        ingredientLinkCount: 0,
        loadedAt: null,
        supersededAt: null,
        failedReason: null,
      };
      this.releases.push(row);
      return { id: row.id };
    },
    delete: async (args: { where: { id: string } }) => {
      // Emulates the schema's ON DELETE CASCADE onto the data tables.
      this.releases = this.releases.filter((r) => r.id !== args.where.id);
      this.ndcRows = this.ndcRows.filter((r) => r.releaseId !== args.where.id);
      this.ingredientRows = this.ingredientRows.filter((r) => r.releaseId !== args.where.id);
      return {};
    },
    update: async (args: { where: { id: string }; data: Partial<FakeReleaseRow> }) => {
      if (this.updateThrowsForId === args.where.id) {
        this.updateThrowsForId = null;
        throw new Error("fake db: connection lost while updating release row");
      }
      const row = this.releases.find((r) => r.id === args.where.id);
      if (row === undefined) throw new Error(`fake db: no release row ${args.where.id}`);
      Object.assign(row, args.data);
      return row;
    },
  };

  readonly rxnormNdcProduct = {
    createMany: async (args: { data: FakeNdcRow[] }) => {
      const hook = this.onFirstNdcCreateMany;
      this.onFirstNdcCreateMany = null;
      hook?.();
      this.ndcRows.push(...args.data.map((r) => ({ ...r })));
      return { count: args.data.length };
    },
  };

  readonly rxnormProductIngredient = {
    createMany: async (args: { data: FakeIngredientRow[] }) => {
      this.ingredientRows.push(...args.data.map((r) => ({ ...r })));
      return { count: args.data.length };
    },
  };

  /** Rolls every table back when the callback throws — a real
   * transaction leaves no partial swap behind, and neither may the
   * double, or the atomicity assertions would pass vacuously. */
  readonly $transaction = async <T>(fn: (tx: this) => Promise<T>): Promise<T> => {
    const releases = this.releases.map((r) => ({ ...r }));
    const ndcRows = this.ndcRows.map((r) => ({ ...r }));
    const ingredientRows = this.ingredientRows.map((r) => ({ ...r }));
    try {
      return await fn(this);
    } catch (error) {
      this.releases = releases;
      this.ndcRows = ndcRows;
      this.ingredientRows = ingredientRows;
      throw error;
    }
  };

  asClient(): PrismaClient {
    return this as unknown as PrismaClient;
  }

  liveRows(): FakeReleaseRow[] {
    return this.releases.filter((r) => r.status === "LIVE");
  }
}

const NOW = new Date("2026-08-10T12:00:00Z");

async function loadVariant(
  db: FakeRxnormDb,
  input: { variant: string; version: string; now?: Date }
) {
  const directory = await writeReleaseDir({ variant: input.variant });
  return ingestRxnormRelease({
    db: db.asClient(),
    directory,
    version: input.version,
    now: input.now ?? NOW,
  });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ingestRxnormRelease — first load", () => {
  it("loads a release, promotes it LIVE, and reports honest counts", async () => {
    const db = new FakeRxnormDb();
    const summary = await loadVariant(db, { variant: "ALFA", version: "07072026" });

    expect(summary.action).toBe("LOADED");
    expect(summary.version).toBe("07072026");
    expect(summary.releasedOn).toEqual(new Date(Date.UTC(2026, 6, 7)));
    expect(summary.ndcCount).toBe(1);
    expect(summary.ingredientLinkCount).toBe(1);
    expect(summary.ndcsWithoutIngredients).toBe(1);

    expect(db.releases).toHaveLength(1);
    const row = db.releases[0]!;
    expect(row.status).toBe("LIVE");
    expect(row.loadedAt).toEqual(NOW);
    expect(row.ndcCount).toBe(1);
    expect(row.ingredientLinkCount).toBe(1);
    expect(db.ndcRows).toEqual([
      { releaseId: row.id, ndc11: "99999000101", productRxcui: "920001" },
    ]);
    expect(db.ingredientRows).toEqual([
      {
        releaseId: row.id,
        productRxcui: "920001",
        ingredientRxcui: "900001",
        ingredientTty: "IN",
        ingredientName: "FIXTURE-INGREDIENT-ALFA",
      },
    ]);
  });

  it("accepts the NLM archive's rrf/ subdirectory layout", async () => {
    const db = new FakeRxnormDb();
    const directory = await writeReleaseDir({ variant: "ALFA", layout: "rrf" });
    const summary = await ingestRxnormRelease({
      db: db.asClient(),
      directory,
      version: "07072026",
      now: NOW,
    });
    expect(summary.action).toBe("LOADED");
    expect(db.liveRows()).toHaveLength(1);
  });

  it("defaults the clock when `now` is omitted", async () => {
    const db = new FakeRxnormDb();
    const directory = await writeReleaseDir({ variant: "ALFA" });
    await ingestRxnormRelease({ db: db.asClient(), directory, version: "07072026" });
    expect(db.releases[0]!.loadedAt).toBeInstanceOf(Date);
  });
});

describe("ingestRxnormRelease — up-front refusals (nothing staged)", () => {
  it("rejects a non-MMDDYYYY version before touching the database", async () => {
    const db = new FakeRxnormDb();
    const directory = await writeReleaseDir({ variant: "ALFA" });
    await expect(
      ingestRxnormRelease({ db: db.asClient(), directory, version: "2026-07-07", now: NOW })
    ).rejects.toMatchObject({
      name: "RxnormIngestError",
      code: RXNORM_INGEST_ERRORS.VERSION_INVALID,
    });
    expect(db.releases).toHaveLength(0);
  });

  it("rejects an impossible calendar date (Date.UTC rollover is not a release)", async () => {
    const db = new FakeRxnormDb();
    const directory = await writeReleaseDir({ variant: "ALFA" });
    await expect(
      ingestRxnormRelease({ db: db.asClient(), directory, version: "02302026", now: NOW })
    ).rejects.toMatchObject({ code: RXNORM_INGEST_ERRORS.VERSION_INVALID });
    expect(db.releases).toHaveLength(0);
  });

  it("rejects a directory missing a required RRF file", async () => {
    const db = new FakeRxnormDb();
    const directory = await writeReleaseDir({ variant: "ALFA", omit: "RXNSAT.RRF" });
    await expect(
      ingestRxnormRelease({ db: db.asClient(), directory, version: "07072026", now: NOW })
    ).rejects.toMatchObject({ code: RXNORM_INGEST_ERRORS.FILES_MISSING });
    expect(db.releases).toHaveLength(0);
  });

  it("refuses an empty release — zero NDC mappings never reaches STAGED", async () => {
    const db = new FakeRxnormDb();
    const files = releaseFileContents("ALFA");
    const directory = await writeReleaseDir({
      variant: "ALFA",
      files: { ...files, "RXNSAT.RRF": "" },
    });
    await expect(
      ingestRxnormRelease({ db: db.asClient(), directory, version: "07072026", now: NOW })
    ).rejects.toMatchObject({ code: RXNORM_INGEST_ERRORS.RELEASE_EMPTY });
    expect(db.releases).toHaveLength(0);
    expect(db.ndcRows).toHaveLength(0);
  });

  it("refuses a release older than the live one, leaving the live release untouched", async () => {
    const db = new FakeRxnormDb();
    await loadVariant(db, { variant: "BRAVO", version: "08072026" });
    await expect(loadVariant(db, { variant: "ALFA", version: "07072026" })).rejects.toMatchObject({
      code: RXNORM_INGEST_ERRORS.RELEASE_NOT_NEWER,
    });
    expect(db.releases).toHaveLength(1);
    expect(db.releases[0]!.status).toBe("LIVE");
    expect(db.releases[0]!.version).toBe("08072026");
  });

  it("refuses modified bytes under the live version string (checksum mismatch), staging nothing", async () => {
    // Same MMDDYYYY version, different file contents → different
    // checksum, so this is NOT the idempotent re-run path; equal
    // releasedOn fails the "strictly newer" gate instead. The live
    // release keeps serving.
    const db = new FakeRxnormDb();
    await loadVariant(db, { variant: "ALFA", version: "07072026" });
    await expect(
      loadVariant(db, { variant: "ALFA-TAMPERED", version: "07072026" })
    ).rejects.toMatchObject({ code: RXNORM_INGEST_ERRORS.RELEASE_NOT_NEWER });
    expect(db.releases).toHaveLength(1);
    expect(db.releases[0]!.status).toBe("LIVE");
  });
});

describe("ingestRxnormRelease — checksum idempotency ladder", () => {
  it("is a no-op (ALREADY_LIVE) when byte-identical input is already live", async () => {
    const db = new FakeRxnormDb();
    const first = await loadVariant(db, { variant: "ALFA", version: "07072026" });
    const again = await loadVariant(db, { variant: "ALFA", version: "07072026" });

    expect(again.action).toBe("ALREADY_LIVE");
    expect(again.releaseId).toBe(first.releaseId);
    expect(again.checksumSha256).toBe(first.checksumSha256);
    expect(again.ndcCount).toBe(1);
    // No duplicate release row, no duplicate data rows.
    expect(db.releases).toHaveLength(1);
    expect(db.ndcRows).toHaveLength(1);
    expect(db.ingredientRows).toHaveLength(1);
  });

  it("refuses to re-load a SUPERSEDED release (knowledge never moves backwards)", async () => {
    const db = new FakeRxnormDb();
    await loadVariant(db, { variant: "ALFA", version: "07072026" });
    await loadVariant(db, { variant: "BRAVO", version: "08072026" });
    await expect(loadVariant(db, { variant: "ALFA", version: "07072026" })).rejects.toMatchObject({
      code: RXNORM_INGEST_ERRORS.RELEASE_SUPERSEDED,
    });
    expect(db.liveRows().map((r) => r.version)).toEqual(["08072026"]);
  });

  it("tears down a FAILED earlier attempt and reloads clean (no duplicate rows)", async () => {
    const db = new FakeRxnormDb();
    db.onFirstNdcCreateMany = () => {
      throw new Error("fake db: insert died mid-load");
    };
    await expect(loadVariant(db, { variant: "ALFA", version: "07072026" })).rejects.toThrow(
      "insert died mid-load"
    );
    const failedId = db.releases[0]!.id;
    expect(db.releases[0]!.status).toBe("FAILED");

    const retry = await loadVariant(db, { variant: "ALFA", version: "07072026" });
    expect(retry.action).toBe("LOADED");
    expect(db.releases).toHaveLength(1);
    expect(db.releases[0]!.id).not.toBe(failedId);
    expect(db.releases[0]!.status).toBe("LIVE");
    expect(db.ndcRows).toHaveLength(1);
    expect(db.ingredientRows).toHaveLength(1);
  });
});

describe("ingestRxnormRelease — mid-load crash", () => {
  it("marks the release FAILED with the reason and leaves the prior LIVE untouched", async () => {
    const db = new FakeRxnormDb();
    await loadVariant(db, { variant: "ALFA", version: "07072026" });

    db.onFirstNdcCreateMany = () => {
      throw new Error("fake db: insert died mid-load");
    };
    await expect(loadVariant(db, { variant: "BRAVO", version: "08072026" })).rejects.toThrow(
      "insert died mid-load"
    );

    const failed = db.releases.find((r) => r.version === "08072026")!;
    expect(failed.status).toBe("FAILED");
    expect(failed.failedReason).toContain("insert died mid-load");
    // The crash never reached LIVE and the prior release still serves.
    expect(db.liveRows().map((r) => r.version)).toEqual(["07072026"]);
  });

  it("records a stringified reason when the crash is not an Error instance", async () => {
    const db = new FakeRxnormDb();
    db.onFirstNdcCreateMany = () => {
      // Some drivers reject with plain values; the FAILED marking must
      // not choke on them.
      throw "fake db: raw string failure";
    };
    await expect(loadVariant(db, { variant: "ALFA", version: "07072026" })).rejects.toBe(
      "fake db: raw string failure"
    );
    expect(db.releases[0]!.status).toBe("FAILED");
    expect(db.releases[0]!.failedReason).toBe("fake db: raw string failure");
  });

  it("keeps the release STAGED and rethrows the original error when even the FAILED marking dies", async () => {
    const db = new FakeRxnormDb();
    db.onFirstNdcCreateMany = () => {
      // The staged row is release-1; make its FAILED update throw too.
      db.updateThrowsForId = "release-1";
      throw new Error("fake db: insert died mid-load");
    };
    // The ORIGINAL failure must surface, not the marking failure.
    await expect(loadVariant(db, { variant: "ALFA", version: "07072026" })).rejects.toThrow(
      "insert died mid-load"
    );
    expect(db.releases[0]!.status).toBe("STAGED");
    expect(db.liveRows()).toHaveLength(0);
  });
});

describe("ingestRxnormRelease — the STAGED→LIVE swap", () => {
  it("retires exactly the one previous LIVE: never zero, never two", async () => {
    const db = new FakeRxnormDb();
    const first = await loadVariant(db, { variant: "ALFA", version: "07072026" });
    const later = new Date("2026-09-01T09:00:00Z");
    const second = await loadVariant(db, { variant: "BRAVO", version: "08072026", now: later });

    expect(db.liveRows()).toHaveLength(1);
    expect(db.liveRows()[0]!.id).toBe(second.releaseId);

    const retired = db.releases.find((r) => r.id === first.releaseId)!;
    expect(retired.status).toBe("SUPERSEDED");
    expect(retired.supersededAt).toEqual(later);
    // Retired rows never mutate their data — both releases' rows
    // coexist, each complete under its own release id.
    expect(db.ndcRows.filter((r) => r.releaseId === first.releaseId)).toHaveLength(1);
    expect(db.ndcRows.filter((r) => r.releaseId === second.releaseId)).toHaveLength(1);
  });

  it("re-checks newness inside the swap: a release that went live mid-staging wins", async () => {
    const db = new FakeRxnormDb();
    await loadVariant(db, { variant: "ALFA", version: "07072026" });

    // While our 08072026 load is staging rows, a concurrent ingestion
    // completes for 10072026 — simulated by mutating the fake's state
    // from the createMany hook, exactly the leapfrog window the
    // in-transaction re-check exists for.
    db.onFirstNdcCreateMany = () => {
      const live = db.releases.find((r) => r.status === "LIVE")!;
      live.status = "SUPERSEDED";
      live.supersededAt = NOW;
      db.releases.push({
        id: "release-concurrent",
        version: "10072026",
        releasedOn: new Date(Date.UTC(2026, 9, 7)),
        checksumSha256: "cafe".repeat(16),
        status: "LIVE",
        ndcCount: 1,
        ingredientLinkCount: 1,
        loadedAt: NOW,
        supersededAt: null,
        failedReason: null,
      });
    };

    await expect(loadVariant(db, { variant: "BRAVO", version: "08072026" })).rejects.toMatchObject({
      code: RXNORM_INGEST_ERRORS.RELEASE_NOT_NEWER,
    });

    // The concurrent winner is untouched; our attempt is FAILED, not
    // LIVE — and there is still exactly one LIVE release.
    expect(db.liveRows().map((r) => r.id)).toEqual(["release-concurrent"]);
    const ours = db.releases.find((r) => r.version === "08072026")!;
    expect(ours.status).toBe("FAILED");
    expect(ours.failedReason).toContain("went live while this load was staging");
  });
});

describe("RxnormIngestError", () => {
  it("carries a stable code and a log-safe name", () => {
    const error = new RxnormIngestError(RXNORM_INGEST_ERRORS.RELEASE_EMPTY, "synthetic message");
    expect(error.name).toBe("RxnormIngestError");
    expect(error.code).toBe("RXNORM_RELEASE_EMPTY");
    expect(error).toBeInstanceOf(Error);
  });
});
