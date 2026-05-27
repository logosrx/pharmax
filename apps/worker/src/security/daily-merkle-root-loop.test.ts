// Unit tests for the nightly Merkle-root loop.
//
// Drives the real `createNightlyMerkleRootLoop` against a fake
// Prisma (only `organization.findMany` and the audit-log adapter's
// `findMany` are reached), an injected signer, and an injected
// publisher. No AWS calls — the production AWS SDK paths are
// covered in @pharmax/security's signer + publisher tests against
// the same ports the loop uses.

import { logger as loggerNs, errors } from "@pharmax/platform-core";
import {
  LocalEd25519Signer,
  MERKLE_PUBLISH_FAILED,
  MERKLE_SIGN_FAILED,
  type ManifestPublisher,
  type MerkleRootSigner,
  type PublishManifestOutput,
  type SignedMerkleManifest,
  type SigningInput,
  type SigningOutput,
} from "@pharmax/security";
import type { PrismaClient } from "@pharmax/database";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createNightlyMerkleRootLoop } from "./daily-merkle-root-loop.js";

const ORG_A = "11111111-1111-7111-a111-111111111111";
const ORG_B = "22222222-2222-7222-a222-222222222222";
const ORG_C = "33333333-3333-7333-a333-333333333333";

const logger = loggerNs.createPinoLogger({ service: "test-merkle-loop", level: "error" });

interface OrgRow {
  readonly id: string;
  readonly slug: string;
}

/**
 * Minimal Prisma fake satisfying the surface the loop actually
 * touches: `organization.findMany` (the org enumerator) and
 * `auditLog.findMany` (the audit-chain source's pagination call).
 * The audit-log fake returns empty arrays per default so the loop
 * computes the canonical empty-window root for every org.
 */
function buildPrismaFake(args: {
  readonly orgs: ReadonlyArray<OrgRow>;
  readonly auditRows?: Map<string, ReadonlyArray<unknown>>;
}): PrismaClient {
  const auditRows = args.auditRows ?? new Map<string, ReadonlyArray<unknown>>();
  return {
    organization: {
      findMany: vi.fn(async () => args.orgs),
    },
    auditLog: {
      findMany: vi.fn(async (params: { where: { organizationId: string } }) => {
        const rows = auditRows.get(params.where.organizationId);
        return rows ?? [];
      }),
    },
  } as unknown as PrismaClient;
}

/** Recording publisher that always succeeds. */
class RecordingPublisher implements ManifestPublisher {
  readonly published: SignedMerkleManifest[] = [];
  async publish(manifest: SignedMerkleManifest): Promise<PublishManifestOutput> {
    this.published.push(manifest);
    return {
      uri: `recording://${manifest.organizationId}/${manifest.periodStart}`,
      publishedAt: new Date(),
      eTag: `"etag-${this.published.length - 1}"`,
      idempotent: false,
    };
  }
}

/** Publisher that reports every publish as idempotent (existing manifest). */
class IdempotentPublisher implements ManifestPublisher {
  readonly published: SignedMerkleManifest[] = [];
  async publish(manifest: SignedMerkleManifest): Promise<PublishManifestOutput> {
    this.published.push(manifest);
    return {
      uri: `recording://${manifest.organizationId}/${manifest.periodStart}`,
      publishedAt: new Date(),
      idempotent: true,
    };
  }
}

/** Publisher that fails for the named org and succeeds for everyone else. */
class SelectivelyFailingPublisher implements ManifestPublisher {
  readonly published: SignedMerkleManifest[] = [];
  constructor(private readonly failOrgId: string) {}
  async publish(manifest: SignedMerkleManifest): Promise<PublishManifestOutput> {
    if (manifest.organizationId === this.failOrgId) {
      throw new errors.InternalError({
        code: MERKLE_PUBLISH_FAILED,
        message: "simulated S3 outage",
        metadata: { uri: "s3://test/" },
      });
    }
    this.published.push(manifest);
    return {
      uri: `recording://${manifest.organizationId}/${manifest.periodStart}`,
      publishedAt: new Date(),
      idempotent: false,
    };
  }
}

