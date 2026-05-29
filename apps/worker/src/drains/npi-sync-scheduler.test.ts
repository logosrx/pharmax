// NPI sync scheduler tick tests.
//
// Approach: mock the cross-tenant claim + actor lookup + the
// orchestrator (`runNpiSyncForOrg`) and assert outcomes. The
// orchestrator itself is exhaustively tested in
// `packages/providers/src/npi-sync/run-sync.test.ts`; here we only
// verify that the scheduler:
//   - claims via the system-context query
//   - resolves the per-org service user from the configured
//     `actorEmailLocalPart`
//   - skips orgs with no service user
//   - dispatches inside per-org tenancy with triggeredBy=CRON
//   - downgrades P2002 (active-run uniqueness loss) to SKIPPED
//   - tallies SUCCEEDED / FAILED / SKIPPED outcomes correctly

import { logger } from "@pharmax/platform-core";
import type { RunNpiSyncForOrgResult } from "@pharmax/providers";
import type * as ProvidersModuleType from "@pharmax/providers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The mock's args are deliberately typed as `unknown` so per-call
// `mockResolvedValueOnce(...)` overrides accept any
// `RunNpiSyncForOrgResult` (including FAILED) without TypeScript
// trying to narrow the return to the default implementation's
// literal status. We declare the explicit return type as
// `RunNpiSyncForOrgResult` for the same reason.
const runNpiSyncForOrgMock = vi.hoisted(() => {
  // Import the result type lazily inside the hoist (vi.hoisted runs
  // before module imports). The runtime value isn't used; this is
  // only for the static cast below.
  type Result = {
    runId: string;
    status: "COMPLETED" | "PARTIAL" | "FAILED";
    summary: {
      providersScanned: number;
      providersFetchedFromCms: number;
      noChangeCount: number;
      providersUpdated: number;
      providersDeactivated: number;
      reactivationCandidatesCreated: number;
      notFoundAtCmsCount: number;
      enumerationTypeMismatchCount: number;
      fetchFailedCount: number;
    };
  };
  return vi.fn(
    async (_deps: unknown, _input: unknown): Promise<Result> => ({
      runId: "run-1",
      status: "COMPLETED",
      summary: {
        providersScanned: 3,
        providersFetchedFromCms: 3,
        noChangeCount: 2,
        providersUpdated: 1,
        providersDeactivated: 0,
        reactivationCandidatesCreated: 0,
        notFoundAtCmsCount: 0,
        enumerationTypeMismatchCount: 0,
        fetchFailedCount: 0,
      },
    })
  );
});

const buildProductionDispatchersMock = vi.hoisted(() =>
  vi.fn(() => ({
    dispatchUpdateProvider: vi.fn(),
    dispatchDeactivateProvider: vi.fn(),
  }))
);

vi.mock("@pharmax/providers", async (importOriginal) => {
  type ProvidersModule = typeof ProvidersModuleType;
  const actual = await importOriginal<ProvidersModule>();
  return {
    ...actual,
    runNpiSyncForOrg: runNpiSyncForOrgMock,
    buildProductionDispatchers: buildProductionDispatchersMock,
  };
});

vi.mock("./claim-due-orgs-for-npi-sync.js", () => ({
  claimDueOrgsForNpiSync: vi.fn(),
}));

import { clock } from "@pharmax/platform-core";

import { claimDueOrgsForNpiSync } from "./claim-due-orgs-for-npi-sync.js";
import {
  createNpiSyncScheduler,
  type NpiSyncSchedulerPrismaSurface,
} from "./npi-sync-scheduler.js";

const ORG_ID_1 = "00000000-0000-4000-8000-000000000001";
const ORG_ID_2 = "00000000-0000-4000-8000-000000000002";
const SERVICE_USER_ID_1 = "00000000-0000-4000-8000-000000000091";
const SERVICE_USER_ID_2 = "00000000-0000-4000-8000-000000000092";

const DUE_ROW_1 = Object.freeze({
  organizationId: ORG_ID_1,
  organizationSlug: "acme",
  lastSuccessfulRunAt: new Date("2026-05-26T09:00:00.000Z"),
});

const DUE_ROW_2 = Object.freeze({
  organizationId: ORG_ID_2,
  organizationSlug: "globex",
  lastSuccessfulRunAt: null,
});

interface PrismaFake {
  client: NpiSyncSchedulerPrismaSurface;
  userFindFirst: ReturnType<typeof vi.fn>;
}

function buildPrismaFake(
  options: { actorByOrg?: ReadonlyMap<string, string | null> } = {}
): PrismaFake {
  const userFindFirst = vi.fn(async (args: { where: { organizationId: string } }) => {
    if (options.actorByOrg !== undefined) {
      const userId = options.actorByOrg.get(args.where.organizationId);
      if (userId === undefined) return null;
      return userId === null ? null : { id: userId };
    }
    // Default: every org has a service user keyed by org id.
    return { id: `service-user-${args.where.organizationId}` };
  });

  const client = {
    $queryRaw: vi.fn(),
    user: { findFirst: userFindFirst },
    organization: { findUnique: vi.fn() },
    commandLog: { findFirst: vi.fn() },
    provider: { findMany: vi.fn() },
    providerSyncRun: { create: vi.fn(), update: vi.fn() },
    providerSyncCheck: { create: vi.fn() },
    providerSyncReviewItem: { create: vi.fn() },
  } as unknown as NpiSyncSchedulerPrismaSurface;

  return { client, userFindFirst };
}

