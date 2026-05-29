// Tests for the NPI Registry per-org sync orchestrator.
//
// Unit tests against the worker's narrow DI surface: a mocked
// Prisma adapter (just the four model surfaces the worker
// touches), a mocked `CmsNppesClient.fetchManyByNpi`, and two
// mocked command dispatchers. No DB, no HTTP, no tenancy ALS —
// the orchestrator's contract is purely "given these inputs,
// produce these writes + return this result".
//
// What we cover:
//   - Each SyncAction discriminant the diff engine can emit
//     produces the correct check row + dispatch + counter increment.
//   - Race-rejected dispatches downgrade to NONE checks and DON'T
//     increment the action's success counter.
//   - FETCH_FAILED rows capture the structured PharmaxError.
//   - Review-item P2002 (already-OPEN dedup) is swallowed.
//   - Multi-batch fan-out respects the `cmsFetchBatchSize` knob.
//   - Empty org short-circuits to COMPLETED with all zeros.
//   - A thrown error mid-run flips the run row to FAILED and
//     re-throws the original exception.
//   - The `classifyDispatchError` helper recognizes every race
//     code the worker downgrades.

import { ProviderStatus } from "@pharmax/database";
import { errors, clock as clockNs, logger as loggerNs } from "@pharmax/platform-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CmsAddress, CmsNpiSnapshot, LocalProviderSnapshot } from "./diff-engine.js";
import type { CmsFetchResult, CmsNppesClient } from "./cms-client.js";
import {
  classifyDispatchError,
  runNpiSyncForOrg,
  type DispatchDeactivateProvider,
  type DispatchUpdateProvider,
  type ProviderRowProjection,
  type ProviderSyncPrismaSurface,
  type RunNpiSyncForOrgDeps,
  type RunNpiSyncForOrgInput,
} from "./run-sync.js";

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const RUN_ID = "00000000-0000-4000-8000-00000000aaaa";
const TRIGGERED_BY_USER_ID = "00000000-0000-4000-8000-000000000009";
const FIXED_NOW = new Date("2026-06-01T12:00:00.000Z");
const CMS_TS = new Date("2026-05-15T08:00:00.000Z");

function makeLocal(overrides: Partial<LocalProviderSnapshot> = {}): ProviderRowProjection {
  return {
    id: "00000000-0000-4000-8000-000000000010",
    organizationId: ORG_ID,
    npi: "1234567890",
    status: ProviderStatus.ACTIVE,
    firstName: "Jordan",
    lastName: "Rivera",
    credential: "MD",
    addressLine1: "1200 Maple St",
    addressLine2: "Suite 4",
    city: "Springfield",
    state: "IL",
    postalCode: "62701",
    phone: "217-555-0142",
    ...overrides,
  };
}

function makeCmsAddress(overrides: Partial<CmsAddress> = {}): CmsAddress {
  return {
    line1: "1200 Maple St",
    line2: "Suite 4",
    city: "Springfield",
    stateCode: "IL",
    postalCode: "62701",
    phone: "217-555-0142",
    ...overrides,
  };
}

function makeCms(overrides: Partial<CmsNpiSnapshot> = {}): CmsNpiSnapshot {
  return {
    npi: "1234567890",
    enumerationType: "NPI-1",
    status: "A",
    firstName: "Jordan",
    lastName: "Rivera",
    credential: "MD",
    practiceAddress: makeCmsAddress(),
    lastUpdatedAtCms: CMS_TS,
    ...overrides,
  };
}

function okFetch(snap: CmsNpiSnapshot | null): CmsFetchResult {
  return { ok: true, snapshot: snap };
}

function failFetch(code: string, message: string): CmsFetchResult {
  // Construct a real PharmaxError so the worker's metadata
  // serialization paths exercise the same shape they will in
  // production. InternalError carries no domain meaning here; the
  // CODE is the discriminant the worker writes to errorCode.
  return {
    ok: false,
    error: new errors.InternalError({ code, message, metadata: { ctx: "test-fixture" } }),
  };
}

// ---------------------------------------------------------------------
// Mock Prisma surface
// ---------------------------------------------------------------------

interface CapturedWrites {
  readonly runCreates: Array<{ data: Record<string, unknown> }>;
  readonly runUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }>;
  readonly checks: Array<{ data: Record<string, unknown> }>;
  readonly reviewItems: Array<{ data: Record<string, unknown> }>;
}

