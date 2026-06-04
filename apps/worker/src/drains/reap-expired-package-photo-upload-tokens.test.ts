// Expired package-photo upload-token reaper tests.
//
// Asserts:
//   - The id-select targets `expiresAt <= now` and is capped at
//     batchSize.
//   - The delete targets exactly the selected ids.
//   - The reaper returns Prisma's deleteMany count.
//   - An empty batch skips the delete entirely and returns 0.
//   - A zero-row sweep does not log noisily.

import { clock, logger } from "@pharmax/platform-core";
import { describe, expect, it, vi } from "vitest";

import {
  createExpiredPackagePhotoUploadTokenReaper,
  type ReapExpiredPackagePhotoUploadTokensDeps,
} from "./reap-expired-package-photo-upload-tokens.js";

const FROZEN_NOW = new Date("2026-06-01T14:00:00.000Z");

interface FindManyCall {
  readonly where: Record<string, unknown>;
  readonly select: Record<string, unknown>;
  readonly take: number;
}
interface DeleteManyCall {
  readonly where: Record<string, unknown>;
}

function buildFake(input: {
  readonly expiredTokens: ReadonlyArray<string>;
  readonly deleteCount?: number;
}): {
  client: ReapExpiredPackagePhotoUploadTokensDeps["client"];
  findManyCalls: FindManyCall[];
  deleteManyCalls: DeleteManyCall[];
} {
  const findManyCalls: FindManyCall[] = [];
  const deleteManyCalls: DeleteManyCall[] = [];
  const client = {
    packagePhotoUploadToken: {
      findMany: vi.fn(async (args: FindManyCall) => {
        findManyCalls.push(args);
        return input.expiredTokens.map((token) => ({ token }));
      }),
      deleteMany: vi.fn(async (args: DeleteManyCall) => {
        deleteManyCalls.push(args);
        return { count: input.deleteCount ?? input.expiredTokens.length };
      }),
    },
  } as unknown as ReapExpiredPackagePhotoUploadTokensDeps["client"];
  return { client, findManyCalls, deleteManyCalls };
}

describe("createExpiredPackagePhotoUploadTokenReaper — happy path", () => {
  it("selects expired tokens (capped at batchSize) and deletes exactly those ids", async () => {
    const fake = buildFake({ expiredTokens: ["t-1", "t-2", "t-3"] });
    const reaper = createExpiredPackagePhotoUploadTokenReaper(
      {
        client: fake.client,
        logger: logger.noopLogger,
        clock: clock.createFrozenClock(FROZEN_NOW),
      },
      { batchSize: 500 }
    );

    const result = await reaper.tick();
    expect(result).toEqual({ sweptCount: 3 });

    expect(fake.findManyCalls).toHaveLength(1);
    const find = fake.findManyCalls[0]!;
    expect((find.where["expiresAt"] as { lte: Date }).lte).toEqual(FROZEN_NOW);
    expect(find.take).toBe(500);
    expect(find.select).toEqual({ token: true });

    expect(fake.deleteManyCalls).toHaveLength(1);
    expect(fake.deleteManyCalls[0]!.where).toEqual({ token: { in: ["t-1", "t-2", "t-3"] } });
  });

  it("returns the deleteMany count even when it differs from the selected id count", async () => {
    // A concurrent reaper may have deleted one of the rows between
    // our select and delete — Prisma reports the actual delete count.
    const fake = buildFake({ expiredTokens: ["t-1", "t-2"], deleteCount: 1 });
    const reaper = createExpiredPackagePhotoUploadTokenReaper(
      {
        client: fake.client,
        logger: logger.noopLogger,
        clock: clock.createFrozenClock(FROZEN_NOW),
      },
      { batchSize: 500 }
    );
    const result = await reaper.tick();
    expect(result).toEqual({ sweptCount: 1 });
  });
});

describe("createExpiredPackagePhotoUploadTokenReaper — no-op", () => {
  it("skips the delete and returns 0 when nothing is expired, without logging noisily", async () => {
    const fake = buildFake({ expiredTokens: [] });
    const warnSpy = vi.fn();
    const infoSpy = vi.fn();
    const childLogger: typeof logger.noopLogger = {
      ...logger.noopLogger,
      warn: warnSpy,
      info: infoSpy,
    };
    const rootLogger = {
      ...logger.noopLogger,
      child: () => childLogger,
    } satisfies typeof logger.noopLogger;

    const reaper = createExpiredPackagePhotoUploadTokenReaper(
      { client: fake.client, logger: rootLogger, clock: clock.createFrozenClock(FROZEN_NOW) },
      { batchSize: 500 }
    );

    const result = await reaper.tick();
    expect(result).toEqual({ sweptCount: 0 });
    expect(fake.deleteManyCalls).toHaveLength(0);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
  });
});

describe("createExpiredPackagePhotoUploadTokenReaper — batch cap", () => {
  it("threads batchSize into the id-select take", async () => {
    const fake = buildFake({ expiredTokens: ["t-1"] });
    const reaper = createExpiredPackagePhotoUploadTokenReaper(
      {
        client: fake.client,
        logger: logger.noopLogger,
        clock: clock.createFrozenClock(FROZEN_NOW),
      },
      { batchSize: 50 }
    );
    await reaper.tick();
    expect(fake.findManyCalls[0]!.take).toBe(50);
  });
});