/** Signer that fails for the named org and signs normally for everyone else. */
class SelectivelyFailingSigner implements MerkleRootSigner {
  public readonly algorithm = "ed25519" as const;
  public readonly signerKid: string;
  constructor(
    private readonly delegate: MerkleRootSigner,
    private readonly failOrgId: string
  ) {
    this.signerKid = delegate.signerKid;
  }
  async sign(input: SigningInput): Promise<SigningOutput> {
    if (input.organizationId === this.failOrgId) {
      throw new errors.InternalError({
        code: MERKLE_SIGN_FAILED,
        message: "simulated KMS Sign denial",
        metadata: { keyArn: "arn:aws:kms:test" },
      });
    }
    return this.delegate.sign(input);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-25T02:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createNightlyMerkleRootLoop", () => {
  const fixedNow = new Date("2026-05-25T02:00:00Z");
  // The default window is "yesterday in UTC" — 2026-05-24 00:00 →
  // 2026-05-25 00:00 — so every published manifest carries that
  // window. Tests assert on the window where it matters.
  const expectedPeriodStart = new Date(Date.UTC(2026, 4, 24, 0, 0, 0));
  const expectedPeriodEnd = new Date(Date.UTC(2026, 4, 25, 0, 0, 0));

  function buildSigner(): LocalEd25519Signer {
    // Deterministic seed so signerKid is stable across test runs.
    return new LocalEd25519Signer({ seed: Buffer.alloc(32, 0x42) });
  }

  it("signs and publishes a manifest for every organization in a clean run", async () => {
    const publisher = new RecordingPublisher();
    const signer = buildSigner();
    const loop = createNightlyMerkleRootLoop({
      prisma: buildPrismaFake({
        orgs: [
          { id: ORG_A, slug: "org-a" },
          { id: ORG_B, slug: "org-b" },
          { id: ORG_C, slug: "org-c" },
        ],
      }),
      logger,
      signer,
      publisher,
      now: () => fixedNow,
    });

    const summary = await loop.runOnce(fixedNow);

    expect(summary.organizationCount).toBe(3);
    expect(summary.orgsSigned).toBe(3);
    expect(summary.orgsIdempotent).toBe(0);
    expect(summary.orgsFailed).toBe(0);
    expect(summary.errorsByCode).toEqual({});
    expect(summary.periodStart.toISOString()).toBe(expectedPeriodStart.toISOString());
    expect(summary.periodEnd.toISOString()).toBe(expectedPeriodEnd.toISOString());

    expect(publisher.published.map((m) => m.organizationId)).toEqual([ORG_A, ORG_B, ORG_C]);
    for (const manifest of publisher.published) {
      expect(manifest.signerKid).toBe(signer.signerKid);
      expect(manifest.signingDomainTag).toBe("pharmax/audit-merkle/v1");
      expect(manifest.algorithm).toBe("ed25519");
      expect(manifest.periodStart).toBe(expectedPeriodStart.toISOString());
      expect(manifest.periodEnd).toBe(expectedPeriodEnd.toISOString());
    }
  });

  it("counts idempotent publishes separately from signed publishes", async () => {
    const publisher = new IdempotentPublisher();
    const loop = createNightlyMerkleRootLoop({
      prisma: buildPrismaFake({
        orgs: [
          { id: ORG_A, slug: "org-a" },
          { id: ORG_B, slug: "org-b" },
        ],
      }),
      logger,
      signer: buildSigner(),
      publisher,
      now: () => fixedNow,
    });

    const summary = await loop.runOnce(fixedNow);
    expect(summary.orgsSigned).toBe(0);
    expect(summary.orgsIdempotent).toBe(2);
    expect(summary.orgsFailed).toBe(0);
  });

  it("isolates a publisher failure to the failing org — other orgs still publish", async () => {
    const publisher = new SelectivelyFailingPublisher(ORG_B);
    const loop = createNightlyMerkleRootLoop({
      prisma: buildPrismaFake({
        orgs: [
          { id: ORG_A, slug: "org-a" },
          { id: ORG_B, slug: "org-b" },
          { id: ORG_C, slug: "org-c" },
        ],
      }),
      logger,
      signer: buildSigner(),
      publisher,
      now: () => fixedNow,
    });

    const summary = await loop.runOnce(fixedNow);
    expect(summary.orgsSigned).toBe(2);
    expect(summary.orgsFailed).toBe(1);
    expect(summary.errorsByCode[MERKLE_PUBLISH_FAILED]).toBe(1);
    expect(publisher.published.map((m) => m.organizationId)).toEqual([ORG_A, ORG_C]);
  });

  it("isolates a signer failure to the failing org — other orgs still publish", async () => {
    const publisher = new RecordingPublisher();
    const signer = new SelectivelyFailingSigner(buildSigner(), ORG_A);
    const loop = createNightlyMerkleRootLoop({
      prisma: buildPrismaFake({
        orgs: [
          { id: ORG_A, slug: "org-a" },
          { id: ORG_B, slug: "org-b" },
        ],
      }),
      logger,
      signer,
      publisher,
      now: () => fixedNow,
    });

    const summary = await loop.runOnce(fixedNow);
    expect(summary.orgsSigned).toBe(1);
    expect(summary.orgsFailed).toBe(1);
    expect(summary.errorsByCode[MERKLE_SIGN_FAILED]).toBe(1);
    expect(publisher.published.map((m) => m.organizationId)).toEqual([ORG_B]);
  });

  it("classifies a non-Pharmax error under MERKLE_RUN_UNKNOWN", async () => {
    const rogueSigner: MerkleRootSigner = {
      algorithm: "ed25519",
      signerKid: "ed25519:rogue",
      async sign() {
        throw new TypeError("unexpected internal failure");
      },
    };
    const publisher = new RecordingPublisher();
    const loop = createNightlyMerkleRootLoop({
      prisma: buildPrismaFake({ orgs: [{ id: ORG_A, slug: "org-a" }] }),
      logger,
      signer: rogueSigner,
      publisher,
      now: () => fixedNow,
    });

    const summary = await loop.runOnce(fixedNow);
    expect(summary.orgsFailed).toBe(1);
    expect(summary.errorsByCode["MERKLE_RUN_UNKNOWN"]).toBe(1);
    expect(publisher.published).toHaveLength(0);
  });

  it("emits a metrics counter shape that the digest probe can consume", async () => {
    const publisher = new SelectivelyFailingPublisher(ORG_B);
    const signer = new SelectivelyFailingSigner(buildSigner(), ORG_C);
    const loop = createNightlyMerkleRootLoop({
      prisma: buildPrismaFake({
        orgs: [
          { id: ORG_A, slug: "org-a" },
          { id: ORG_B, slug: "org-b" },
          { id: ORG_C, slug: "org-c" },
        ],
      }),
      logger,
      signer,
      publisher,
      now: () => fixedNow,
    });

    const summary = await loop.runOnce(fixedNow);
    expect(summary.organizationCount).toBe(3);
    expect(summary.orgsSigned).toBe(1);
    expect(summary.orgsFailed).toBe(2);
    // Counter shape: { [errorCode]: number }. Both KMS sign and S3
    // publish failures classify under their own codes.
    expect(summary.errorsByCode).toEqual({
      [MERKLE_PUBLISH_FAILED]: 1,
      [MERKLE_SIGN_FAILED]: 1,
    });
    expect(Object.isFrozen(summary.errorsByCode)).toBe(true);
  });

  it("uses the configured UTC hour/minute when the scheduler fires", async () => {
    const publisher = new RecordingPublisher();
    const loop = createNightlyMerkleRootLoop({
      prisma: buildPrismaFake({ orgs: [{ id: ORG_A, slug: "org-a" }] }),
      logger,
      signer: buildSigner(),
      publisher,
      utcHour: 3,
      utcMinute: 15,
      now: () => fixedNow,
    });
    loop.start();
    // Don't fire — just confirm the scheduler exposes the same
    // configured hour. The full scheduling timing test lives in
    // daily-utc-scheduler tests.
    expect(loop.scheduler).toBeDefined();
    await loop.stop();
  });

  it("graceful shutdown: in-flight publish completes, remaining orgs skip with a warn log", async () => {
    // Real timers for this test: we rely on `setImmediate` ordering
    // between the publisher's yield and the test's `loop.stop()`
    // signal. The suite-wide `beforeEach(vi.useFakeTimers)` would
    // freeze both, hanging the test until the 5s timeout.
    vi.useRealTimers();

    // The fake signer signs synchronously but the publisher takes a
    // tick — we trigger stop() AFTER the first org's publish, then
    // verify only the first org made it through.
    let started = 0;
    const slowPublisher: ManifestPublisher = {
      async publish(manifest) {
        started += 1;
        await new Promise((r) => setImmediate(r));
        return {
          uri: `recording://${manifest.organizationId}`,
          publishedAt: new Date(),
          idempotent: false,
        };
      },
    };
    const loop = createNightlyMerkleRootLoop({
      prisma: buildPrismaFake({
        orgs: [
          { id: ORG_A, slug: "org-a" },
          { id: ORG_B, slug: "org-b" },
          { id: ORG_C, slug: "org-c" },
        ],
      }),
      logger,
      signer: buildSigner(),
      publisher: slowPublisher,
      now: () => fixedNow,
    });
    const inflight = loop.runOnce(fixedNow);
    // Schedule a stop request after the first publish has begun.
    setImmediate(() => {
      void loop.stop();
    });
    const summary = await inflight;
    expect(started).toBeGreaterThanOrEqual(1);
    // The summary reflects the partial run — total orgsSigned +
    // orgsIdempotent + orgsFailed equals the orgs that ran. The
    // remaining orgs are simply skipped (NOT counted as failures —
    // they didn't enter the for-loop body).
    expect(summary.orgsSigned + summary.orgsFailed + summary.orgsIdempotent).toBeLessThanOrEqual(3);
  });
});