/** Convenience accessor that asserts the array has at least N+1 entries
 *  and returns the data field. Avoids `!` noise at every call site under
 *  `noUncheckedIndexedAccess`. */
function dataAt(
  arr: ReadonlyArray<{ data: Record<string, unknown> }>,
  idx: number
): Record<string, unknown> {
  const entry = arr[idx];
  if (entry === undefined) {
    throw new Error(`expected captured entry at index ${idx} but got undefined`);
  }
  return entry.data;
}

interface MockPrismaOptions {
  readonly providers: ReadonlyArray<ProviderRowProjection>;
  /** Optional: throw on the Nth check create call (0-indexed). */
  readonly throwOnCheckCreateIndex?: number;
  /** Optional: throw a P2002 on the Nth review-item create call. */
  readonly throwP2002OnReviewItemIndex?: number;
  /** Pre-allocated id sequence for createMany convenience. */
  readonly runIdSeed?: string;
  readonly checkIdSeed?: string;
}

function makeMockPrisma(opts: MockPrismaOptions): {
  prisma: ProviderSyncPrismaSurface;
  captured: CapturedWrites;
} {
  const captured: CapturedWrites = {
    runCreates: [],
    runUpdates: [],
    checks: [],
    reviewItems: [],
  };
  let checkCounter = 0;
  let reviewItemCounter = 0;
  const runIdSeed = opts.runIdSeed ?? RUN_ID;
  const checkIdSeed = opts.checkIdSeed ?? "00000000-0000-4000-8000-0000ccccc000";

  const prisma: ProviderSyncPrismaSurface = {
    provider: {
      findMany: async (args) => {
        let rows = [...opts.providers];
        if (typeof args.take === "number") {
          rows = rows.slice(0, args.take);
        }
        return rows;
      },
    },
    providerSyncRun: {
      create: async (args) => {
        captured.runCreates.push(args as unknown as { data: Record<string, unknown> });
        return { id: runIdSeed };
      },
      update: async (args) => {
        captured.runUpdates.push(
          args as unknown as { where: { id: string }; data: Record<string, unknown> }
        );
      },
    },
    providerSyncCheck: {
      create: async (args) => {
        const idx = checkCounter++;
        if (opts.throwOnCheckCreateIndex === idx) {
          throw new Error("simulated check-create failure");
        }
        captured.checks.push(args as unknown as { data: Record<string, unknown> });
        return { id: `${checkIdSeed}-${idx}` };
      },
    },
    providerSyncReviewItem: {
      create: async (args) => {
        const idx = reviewItemCounter++;
        if (opts.throwP2002OnReviewItemIndex === idx) {
          const err = new Error("Unique constraint failed");
          (err as { code?: string }).code = "P2002";
          throw err;
        }
        captured.reviewItems.push(args as unknown as { data: Record<string, unknown> });
        return {};
      },
    },
  };

  return { prisma, captured };
}

// ---------------------------------------------------------------------
// Mock CMS client
// ---------------------------------------------------------------------

function makeMockCmsClient(responses: ReadonlyMap<string, CmsFetchResult>): Pick<
  CmsNppesClient,
  "fetchManyByNpi"
> & {
  callCount: () => number;
  calls: () => ReadonlyArray<ReadonlyArray<string>>;
} {
  const calls: string[][] = [];
  return {
    fetchManyByNpi: async (npis) => {
      calls.push([...npis]);
      const out = new Map<string, CmsFetchResult>();
      for (const n of npis) {
        const r = responses.get(n);
        if (r !== undefined) out.set(n, r);
        // If the test omitted an NPI from `responses`, the worker
        // will throw NPI_SYNC_CLIENT_CONTRACT_VIOLATION — that's
        // exercised by a dedicated test below.
      }
      return out;
    },
    callCount: () => calls.length,
    calls: () => calls,
  };
}

// ---------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------

function makeDeps(args: {
  prisma: ProviderSyncPrismaSurface;
  cmsClient: Pick<CmsNppesClient, "fetchManyByNpi">;
  dispatchUpdate?: DispatchUpdateProvider;
  dispatchDeactivate?: DispatchDeactivateProvider;
}): RunNpiSyncForOrgDeps {
  return {
    prisma: args.prisma,
    cmsClient: args.cmsClient,
    clock: clockNs.createFrozenClock(FIXED_NOW),
    logger: loggerNs.noopLogger,
    dispatchUpdateProvider:
      args.dispatchUpdate ??
      (vi.fn(async () => ({
        ok: true,
        commandLogId: "cmd-update-1",
      })) as unknown as DispatchUpdateProvider),
    dispatchDeactivateProvider:
      args.dispatchDeactivate ??
      (vi.fn(async () => ({
        ok: true,
        commandLogId: "cmd-deact-1",
      })) as unknown as DispatchDeactivateProvider),
  };
}