function buildCmsClient(): { fetchManyByNpi: ReturnType<typeof vi.fn> } {
  return { fetchManyByNpi: vi.fn() };
}

beforeEach(() => {
  runNpiSyncForOrgMock.mockClear();
  buildProductionDispatchersMock.mockClear();
  vi.mocked(claimDueOrgsForNpiSync).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("NpiSyncScheduler tick — empty batch", () => {
  it("returns zeros when no orgs are due", async () => {
    vi.mocked(claimDueOrgsForNpiSync).mockResolvedValue([]);
    const fake = buildPrismaFake();
    const scheduler = createNpiSyncScheduler(
      {
        client: fake.client,
        logger: logger.noopLogger,
        clock: clock.systemClock,
        cmsClient: buildCmsClient(),
      },
      { batchSize: 10, cadenceMs: 86_400_000 }
    );

    const result = await scheduler.tick();
    expect(result).toEqual({ claimed: 0, succeeded: 0, failed: 0, skipped: 0 });
    expect(runNpiSyncForOrgMock).not.toHaveBeenCalled();
    expect(fake.userFindFirst).not.toHaveBeenCalled();
  });
});

describe("NpiSyncScheduler tick — happy path", () => {
  it("processes each due org through runNpiSyncForOrg with triggeredBy=CRON", async () => {
    vi.mocked(claimDueOrgsForNpiSync).mockResolvedValue([DUE_ROW_1, DUE_ROW_2]);
    const fake = buildPrismaFake({
      actorByOrg: new Map([
        [ORG_ID_1, SERVICE_USER_ID_1],
        [ORG_ID_2, SERVICE_USER_ID_2],
      ]),
    });
    const cmsClient = buildCmsClient();
    const scheduler = createNpiSyncScheduler(
      {
        client: fake.client,
        logger: logger.noopLogger,
        clock: clock.systemClock,
        cmsClient,
      },
      { batchSize: 10, cadenceMs: 86_400_000, maxProvidersPerOrg: 500, cmsFetchBatchSize: 25 }
    );

    const result = await scheduler.tick();
    expect(result).toEqual({ claimed: 2, succeeded: 2, failed: 0, skipped: 0 });

    expect(runNpiSyncForOrgMock).toHaveBeenCalledTimes(2);

    const firstCall = runNpiSyncForOrgMock.mock.calls[0]!;
    const firstDeps = firstCall[0] as {
      cmsClient: unknown;
      dispatchUpdateProvider: unknown;
      dispatchDeactivateProvider: unknown;
    };
    const firstInput = firstCall[1] as {
      organizationId: string;
      triggeredBy: string;
      triggeredByUserId: string | null;
      maxProviders?: number;
      cmsFetchBatchSize?: number;
    };

    expect(firstInput.organizationId).toBe(ORG_ID_1);
    expect(firstInput.triggeredBy).toBe("CRON");
    expect(firstInput.triggeredByUserId).toBeNull();
    expect(firstInput.maxProviders).toBe(500);
    expect(firstInput.cmsFetchBatchSize).toBe(25);
    expect(firstDeps.cmsClient).toBe(cmsClient);
    expect(typeof firstDeps.dispatchUpdateProvider).toBe("function");
    expect(typeof firstDeps.dispatchDeactivateProvider).toBe("function");

    // Service user lookup should use the per-org slug.
    expect(fake.userFindFirst).toHaveBeenCalledWith({
      where: { organizationId: ORG_ID_1, email: "npi-sync@acme.test" },
      select: { id: true },
    });
    expect(fake.userFindFirst).toHaveBeenCalledWith({
      where: { organizationId: ORG_ID_2, email: "npi-sync@globex.test" },
      select: { id: true },
    });
  });

  it("threads a custom actorEmailLocalPart through the actor lookup", async () => {
    vi.mocked(claimDueOrgsForNpiSync).mockResolvedValue([DUE_ROW_1]);
    const fake = buildPrismaFake();
    const scheduler = createNpiSyncScheduler(
      {
        client: fake.client,
        logger: logger.noopLogger,
        clock: clock.systemClock,
        cmsClient: buildCmsClient(),
        actorEmailLocalPart: "npi-sync-prod",
      },
      { batchSize: 10, cadenceMs: 86_400_000 }
    );

    await scheduler.tick();
    expect(fake.userFindFirst).toHaveBeenCalledWith({
      where: { organizationId: ORG_ID_1, email: "npi-sync-prod@acme.test" },
      select: { id: true },
    });
  });

  it("omits maxProviders + cmsFetchBatchSize when not configured", async () => {
    vi.mocked(claimDueOrgsForNpiSync).mockResolvedValue([DUE_ROW_1]);
    const fake = buildPrismaFake();
    const scheduler = createNpiSyncScheduler(
      {
        client: fake.client,
        logger: logger.noopLogger,
        clock: clock.systemClock,
        cmsClient: buildCmsClient(),
      },
      { batchSize: 10, cadenceMs: 86_400_000 }
    );

    await scheduler.tick();
    const input = runNpiSyncForOrgMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(input).not.toHaveProperty("maxProviders");
    expect(input).not.toHaveProperty("cmsFetchBatchSize");
  });
});

describe("NpiSyncScheduler tick — skipped when service user missing", () => {
  it("skips the org and continues processing the rest", async () => {
    vi.mocked(claimDueOrgsForNpiSync).mockResolvedValue([DUE_ROW_1, DUE_ROW_2]);
    const fake = buildPrismaFake({
      actorByOrg: new Map([
        [ORG_ID_1, null],
        [ORG_ID_2, SERVICE_USER_ID_2],
      ]),
    });
    const scheduler = createNpiSyncScheduler(
      {
        client: fake.client,
        logger: logger.noopLogger,
        clock: clock.systemClock,
        cmsClient: buildCmsClient(),
      },
      { batchSize: 10, cadenceMs: 86_400_000 }
    );

    const result = await scheduler.tick();
    expect(result).toEqual({ claimed: 2, succeeded: 1, failed: 0, skipped: 1 });

    expect(runNpiSyncForOrgMock).toHaveBeenCalledTimes(1);
    const input = runNpiSyncForOrgMock.mock.calls[0]![1] as { organizationId: string };
    expect(input.organizationId).toBe(ORG_ID_2);
  });
});

describe("NpiSyncScheduler tick — failure isolation", () => {
  it("tallies FAILED when the orchestrator throws, then continues to the next org", async () => {
    vi.mocked(claimDueOrgsForNpiSync).mockResolvedValue([DUE_ROW_1, DUE_ROW_2]);
    const fake = buildPrismaFake();
    runNpiSyncForOrgMock.mockImplementationOnce(async () => {
      throw new Error("boom");
    });

    const scheduler = createNpiSyncScheduler(
      {
        client: fake.client,
        logger: logger.noopLogger,
        clock: clock.systemClock,
        cmsClient: buildCmsClient(),
      },
      { batchSize: 10, cadenceMs: 86_400_000 }
    );

    const result = await scheduler.tick();
    expect(result).toEqual({ claimed: 2, succeeded: 1, failed: 1, skipped: 0 });
    expect(runNpiSyncForOrgMock).toHaveBeenCalledTimes(2);
  });

  it("tallies FAILED when the orchestrator returns status=FAILED without throwing", async () => {
    vi.mocked(claimDueOrgsForNpiSync).mockResolvedValue([DUE_ROW_1]);
    const fake = buildPrismaFake();
    const failedResult: RunNpiSyncForOrgResult = {
      runId: "run-failed",
      status: "FAILED",
      summary: {
        providersScanned: 5,
        providersFetchedFromCms: 0,
        noChangeCount: 0,
        providersUpdated: 0,
        providersDeactivated: 0,
        reactivationCandidatesCreated: 0,
        notFoundAtCmsCount: 0,
        enumerationTypeMismatchCount: 0,
        fetchFailedCount: 5,
      },
    };
    runNpiSyncForOrgMock.mockResolvedValueOnce(failedResult);

    const scheduler = createNpiSyncScheduler(
      {
        client: fake.client,
        logger: logger.noopLogger,
        clock: clock.systemClock,
        cmsClient: buildCmsClient(),
      },
      { batchSize: 10, cadenceMs: 86_400_000 }
    );

    const result = await scheduler.tick();
    expect(result).toEqual({ claimed: 1, succeeded: 0, failed: 1, skipped: 0 });
  });
});

describe("NpiSyncScheduler tick — P2002 active-run race downgrade", () => {
  it("treats a P2002 violation from the orchestrator as SKIPPED", async () => {
    vi.mocked(claimDueOrgsForNpiSync).mockResolvedValue([DUE_ROW_1]);
    const fake = buildPrismaFake();
    runNpiSyncForOrgMock.mockImplementationOnce(async () => {
      // Mirror Prisma's bare-object PrismaClientKnownRequestError shape.
      const err: { code: string; meta: Record<string, unknown> } = {
        code: "P2002",
        meta: { target: ["provider_sync_run_active_unique"] },
      };
      throw err;
    });

    const scheduler = createNpiSyncScheduler(
      {
        client: fake.client,
        logger: logger.noopLogger,
        clock: clock.systemClock,
        cmsClient: buildCmsClient(),
      },
      { batchSize: 10, cadenceMs: 86_400_000 }
    );

    const result = await scheduler.tick();
    expect(result).toEqual({ claimed: 1, succeeded: 0, failed: 0, skipped: 1 });
  });
});
