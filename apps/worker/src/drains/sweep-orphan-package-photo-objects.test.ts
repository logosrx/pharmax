// Orphan package-photo object sweeper tests.
//
// Asserts:
//   - Objects older than the safety window with no package_photo
//     reference are deleted.
//   - Recent objects (within the safety window) are never candidates
//     — even if unreferenced.
//   - Referenced objects (a package_photo.storageKey matches) are
//     never deleted, regardless of age.
//   - Non-`/photo/upload/` keys are ignored.
//   - The reference check is queried by exact candidate keys only.
//   - The pagination cursor advances across ticks and resets when
//     the listing is exhausted.
//   - An all-recent / empty page makes forward progress without a
//     reference query or delete, and logs nothing.

import { clock, logger } from "@pharmax/platform-core";
import { describe, expect, it, vi } from "vitest";

import {
  createOrphanPackagePhotoObjectSweeper,
  type PackagePhotoObjectPage,
  type SweepOrphanPackagePhotoObjectsDeps,
} from "./sweep-orphan-package-photo-objects.js";

const NOW = new Date("2026-06-01T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60_000;
const ORG = "00000000-0000-4000-8000-00000000000a";

function key(token: string, org: string = ORG): string {
  return `org/${org}/photo/upload/${token}`;
}

// `ageMs` ago relative to NOW.
function obj(k: string, ageMs: number): { key: string; lastModified: Date } {
  return { key: k, lastModified: new Date(NOW.getTime() - ageMs) };
}

interface FakeStore {
  store: SweepOrphanPackagePhotoObjectsDeps["store"];
  listCalls: Array<{ continuationToken: string | undefined; prefix: string; maxKeys: number }>;
  deletedBatches: string[][];
}

function buildStore(pages: PackagePhotoObjectPage[]): FakeStore {
  const listCalls: FakeStore["listCalls"] = [];
  const deletedBatches: string[][] = [];
  let pageIdx = 0;
  const store: SweepOrphanPackagePhotoObjectsDeps["store"] = {
    async listObjects(input) {
      listCalls.push({
        continuationToken: input.continuationToken,
        prefix: input.prefix,
        maxKeys: input.maxKeys,
      });
      const page = pages[Math.min(pageIdx, pages.length - 1)]!;
      pageIdx += 1;
      return page;
    },
    async deleteObjects(input) {
      deletedBatches.push([...input.keys]);
      return { deletedCount: input.keys.length };
    },
  };
  return { store, listCalls, deletedBatches };
}

// Fake prisma whose packagePhoto.findMany returns the configured
// referenced keys (intersected with the requested candidate set, to
// mirror a real IN query).
function buildPrisma(referencedKeys: ReadonlyArray<string>): {
  prisma: SweepOrphanPackagePhotoObjectsDeps["prisma"];
  findManyCalls: Array<ReadonlyArray<string>>;
} {
  const findManyCalls: Array<ReadonlyArray<string>> = [];
  const refSet = new Set(referencedKeys);
  const prisma = {
    packagePhoto: {
      findMany: vi.fn(async (args: { where: { storageKey: { in: string[] } } }) => {
        const requested = args.where.storageKey.in;
        findManyCalls.push(requested);
        return requested.filter((k) => refSet.has(k)).map((k) => ({ storageKey: k }));
      }),
    },
  } as unknown as SweepOrphanPackagePhotoObjectsDeps["prisma"];
  return { prisma, findManyCalls };
}

function build(
  pages: PackagePhotoObjectPage[],
  referencedKeys: ReadonlyArray<string>,
  opts?: { safetyWindowMs?: number; maxKeysPerTick?: number }
) {
  const fakeStore = buildStore(pages);
  const fakePrisma = buildPrisma(referencedKeys);
  const sweeper = createOrphanPackagePhotoObjectSweeper(
    {
      store: fakeStore.store,
      prisma: fakePrisma.prisma,
      logger: logger.noopLogger,
      clock: clock.createFrozenClock(NOW),
    },
    { safetyWindowMs: opts?.safetyWindowMs ?? DAY_MS, maxKeysPerTick: opts?.maxKeysPerTick ?? 1000 }
  );
  return { sweeper, fakeStore, fakePrisma };
}

describe("createOrphanPackagePhotoObjectSweeper — orphan deletion", () => {
  it("deletes old, unreferenced upload objects", async () => {
    const orphan = key("orphan-1");
    const { sweeper, fakeStore } = build(
      [{ objects: [obj(orphan, 2 * DAY_MS)], nextContinuationToken: undefined }],
      [] // nothing referenced
    );

    const result = await sweeper.tick();
    expect(result).toEqual({ scanned: 1, deletedCount: 1 });
    expect(fakeStore.deletedBatches).toEqual([[orphan]]);
  });

  it("never deletes an object younger than the safety window", async () => {
    const recent = key("recent-1");
    const { sweeper, fakeStore, fakePrisma } = build(
      [{ objects: [obj(recent, 60_000)], nextContinuationToken: undefined }], // 1 min old
      []
    );

    const result = await sweeper.tick();
    expect(result).toEqual({ scanned: 1, deletedCount: 0 });
    expect(fakeStore.deletedBatches).toHaveLength(0);
    // No candidates → no reference query at all.
    expect(fakePrisma.findManyCalls).toHaveLength(0);
  });

  it("never deletes an object backed by a package_photo, regardless of age", async () => {
    const captured = key("captured-1");
    const { sweeper, fakeStore } = build(
      [{ objects: [obj(captured, 10 * DAY_MS)], nextContinuationToken: undefined }],
      [captured] // referenced by a package_photo
    );

    const result = await sweeper.tick();
    expect(result).toEqual({ scanned: 1, deletedCount: 0 });
    expect(fakeStore.deletedBatches).toHaveLength(0);
  });

  it("ignores keys that are not under /photo/upload/", async () => {
    const notUpload = `org/${ORG}/photo/thumbnail/x`;
    const { sweeper, fakeStore, fakePrisma } = build(
      [{ objects: [obj(notUpload, 5 * DAY_MS)], nextContinuationToken: undefined }],
      []
    );

    const result = await sweeper.tick();
    expect(result).toEqual({ scanned: 1, deletedCount: 0 });
    expect(fakeStore.deletedBatches).toHaveLength(0);
    expect(fakePrisma.findManyCalls).toHaveLength(0);
  });

  it("separates orphans from captured + recent in a mixed page", async () => {
    const orphanA = key("orphan-a");
    const orphanB = key("orphan-b");
    const captured = key("captured");
    const recent = key("recent");
    const { sweeper, fakeStore, fakePrisma } = build(
      [
        {
          objects: [
            obj(orphanA, 3 * DAY_MS),
            obj(captured, 3 * DAY_MS),
            obj(recent, 30_000),
            obj(orphanB, 3 * DAY_MS),
          ],
          nextContinuationToken: undefined,
        },
      ],
      [captured]
    );

    const result = await sweeper.tick();
    expect(result).toEqual({ scanned: 4, deletedCount: 2 });
    // The reference check is queried with the aged candidates only
    // (recent excluded), not the whole page.
    expect(fakePrisma.findManyCalls[0]).toEqual([orphanA, captured, orphanB]);
    expect(fakeStore.deletedBatches).toEqual([[orphanA, orphanB]]);
  });
});

describe("createOrphanPackagePhotoObjectSweeper — pagination", () => {
  it("advances the continuation cursor across ticks and resets when exhausted", async () => {
    const o1 = key("page1-orphan");
    const o2 = key("page2-orphan");
    const { sweeper, fakeStore } = build(
      [
        { objects: [obj(o1, 2 * DAY_MS)], nextContinuationToken: "cursor-2" },
        { objects: [obj(o2, 2 * DAY_MS)], nextContinuationToken: undefined },
        { objects: [obj(o1, 2 * DAY_MS)], nextContinuationToken: "cursor-2" },
      ],
      []
    );

    await sweeper.tick(); // page 1 — starts with no cursor
    await sweeper.tick(); // page 2 — should pass cursor-2
    await sweeper.tick(); // exhausted last tick → restart from top (no cursor)

    expect(fakeStore.listCalls[0]!.continuationToken).toBeUndefined();
    expect(fakeStore.listCalls[1]!.continuationToken).toBe("cursor-2");
    expect(fakeStore.listCalls[2]!.continuationToken).toBeUndefined();
    expect(fakeStore.listCalls[0]!.prefix).toBe("org/");
  });
});

describe("createOrphanPackagePhotoObjectSweeper — no-op", () => {
  it("makes forward progress on an empty page without querying or logging", async () => {
    const warnSpy = vi.fn();
    const childLogger: typeof logger.noopLogger = { ...logger.noopLogger, warn: warnSpy };
    const rootLogger = {
      ...logger.noopLogger,
      child: () => childLogger,
    } satisfies typeof logger.noopLogger;

    const fakeStore = buildStore([{ objects: [], nextContinuationToken: undefined }]);
    const fakePrisma = buildPrisma([]);
    const sweeper = createOrphanPackagePhotoObjectSweeper(
      {
        store: fakeStore.store,
        prisma: fakePrisma.prisma,
        logger: rootLogger,
        clock: clock.createFrozenClock(NOW),
      },
      { safetyWindowMs: DAY_MS, maxKeysPerTick: 1000 }
    );

    const result = await sweeper.tick();
    expect(result).toEqual({ scanned: 0, deletedCount: 0 });
    expect(fakePrisma.findManyCalls).toHaveLength(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