function baseInput(overrides: Partial<RunNpiSyncForOrgInput> = {}): RunNpiSyncForOrgInput {
  return {
    organizationId: ORG_ID,
    triggeredBy: "CRON",
    triggeredByUserId: TRIGGERED_BY_USER_ID,
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

describe("runNpiSyncForOrg — happy paths", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("empty org: short-circuits to COMPLETED with zero counters", async () => {
    const { prisma, captured } = makeMockPrisma({ providers: [] });
    const cmsClient = makeMockCmsClient(new Map());
    const deps = makeDeps({ prisma, cmsClient });

    const result = await runNpiSyncForOrg(deps, baseInput());

    expect(result.status).toBe("COMPLETED");
    expect(result.summary.providersScanned).toBe(0);
    expect(captured.runCreates).toHaveLength(1);
    expect(dataAt(captured.runCreates, 0).status).toBe("IN_PROGRESS");
    expect(captured.runUpdates).toHaveLength(1);
    expect(dataAt(captured.runUpdates, 0).status).toBe("COMPLETED");
    expect(captured.checks).toHaveLength(0);
    expect(captured.reviewItems).toHaveLength(0);
    // CMS client SHOULD NOT be called when there are no providers.
    expect(cmsClient.callCount()).toBe(0);
  });

  it("NONE action (both ACTIVE, no field drift): writes one check, no dispatch", async () => {
    const local = makeLocal();
    const cms = makeCms(); // identical fields
    const { prisma, captured } = makeMockPrisma({ providers: [local] });
    const cmsClient = makeMockCmsClient(new Map([[local.npi, okFetch(cms)]]));
    const dispatchUpdate = vi.fn() as unknown as DispatchUpdateProvider;
    const dispatchDeactivate = vi.fn() as unknown as DispatchDeactivateProvider;
    const deps = makeDeps({ prisma, cmsClient, dispatchUpdate, dispatchDeactivate });

    const result = await runNpiSyncForOrg(deps, baseInput());

    expect(result.status).toBe("COMPLETED");
    expect(result.summary.noChangeCount).toBe(1);
    expect(result.summary.providersUpdated).toBe(0);
    expect(captured.checks).toHaveLength(1);
    const noneCheck = dataAt(captured.checks, 0);
    expect(noneCheck.action).toBe("NONE");
    expect(noneCheck.actionDetail).toBe("no_diff");
    expect(noneCheck.dispatchedCommandLogId).toBeNull();
    expect(noneCheck.cmsStatus).toBe("A");
    expect(dispatchUpdate).not.toHaveBeenCalled();
    expect(dispatchDeactivate).not.toHaveBeenCalled();
  });

  it("UPDATE action: dispatches UpdateProvider with diffed fields + writes check with commandLogId", async () => {
    const local = makeLocal({ firstName: "Stale", lastName: "Name" });
    const cms = makeCms({ firstName: "Jordan", lastName: "Rivera" });
    const { prisma, captured } = makeMockPrisma({ providers: [local] });
    const cmsClient = makeMockCmsClient(new Map([[local.npi, okFetch(cms)]]));
    const dispatchUpdate = vi
      .fn<DispatchUpdateProvider>()
      .mockResolvedValue({ ok: true, commandLogId: "cmd-log-uuid-1" });
    const deps = makeDeps({
      prisma,
      cmsClient,
      dispatchUpdate: dispatchUpdate as unknown as DispatchUpdateProvider,
    });

    const result = await runNpiSyncForOrg(deps, baseInput());

    expect(result.status).toBe("COMPLETED");
    expect(result.summary.providersUpdated).toBe(1);
    expect(dispatchUpdate).toHaveBeenCalledTimes(1);
    const updateCall = dispatchUpdate.mock.calls[0];
    if (updateCall === undefined) throw new Error("expected at least one dispatchUpdate call");
    const [callInput, callOpts] = updateCall;
    expect(callInput.providerId).toBe(local.id);
    expect(callInput.firstName).toBe("Jordan");
    expect(callInput.lastName).toBe("Rivera");
    expect(callOpts.idempotencyKey).toBe(`npi-sync:${RUN_ID}:${local.id}:UPDATE`);
    const updateCheck = dataAt(captured.checks, 0);
    expect(updateCheck.action).toBe("UPDATE");
    expect(updateCheck.dispatchedCommandLogId).toBe("cmd-log-uuid-1");
    expect(updateCheck.actionDetail).toBe("firstName,lastName");
  });

  it("DEACTIVATE action: dispatches DeactivateProvider with LICENSE_EXPIRED + reasonText", async () => {
    const local = makeLocal({ status: ProviderStatus.ACTIVE });
    const cms = makeCms({ status: "D" });
    const { prisma, captured } = makeMockPrisma({ providers: [local] });
    const cmsClient = makeMockCmsClient(new Map([[local.npi, okFetch(cms)]]));
    const dispatchDeactivate = vi
      .fn<DispatchDeactivateProvider>()
      .mockResolvedValue({ ok: true, commandLogId: "cmd-deact-uuid" });
    const deps = makeDeps({
      prisma,
      cmsClient,
      dispatchDeactivate: dispatchDeactivate as unknown as DispatchDeactivateProvider,
    });

    const result = await runNpiSyncForOrg(deps, baseInput());

    expect(result.status).toBe("COMPLETED");
    expect(result.summary.providersDeactivated).toBe(1);
    expect(dispatchDeactivate).toHaveBeenCalledTimes(1);
    const deactCall = dispatchDeactivate.mock.calls[0];
    if (deactCall === undefined) throw new Error("expected at least one dispatchDeactivate call");
    const [callInput, callOpts] = deactCall;
    expect(callInput.providerId).toBe(local.id);
    expect(callInput.reason).toBe("LICENSE_EXPIRED");
    expect(callInput.reasonText).toContain("NPPES status: D");
    expect(callOpts.idempotencyKey).toBe(`npi-sync:${RUN_ID}:${local.id}:DEACTIVATE`);
    const deactCheck = dataAt(captured.checks, 0);
    expect(deactCheck.action).toBe("DEACTIVATE");
    expect(deactCheck.dispatchedCommandLogId).toBe("cmd-deact-uuid");
  });

  it("REACTIVATION_CANDIDATE: writes check + review_item; no dispatch", async () => {
    const local = makeLocal({ status: ProviderStatus.INACTIVE });
    const cms = makeCms({ status: "A" });
    const { prisma, captured } = makeMockPrisma({ providers: [local] });
    const cmsClient = makeMockCmsClient(new Map([[local.npi, okFetch(cms)]]));
    const dispatchUpdate = vi.fn() as unknown as DispatchUpdateProvider;
    const dispatchDeactivate = vi.fn() as unknown as DispatchDeactivateProvider;
    const deps = makeDeps({ prisma, cmsClient, dispatchUpdate, dispatchDeactivate });

    const result = await runNpiSyncForOrg(deps, baseInput());

    expect(result.status).toBe("COMPLETED");
    expect(result.summary.reactivationCandidatesCreated).toBe(1);
    expect(captured.checks).toHaveLength(1);
    expect(dataAt(captured.checks, 0).action).toBe("REACTIVATION_CANDIDATE");
    expect(captured.reviewItems).toHaveLength(1);
    const reviewItem = dataAt(captured.reviewItems, 0);
    expect(reviewItem.kind).toBe("REACTIVATION_CANDIDATE");
    expect(reviewItem.cmsSnapshot).not.toBeNull();
    expect(reviewItem.localSnapshot).toMatchObject({ id: local.id });
    expect(dispatchUpdate).not.toHaveBeenCalled();
    expect(dispatchDeactivate).not.toHaveBeenCalled();
  });

  it("NOT_FOUND_AT_CMS: writes check + review_item with cmsSnapshot=null", async () => {
    const local = makeLocal();
    const { prisma, captured } = makeMockPrisma({ providers: [local] });
    const cmsClient = makeMockCmsClient(new Map([[local.npi, okFetch(null)]]));
    const deps = makeDeps({ prisma, cmsClient });

    const result = await runNpiSyncForOrg(deps, baseInput());

    expect(result.status).toBe("COMPLETED");
    expect(result.summary.notFoundAtCmsCount).toBe(1);
    expect(dataAt(captured.checks, 0).action).toBe("NOT_FOUND_AT_CMS");
    const notFoundReview = dataAt(captured.reviewItems, 0);
    expect(notFoundReview.kind).toBe("NOT_FOUND_AT_CMS");
    expect(notFoundReview.cmsSnapshot).toBeNull();
  });

  it("ENUMERATION_TYPE_MISMATCH: writes check with cmsType detail + review_item", async () => {
    const local = makeLocal();
    const cms = makeCms({ enumerationType: "NPI-2", firstName: null, lastName: null });
    const { prisma, captured } = makeMockPrisma({ providers: [local] });
    const cmsClient = makeMockCmsClient(new Map([[local.npi, okFetch(cms)]]));
    const deps = makeDeps({ prisma, cmsClient });

    const result = await runNpiSyncForOrg(deps, baseInput());

    expect(result.status).toBe("COMPLETED");
    expect(result.summary.enumerationTypeMismatchCount).toBe(1);
    const enumCheck = dataAt(captured.checks, 0);
    expect(enumCheck.action).toBe("ENUMERATION_TYPE_MISMATCH");
    expect(enumCheck.actionDetail).toBe("local=NPI-1,cms=NPI-2");
    expect(dataAt(captured.reviewItems, 0).kind).toBe("ENUMERATION_TYPE_MISMATCH");
  });
});

describe("runNpiSyncForOrg — fetch failures", () => {
  it("FETCH_FAILED: writes a single FETCH_FAILED check + flips run to PARTIAL", async () => {
    const local = makeLocal();
    const { prisma, captured } = makeMockPrisma({ providers: [local] });
    const cmsClient = makeMockCmsClient(
      new Map([[local.npi, failFetch("CMS_NPI_REGISTRY_SERVER_ERROR", "503 Service Unavailable")]])
    );
    const dispatchUpdate = vi.fn() as unknown as DispatchUpdateProvider;
    const deps = makeDeps({ prisma, cmsClient, dispatchUpdate });

    const result = await runNpiSyncForOrg(deps, baseInput());

    expect(result.status).toBe("PARTIAL");
    expect(result.summary.fetchFailedCount).toBe(1);
    const failCheck = dataAt(captured.checks, 0);
    expect(failCheck.action).toBe("FETCH_FAILED");
    expect(failCheck.errorCode).toBe("CMS_NPI_REGISTRY_SERVER_ERROR");
    expect(failCheck.errorMetadata).toMatchObject({
      message: "503 Service Unavailable",
    });
    expect(dispatchUpdate).not.toHaveBeenCalled();
    expect(dataAt(captured.runUpdates, 0).status).toBe("PARTIAL");
  });

  it("mixed batch: some FETCH_FAILED + some NONE → PARTIAL with correct counters", async () => {
    const a = makeLocal({ id: "a", npi: "1111111111" });
    const b = makeLocal({ id: "b", npi: "2222222222" });
    const c = makeLocal({ id: "c", npi: "3333333333" });
    const { prisma, captured } = makeMockPrisma({ providers: [a, b, c] });
    const cmsClient = makeMockCmsClient(
      new Map([
        [a.npi, okFetch(makeCms({ npi: a.npi }))],
        [b.npi, failFetch("CMS_NPI_REGISTRY_NETWORK_ERROR", "ECONNRESET")],
        [c.npi, okFetch(makeCms({ npi: c.npi }))],
      ])
    );
    const deps = makeDeps({ prisma, cmsClient });

    const result = await runNpiSyncForOrg(deps, baseInput());

    expect(result.status).toBe("PARTIAL");
    expect(result.summary.providersScanned).toBe(3);
    expect(result.summary.providersFetchedFromCms).toBe(3);
    expect(result.summary.noChangeCount).toBe(2);
    expect(result.summary.fetchFailedCount).toBe(1);
    expect(captured.checks).toHaveLength(3);
  });
});

describe("runNpiSyncForOrg — race handling", () => {
  it("UPDATE → PROVIDER_UPDATE_RACE_LOST: writes NONE check with race detail, no commandLogId", async () => {
    const local = makeLocal({ firstName: "Stale" });
    const cms = makeCms({ firstName: "Jordan" });
    const { prisma, captured } = makeMockPrisma({ providers: [local] });
    const cmsClient = makeMockCmsClient(new Map([[local.npi, okFetch(cms)]]));
    const dispatchUpdate = vi
      .fn<DispatchUpdateProvider>()
      .mockResolvedValue({ ok: false, raceCode: "PROVIDER_UPDATE_RACE_LOST" });
    const deps = makeDeps({
      prisma,
      cmsClient,
      dispatchUpdate: dispatchUpdate as unknown as DispatchUpdateProvider,
    });

    const result = await runNpiSyncForOrg(deps, baseInput());

    expect(result.status).toBe("COMPLETED");
    expect(result.summary.providersUpdated).toBe(0);
    expect(result.summary.noChangeCount).toBe(1);
    const raceCheck = dataAt(captured.checks, 0);
    expect(raceCheck.action).toBe("NONE");
    expect(raceCheck.actionDetail).toBe("race:PROVIDER_UPDATE_RACE_LOST");
    expect(raceCheck.dispatchedCommandLogId).toBeNull();
  });

  it("UPDATE → PROVIDER_INACTIVE: downgraded to NONE", async () => {
    const local = makeLocal();
    const cms = makeCms({ firstName: "Different" });
    const { prisma, captured } = makeMockPrisma({ providers: [local] });
    const cmsClient = makeMockCmsClient(new Map([[local.npi, okFetch(cms)]]));
    const dispatchUpdate = vi
      .fn<DispatchUpdateProvider>()
      .mockResolvedValue({ ok: false, raceCode: "PROVIDER_INACTIVE" });
    const deps = makeDeps({
      prisma,
      cmsClient,
      dispatchUpdate: dispatchUpdate as unknown as DispatchUpdateProvider,
    });

    const result = await runNpiSyncForOrg(deps, baseInput());

    expect(result.summary.noChangeCount).toBe(1);
    expect(dataAt(captured.checks, 0).actionDetail).toBe("race:PROVIDER_INACTIVE");
  });

  it("DEACTIVATE → PROVIDER_ALREADY_INACTIVE: downgraded to NONE", async () => {
    const local = makeLocal();
    const cms = makeCms({ status: "D" });
    const { prisma, captured } = makeMockPrisma({ providers: [local] });
    const cmsClient = makeMockCmsClient(new Map([[local.npi, okFetch(cms)]]));
    const dispatchDeactivate = vi
      .fn<DispatchDeactivateProvider>()
      .mockResolvedValue({ ok: false, raceCode: "PROVIDER_ALREADY_INACTIVE" });
    const deps = makeDeps({
      prisma,
      cmsClient,
      dispatchDeactivate: dispatchDeactivate as unknown as DispatchDeactivateProvider,
    });

    const result = await runNpiSyncForOrg(deps, baseInput());

    expect(result.summary.providersDeactivated).toBe(0);
    expect(result.summary.noChangeCount).toBe(1);
    const deactRace = dataAt(captured.checks, 0);
    expect(deactRace.action).toBe("NONE");
    expect(deactRace.actionDetail).toBe("race:PROVIDER_ALREADY_INACTIVE");
  });
});

describe("runNpiSyncForOrg — review item dedup", () => {
  it("P2002 on review_item insert: swallowed, check row still written", async () => {
    const local = makeLocal({ status: ProviderStatus.INACTIVE });
    const cms = makeCms({ status: "A" });
    const { prisma, captured } = makeMockPrisma({
      providers: [local],
      throwP2002OnReviewItemIndex: 0,
    });
    const cmsClient = makeMockCmsClient(new Map([[local.npi, okFetch(cms)]]));
    const deps = makeDeps({ prisma, cmsClient });

    const result = await runNpiSyncForOrg(deps, baseInput());

    expect(result.status).toBe("COMPLETED");
    // We still count the candidate (the run observed it) even
    // though the review_item insert was a no-op dedup.
    expect(result.summary.reactivationCandidatesCreated).toBe(1);
    expect(captured.checks).toHaveLength(1);
    expect(captured.reviewItems).toHaveLength(0);
  });

  it("non-P2002 error on review_item insert: propagates + run FAILED", async () => {
    const local = makeLocal({ status: ProviderStatus.INACTIVE });
    const cms = makeCms({ status: "A" });
    const captured: CapturedWrites = {
      runCreates: [],
      runUpdates: [],
      checks: [],
      reviewItems: [],
    };
    const prisma: ProviderSyncPrismaSurface = {
      provider: { findMany: async () => [local] },
      providerSyncRun: {
        create: async (args) => {
          captured.runCreates.push(args as unknown as { data: Record<string, unknown> });
          return { id: RUN_ID };
        },
        update: async (args) => {
          captured.runUpdates.push(
            args as unknown as { where: { id: string }; data: Record<string, unknown> }
          );
        },
      },
      providerSyncCheck: {
        create: async (args) => {
          captured.checks.push(args as unknown as { data: Record<string, unknown> });
          return { id: "check-id" };
        },
      },
      providerSyncReviewItem: {
        create: async () => {
          throw new Error("disk full");
        },
      },
    };
    const cmsClient = makeMockCmsClient(new Map([[local.npi, okFetch(cms)]]));
    const deps = makeDeps({ prisma, cmsClient });

    await expect(runNpiSyncForOrg(deps, baseInput())).rejects.toThrow("disk full");
    expect(captured.runUpdates).toHaveLength(1);
    const failedRun = dataAt(captured.runUpdates, 0);
    expect(failedRun.status).toBe("FAILED");
    expect(failedRun.errorMessage).toBe("disk full");
  });
});

describe("runNpiSyncForOrg — batching", () => {
  it("respects cmsFetchBatchSize: 3 providers @ batch=2 → 2 fetch calls", async () => {
    const a = makeLocal({ id: "a", npi: "1111111111" });
    const b = makeLocal({ id: "b", npi: "2222222222" });
    const c = makeLocal({ id: "c", npi: "3333333333" });
    const { prisma } = makeMockPrisma({ providers: [a, b, c] });
    const cmsClient = makeMockCmsClient(
      new Map([
        [a.npi, okFetch(makeCms({ npi: a.npi }))],
        [b.npi, okFetch(makeCms({ npi: b.npi }))],
        [c.npi, okFetch(makeCms({ npi: c.npi }))],
      ])
    );
    const deps = makeDeps({ prisma, cmsClient });

    await runNpiSyncForOrg(deps, baseInput({ cmsFetchBatchSize: 2 }));

    expect(cmsClient.callCount()).toBe(2);
    const calls = cmsClient.calls();
    expect(calls[0]).toEqual([a.npi, b.npi]);
    expect(calls[1]).toEqual([c.npi]);
  });

  it("maxProviders caps the listing", async () => {
    const providers = Array.from({ length: 10 }, (_, i) =>
      makeLocal({ id: `id-${i}`, npi: String(1_000_000_000 + i) })
    );
    const { prisma } = makeMockPrisma({ providers });
    const responses = new Map<string, CmsFetchResult>();
    for (const p of providers) responses.set(p.npi, okFetch(makeCms({ npi: p.npi })));
    const cmsClient = makeMockCmsClient(responses);
    const deps = makeDeps({ prisma, cmsClient });

    const result = await runNpiSyncForOrg(deps, baseInput({ maxProviders: 3 }));
    expect(result.summary.providersScanned).toBe(3);
    expect(result.summary.providersFetchedFromCms).toBe(3);
  });
});

describe("runNpiSyncForOrg — client contract", () => {
  it("missing NPI in fetchManyByNpi response throws and flips run to FAILED", async () => {
    const local = makeLocal();
    const { prisma, captured } = makeMockPrisma({ providers: [local] });
    // Return an EMPTY map even though we asked for one NPI — the
    // worker should treat this as a client contract violation.
    const cmsClient: Pick<CmsNppesClient, "fetchManyByNpi"> = {
      fetchManyByNpi: async () => new Map(),
    };
    const deps = makeDeps({ prisma, cmsClient });

    await expect(runNpiSyncForOrg(deps, baseInput())).rejects.toMatchObject({
      code: "NPI_SYNC_CLIENT_CONTRACT_VIOLATION",
    });
    const contractFail = dataAt(captured.runUpdates, 0);
    expect(contractFail.status).toBe("FAILED");
    expect(contractFail.errorMetadata).toMatchObject({
      errorCode: "NPI_SYNC_CLIENT_CONTRACT_VIOLATION",
    });
  });
});

describe("runNpiSyncForOrg — failure during run", () => {
  it("DB error mid-fanout: marks run FAILED and re-throws", async () => {
    const local = makeLocal({ firstName: "Stale" });
    const cms = makeCms({ firstName: "New" });
    const { prisma, captured } = makeMockPrisma({
      providers: [local],
      throwOnCheckCreateIndex: 0,
    });
    const cmsClient = makeMockCmsClient(new Map([[local.npi, okFetch(cms)]]));
    const dispatchUpdate = vi
      .fn<DispatchUpdateProvider>()
      .mockResolvedValue({ ok: true, commandLogId: "cmd-ok" });
    const deps = makeDeps({
      prisma,
      cmsClient,
      dispatchUpdate: dispatchUpdate as unknown as DispatchUpdateProvider,
    });

    await expect(runNpiSyncForOrg(deps, baseInput())).rejects.toThrow(
      /simulated check-create failure/
    );
    expect(captured.runUpdates).toHaveLength(1);
    const failed = dataAt(captured.runUpdates, 0);
    expect(failed.status).toBe("FAILED");
    expect(failed.errorMessage).toBe("simulated check-create failure");
  });

  it("PharmaxError carrying metadata: errorMetadata copies the cause's metadata", async () => {
    const local = makeLocal();
    const cms = makeCms({ status: "D" });
    const { prisma, captured } = makeMockPrisma({ providers: [local] });
    const cmsClient = makeMockCmsClient(new Map([[local.npi, okFetch(cms)]]));
    const dispatchDeactivate = vi.fn<DispatchDeactivateProvider>().mockImplementation(async () => {
      throw new errors.InternalError({
        code: "DOWNSTREAM_BUS_OFFLINE",
        message: "command bus is not configured",
        metadata: { busAttempts: 3 },
      });
    });
    const deps = makeDeps({
      prisma,
      cmsClient,
      dispatchDeactivate: dispatchDeactivate as unknown as DispatchDeactivateProvider,
    });

    await expect(runNpiSyncForOrg(deps, baseInput())).rejects.toThrow(
      "command bus is not configured"
    );
    const busFailed = dataAt(captured.runUpdates, 0);
    expect(busFailed.status).toBe("FAILED");
    expect(busFailed.errorMetadata).toMatchObject({
      busAttempts: 3,
      errorCode: "DOWNSTREAM_BUS_OFFLINE",
    });
  });
});

describe("classifyDispatchError", () => {
  it("returns the race code for every recognized provider race", () => {
    const codes = [
      "PROVIDER_NOT_FOUND",
      "PROVIDER_INACTIVE",
      "PROVIDER_ALREADY_INACTIVE",
      "PROVIDER_UPDATE_RACE_LOST",
      "PROVIDER_UPDATE_NO_CHANGES",
      "PROVIDER_DEACTIVATE_RACE_LOST",
    ];
    for (const code of codes) {
      const err = Object.assign(new Error("x"), { code });
      expect(classifyDispatchError(err)).toBe(code);
    }
  });

  it("returns null for non-race errors", () => {
    expect(classifyDispatchError(new Error("plain"))).toBeNull();
    expect(classifyDispatchError({ code: "SOMETHING_ELSE" })).toBeNull();
    expect(classifyDispatchError(null)).toBeNull();
    expect(classifyDispatchError(undefined)).toBeNull();
    expect(classifyDispatchError("string-error")).toBeNull();
  });
});

describe("runNpiSyncForOrg — counter sanity", () => {
  it("all-COMPLETED COMPLETED counters add up to providersScanned", async () => {
    const ok1 = makeLocal({ id: "u1", npi: "1111111111", firstName: "Stale" });
    const ok2 = makeLocal({ id: "u2", npi: "2222222222" }); // NONE
    const inactive = makeLocal({ id: "i", npi: "3333333333", status: ProviderStatus.INACTIVE });
    const { prisma, captured } = makeMockPrisma({ providers: [ok1, ok2, inactive] });
    const cmsClient = makeMockCmsClient(
      new Map([
        [ok1.npi, okFetch(makeCms({ npi: ok1.npi, firstName: "Updated" }))],
        [ok2.npi, okFetch(makeCms({ npi: ok2.npi }))],
        [inactive.npi, okFetch(makeCms({ npi: inactive.npi, status: "A" }))],
      ])
    );
    const dispatchUpdate = vi
      .fn<DispatchUpdateProvider>()
      .mockResolvedValue({ ok: true, commandLogId: "x" });
    const deps = makeDeps({
      prisma,
      cmsClient,
      dispatchUpdate: dispatchUpdate as unknown as DispatchUpdateProvider,
    });

    const result = await runNpiSyncForOrg(deps, baseInput());

    expect(result.summary.providersScanned).toBe(3);
    const tally =
      result.summary.noChangeCount +
      result.summary.providersUpdated +
      result.summary.providersDeactivated +
      result.summary.reactivationCandidatesCreated +
      result.summary.notFoundAtCmsCount +
      result.summary.enumerationTypeMismatchCount +
      result.summary.fetchFailedCount;
    expect(tally).toBe(3);
    expect(captured.checks).toHaveLength(3);
  });
});
