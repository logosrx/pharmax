// NPI Registry sync — per-org orchestrator.
//
// FOURTH SLICE of the `SyncFromNpiRegistry` worker. The previous
// slices supplied:
//   - slice 1: the pure diff engine (`diffProviderAgainstCms`)
//   - slice 2: the CMS NPPES HTTP client (`CmsNppesClient`)
//   - slice 3: the persistence schema (`provider_sync_run` +
//              `provider_sync_check` + `provider_sync_review_item`)
//
// Slice 4 wires those three into a single unit of work: take an
// organization, fan out CMS lookups for every provider, classify
// each result via the diff engine, dispatch
// `UpdateProvider` / `DeactivateProvider` for the actionable cases,
// and persist `provider_sync_check` / `provider_sync_review_item`
// rows for every check the worker performed.
//
// SCOPE BOUNDARY — slice 4 vs. slice 5:
//   - This file: per-ORG work. Caller provides organizationId +
//     actor; we run the sync for THAT org. Caller is responsible
//     for entering the org's tenancy context BEFORE calling. The
//     tenant-Prisma extension auto-scopes the `provider.findMany`
//     read + the three audit-row writes; the dispatched commands
//     run through the command bus in the same tenancy frame.
//   - Slice 5 (cron / scheduling layer): the cross-tenant
//     orchestration. A worker drain ticks periodically, picks
//     orgs due for a sync, enters each org's tenancy, and calls
//     `runNpiSyncForOrg` once per org. The slice-5 drain also
//     reaps stuck IN_PROGRESS runs whose runtime ceiling has
//     elapsed.
//
// WHY DISPATCH IS INJECTED.
//   The slice-1 diff engine emits `SyncAction` discriminants; the
//   worker calls the command bus to enact UPDATE and DEACTIVATE.
//   We could call `executeCommand(UpdateProvider, ...)` directly
//   here, but that couples the worker to (a) the bus's
//   configuration lifecycle, (b) tenancy-context plumbing for the
//   per-command frame, and (c) the post-hoc lookup that resolves
//   the dispatched command's `command_log.id` for the
//   `provider_sync_check.dispatchedCommandLogId` foreign key. The
//   adapters are TESTABLE WHEN THEY ARE THE THING UNDER TEST and
//   OUT OF THE WAY WHEN THEY ARE NOT. We move the executeCommand
//   wiring + commandLogId resolution into two injected functions
//   (`dispatchUpdateProvider` / `dispatchDeactivateProvider`) so
//   slice-4 tests can mock dispatch outcomes (success with
//   commandLogId, race-rejected with typed code, transient
//   failure) without spinning up the bus. The slice-5 drain will
//   wire the real adapters.
//
// RACE HANDLING.
//   Between the moment the worker reads a provider row and the
//   moment it dispatches a command for it, a concurrent operator
//   action MAY change the provider's state. The four command
//   handlers raise typed `ConflictError`s for these cases:
//     - `PROVIDER_INACTIVE`               — UpdateProvider on a row that's been
//                                           deactivated concurrently.
//     - `PROVIDER_UPDATE_RACE_LOST`       — UpdateProvider's CAS predicate failed.
//     - `PROVIDER_ALREADY_INACTIVE`       — DeactivateProvider on an already-INACTIVE row.
//     - `PROVIDER_DEACTIVATE_RACE_LOST`   — DeactivateProvider's CAS predicate failed.
//     - `PROVIDER_NOT_FOUND`              — provider was hard-deleted (we don't hard-
//                                           delete today, but defense-in-depth).
//     - `PROVIDER_UPDATE_NO_CHANGES`      — the change-set computed at engine time
//                                           became a no-op (extremely unlikely; could
//                                           happen if the operator concurrently
//                                           applied the same change).
//   The dispatcher returns these as `{ ok: false, raceCode }` rather
//   than throwing; the worker writes a `provider_sync_check` row
//   with `action=NONE` + `actionDetail=race:<code>` for audit
//   traceability and CONTINUES with the next provider. Unrecognized
//   errors propagate up; the outer try/catch marks the run FAILED.
//
// IDEMPOTENCY.
//   The worker generates one idempotency key per (run, provider,
//   action): `npi-sync:<runId>:<providerId>:<action>`. This means
//   a CRASH-AND-RETRY of the same run never double-dispatches; a
//   DIFFERENT run (different runId) freely dispatches the same
//   action again if it's still applicable. Slice 5's reaper marks
//   the original run FAILED and a subsequent run picks up the same
//   provider via the standard provider listing, generating a new
//   runId-keyed idempotency key.
//
// REVIEW-ITEM DEDUP.
//   The slice-3 schema enforces "at most one OPEN review item per
//   (provider, kind)" via the partial unique index
//   `provider_sync_review_item_open_unique`. The worker catches
//   the resulting P2002 from Prisma and treats it as "already
//   open, skip the insert" — the prior open row is still the
//   operator's actionable handle. The `provider_sync_check` row
//   is still written for the re-emission so the run-detail view
//   shows the second observation.
//
// RUN FINALIZATION.
//   - Success: `status = COMPLETED` if `fetchFailedCount === 0`,
//     else `PARTIAL`. Counters are denormalized on the run row so
//     dashboards don't have to aggregate over per-check rows.
//   - Error (anywhere from "create run row" through "fan-out
//     loop"): `status = FAILED`, `errorMessage` + `errorMetadata`
//     populated from the PharmaxError (or a generic synthesizer
//     for non-PharmaxError exceptions).
//   - Worker process crash mid-run: row stays IN_PROGRESS. Slice
//     5's reaper sweeps it to FAILED after a configurable runtime
//     ceiling.
//
// CONCURRENCY (within a run).
//   We process providers SEQUENTIALLY. CMS NPPES throughput is the
//   binding constraint (the `CmsNppesClient`'s rate limiter
//   serializes request starts at ~8 req/s); fanning out provider
//   processing in parallel buys nothing at this rate. Sequential
//   also means our `provider_sync_run` counter increments are
//   trivially safe (no atomic-update concerns). When/if we grow
//   past 10k providers/org, we can revisit with a bounded
//   `Promise.all` and a per-counter atomic.

import { ProviderStatus } from "@pharmax/database";
import { errors, type clock as clockNs, type logger as loggerNs } from "@pharmax/platform-core";

import type {
  DeactivateProviderInput,
  ProviderDeactivationReason,
} from "../commands/deactivate-provider.js";
import type { UpdateProviderInput } from "../commands/update-provider.js";
import type { CmsFetchResult, CmsNppesClient } from "./cms-client.js";
import {
  diffProviderAgainstCms,
  type CmsNpiSnapshot,
  type LocalProviderSnapshot,
  type ProviderUpdateChanges,
  type SyncAction,
} from "./diff-engine.js";

type Clock = clockNs.Clock;
type Logger = loggerNs.Logger;

// ---------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------

/**
 * Outcome of a single command dispatch from the worker's perspective.
 *
 * Success carries `commandLogId` so the worker can backlink the
 * `provider_sync_check` row to the dispatched command. The bus
 * already wrote `command_log` / `audit_log` / `event_outbox` for
 * us; the FK on `provider_sync_check` is the "what sync caused
 * this command?" traceback handle.
 */
export type DispatchResult =
  | { readonly ok: true; readonly commandLogId: string }
  | { readonly ok: false; readonly raceCode: ProviderRaceCode };

/** Typed conflict codes the worker recognizes as "harmless races". */
export type ProviderRaceCode =
  | "PROVIDER_NOT_FOUND"
  | "PROVIDER_INACTIVE"
  | "PROVIDER_ALREADY_INACTIVE"
  | "PROVIDER_UPDATE_RACE_LOST"
  | "PROVIDER_UPDATE_NO_CHANGES"
  | "PROVIDER_DEACTIVATE_RACE_LOST";

const RACE_CODES: ReadonlySet<string> = new Set<ProviderRaceCode>([
  "PROVIDER_NOT_FOUND",
  "PROVIDER_INACTIVE",
  "PROVIDER_ALREADY_INACTIVE",
  "PROVIDER_UPDATE_RACE_LOST",
  "PROVIDER_UPDATE_NO_CHANGES",
  "PROVIDER_DEACTIVATE_RACE_LOST",
]);

/**
 * Options passed to every dispatch call. The idempotency key is
 * the worker's responsibility (one per (run, provider, action)).
 */
export interface DispatchOptions {
  readonly idempotencyKey: string;
}

/** Adapter function: dispatch UpdateProvider, return commandLogId or race code. */
export type DispatchUpdateProvider = (
  input: UpdateProviderInput,
  options: DispatchOptions
) => Promise<DispatchResult>;

/** Adapter function: dispatch DeactivateProvider, return commandLogId or race code. */
export type DispatchDeactivateProvider = (
  input: DeactivateProviderInput,
  options: DispatchOptions
) => Promise<DispatchResult>;

/**
 * The narrow Prisma surface the worker actually touches. Tests
 * pass an object literal with these methods mocked; production
 * passes the real `PrismaClient` (the tenant extension auto-scopes
 * the queries).
 */
export interface ProviderSyncPrismaSurface {
  readonly provider: {
    findMany: (args: {
      readonly orderBy: { readonly id: "asc" };
      readonly take?: number;
      readonly cursor?: { readonly id: string };
      readonly skip?: number;
    }) => Promise<ReadonlyArray<ProviderRowProjection>>;
  };
  readonly providerSyncRun: {
    create: (args: {
      readonly data: ProviderSyncRunCreateData;
    }) => Promise<{ readonly id: string }>;
    update: (args: {
      readonly where: { readonly id: string };
      readonly data: ProviderSyncRunUpdateData;
    }) => Promise<unknown>;
  };
  readonly providerSyncCheck: {
    create: (args: {
      readonly data: ProviderSyncCheckCreateData;
    }) => Promise<{ readonly id: string }>;
  };
  readonly providerSyncReviewItem: {
    create: (args: { readonly data: ProviderSyncReviewItemCreateData }) => Promise<unknown>;
  };
}

/**
 * Provider columns the worker reads. Identical to the slice-1
 * `LocalProviderSnapshot` shape (we re-export the alias so callers
 * needn't import both names from the same package).
 */
export type ProviderRowProjection = LocalProviderSnapshot;

interface ProviderSyncRunCreateData {
  readonly organizationId: string;
  readonly status: "IN_PROGRESS";
  readonly triggeredBy: "CRON" | "MANUAL" | "BACKFILL";
  readonly triggeredByUserId: string | null;
  readonly startedAt: Date;
}

interface ProviderSyncRunUpdateData {
  readonly status?: "COMPLETED" | "PARTIAL" | "FAILED";
  readonly completedAt?: Date;
  readonly providersScanned?: number;
  readonly providersFetchedFromCms?: number;
  readonly noChangeCount?: number;
  readonly providersUpdated?: number;
  readonly providersDeactivated?: number;
  readonly reactivationCandidatesCreated?: number;
  readonly notFoundAtCmsCount?: number;
  readonly enumerationTypeMismatchCount?: number;
  readonly fetchFailedCount?: number;
  readonly errorMessage?: string;
  readonly errorMetadata?: Record<string, unknown>;
}

interface ProviderSyncCheckCreateData {
  readonly organizationId: string;
  readonly providerSyncRunId: string;
  readonly providerId: string;
  readonly npi: string;
  readonly checkedAt: Date;
  readonly action:
    | "NONE"
    | "UPDATE"
    | "DEACTIVATE"
    | "REACTIVATION_CANDIDATE"
    | "NOT_FOUND_AT_CMS"
    | "ENUMERATION_TYPE_MISMATCH"
    | "FETCH_FAILED";
  readonly actionDetail: string | null;
  readonly cmsStatus: string | null;
  readonly cmsLastUpdatedAt: Date | null;
  readonly dispatchedCommandLogId: string | null;
  readonly errorCode: string | null;
  readonly errorMetadata: Record<string, unknown> | null;
}

interface ProviderSyncReviewItemCreateData {
  readonly organizationId: string;
  readonly providerId: string;
  readonly providerSyncRunId: string;
  readonly providerSyncCheckId: string;
  readonly kind: "REACTIVATION_CANDIDATE" | "NOT_FOUND_AT_CMS" | "ENUMERATION_TYPE_MISMATCH";
  readonly discoveredAt: Date;
  readonly cmsSnapshot: Record<string, unknown> | null;
  readonly localSnapshot: Record<string, unknown>;
}

/** Dependency-injection surface for the worker. */
export interface RunNpiSyncForOrgDeps {
  readonly prisma: ProviderSyncPrismaSurface;
  readonly cmsClient: Pick<CmsNppesClient, "fetchManyByNpi">;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly dispatchUpdateProvider: DispatchUpdateProvider;
  readonly dispatchDeactivateProvider: DispatchDeactivateProvider;
}

/** Per-call input. */
export interface RunNpiSyncForOrgInput {
  readonly organizationId: string;
  readonly triggeredBy: "CRON" | "MANUAL" | "BACKFILL";
  readonly triggeredByUserId: string | null;
  /**
   * Optional cap on the number of providers processed in this run.
   * Default unlimited. Used by BACKFILL paths that want to chunk
   * across multiple runs, and by tests.
   */
  readonly maxProviders?: number;
  /**
   * CMS lookups are fan-out via `fetchManyByNpi(npis)` in chunks
   * of this size. The CMS client's rate limiter is the binding
   * throughput constraint; this knob just shapes memory/IO
   * granularity. Default 50.
   */
  readonly cmsFetchBatchSize?: number;
}

export interface RunNpiSyncForOrgSummary {
  readonly providersScanned: number;
  readonly providersFetchedFromCms: number;
  readonly noChangeCount: number;
  readonly providersUpdated: number;
  readonly providersDeactivated: number;
  readonly reactivationCandidatesCreated: number;
  readonly notFoundAtCmsCount: number;
  readonly enumerationTypeMismatchCount: number;
  readonly fetchFailedCount: number;
}

export interface RunNpiSyncForOrgResult {
  readonly runId: string;
  readonly status: "COMPLETED" | "PARTIAL" | "FAILED";
  readonly summary: RunNpiSyncForOrgSummary;
}

const DEFAULT_CMS_FETCH_BATCH_SIZE = 50;

// ---------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------

/**
 * Reconcile every provider in `input.organizationId` against the
 * CMS NPI Registry. Returns the run id + final status + counters.
 *
 * Caller MUST enter the org's tenancy frame before calling.
 *
 * The function NEVER throws on per-provider failures — those are
 * captured as `provider_sync_check` rows with action=FETCH_FAILED
 * (CMS-side) or action=NONE + race-code actionDetail (command-bus
 * side). It DOES throw on structural failures (DB connectivity,
 * unrecognized command-bus exceptions) AFTER first updating the
 * run row to status=FAILED with the error metadata.
 */
export async function runNpiSyncForOrg(
  deps: RunNpiSyncForOrgDeps,
  input: RunNpiSyncForOrgInput
): Promise<RunNpiSyncForOrgResult> {
  const log = deps.logger.child({
    component: "npi-sync-worker",
    organizationId: input.organizationId,
    triggeredBy: input.triggeredBy,
  });

  const startedAt = deps.clock.now();
  const batchSize = input.cmsFetchBatchSize ?? DEFAULT_CMS_FETCH_BATCH_SIZE;

  // Step 1 — create the IN_PROGRESS run row.
  const created = await deps.prisma.providerSyncRun.create({
    data: {
      organizationId: input.organizationId,
      status: "IN_PROGRESS",
      triggeredBy: input.triggeredBy,
      triggeredByUserId: input.triggeredByUserId,
      startedAt,
    },
  });
  const runId = created.id;
  const runLog = log.child({ runId });
  runLog.info("npi-sync.run.started");

  // Counters accumulate in-memory; persisted to the run row on
  // finalize. (We could write them after each provider, but that's
  // O(N) extra updates per run with no observability win — the
  // operator dashboard reads the FINAL counters.)
  const summary: Mutable<RunNpiSyncForOrgSummary> = {
    providersScanned: 0,
    providersFetchedFromCms: 0,
    noChangeCount: 0,
    providersUpdated: 0,
    providersDeactivated: 0,
    reactivationCandidatesCreated: 0,
    notFoundAtCmsCount: 0,
    enumerationTypeMismatchCount: 0,
    fetchFailedCount: 0,
  };

  try {
    // Step 2 — list providers. Ordered + bounded. We deliberately
    // include INACTIVE providers because the diff engine emits
    // REACTIVATION_CANDIDATE for "CMS active, local INACTIVE" —
    // skipping INACTIVE here would silently disable that path.
    const providers = await deps.prisma.provider.findMany({
      orderBy: { id: "asc" },
      ...(input.maxProviders !== undefined ? { take: input.maxProviders } : {}),
    });
    summary.providersScanned = providers.length;
    runLog.info("npi-sync.run.providers_listed", { count: providers.length });

    if (providers.length === 0) {
      // No providers — short-circuit to a COMPLETED run with all
      // zero counters. The run row still anchors a "we tried"
      // entry on the dashboard, which is useful for orgs that
      // just provisioned but haven't loaded providers yet.
      await finalizeRun(deps, runId, "COMPLETED", summary, deps.clock.now());
      runLog.info("npi-sync.run.completed_empty");
      return { runId, status: "COMPLETED", summary };
    }

    // Step 3 — fan out CMS lookups in batches.
    for (let offset = 0; offset < providers.length; offset += batchSize) {
      const batch = providers.slice(offset, offset + batchSize);
      const npis = batch.map((p) => p.npi);

      // Catastrophic CMS-client failure (e.g. bad input shape,
      // misconfigured user agent) propagates to the outer
      // try/catch and surfaces as FAILED — these are programmer
      // errors, not transient network issues (the client retries
      // those internally per slice 2).
      const fetched = await deps.cmsClient.fetchManyByNpi(npis);
      summary.providersFetchedFromCms += npis.length;

      // Step 4 — per-provider classification + dispatch.
      for (const local of batch) {
        const fetchResult = fetched.get(local.npi);
        // Defensive: the client's contract is "one entry per
        // queried NPI". A missing entry is a contract violation.
        if (fetchResult === undefined) {
          throw new errors.InternalError({
            code: "NPI_SYNC_CLIENT_CONTRACT_VIOLATION",
            message:
              "CmsNppesClient.fetchManyByNpi returned no entry for an NPI it was asked about.",
            metadata: { npi: local.npi, runId },
          });
        }

        await processOneProvider({
          deps,
          input,
          runId,
          local,
          fetchResult,
          summary,
        });
      }
    }

    // Step 5 — finalize.
    const finalStatus: "COMPLETED" | "PARTIAL" =
      summary.fetchFailedCount === 0 ? "COMPLETED" : "PARTIAL";
    await finalizeRun(deps, runId, finalStatus, summary, deps.clock.now());
    runLog.info("npi-sync.run.completed", { ...summary, status: finalStatus });
    return { runId, status: finalStatus, summary };
  } catch (cause) {
    // Run-level failure. Capture, mark FAILED, re-throw so the
    // caller (slice-5 drain) can decide whether to retry or move
    // on.
    const { errorCode, errorMessage, errorMetadata } = describeRunError(cause);
    try {
      await deps.prisma.providerSyncRun.update({
        where: { id: runId },
        data: {
          status: "FAILED",
          completedAt: deps.clock.now(),
          providersScanned: summary.providersScanned,
          providersFetchedFromCms: summary.providersFetchedFromCms,
          noChangeCount: summary.noChangeCount,
          providersUpdated: summary.providersUpdated,
          providersDeactivated: summary.providersDeactivated,
          reactivationCandidatesCreated: summary.reactivationCandidatesCreated,
          notFoundAtCmsCount: summary.notFoundAtCmsCount,
          enumerationTypeMismatchCount: summary.enumerationTypeMismatchCount,
          fetchFailedCount: summary.fetchFailedCount,
          errorMessage,
          errorMetadata: { ...errorMetadata, errorCode },
        },
      });
    } catch (finalizeError) {
      // If we cannot even update the run row to FAILED, log and
      // leave the row IN_PROGRESS. The slice-5 reaper will pick
      // it up later. We re-throw the ORIGINAL error so the
      // caller sees the actual cause.
      runLog.error("npi-sync.run.failed_finalize_failed", {
        errorCode,
        finalizeErrorMessage:
          finalizeError instanceof Error ? finalizeError.message : String(finalizeError),
      });
    }
    runLog.error("npi-sync.run.failed", { errorCode, errorMessage, ...summary });
    throw cause;
  }
}

// ---------------------------------------------------------------------
// Per-provider step
// ---------------------------------------------------------------------

interface ProcessOneProviderArgs {
  readonly deps: RunNpiSyncForOrgDeps;
  readonly input: RunNpiSyncForOrgInput;
  readonly runId: string;
  readonly local: ProviderRowProjection;
  readonly fetchResult: CmsFetchResult;
  readonly summary: Mutable<RunNpiSyncForOrgSummary>;
}

async function processOneProvider(args: ProcessOneProviderArgs): Promise<void> {
  const { deps, input, runId, local, fetchResult, summary } = args;
  const now = deps.clock.now();

  // CMS fetch failed for THIS NPI specifically. Persist as
  // FETCH_FAILED + the structured error metadata; never dispatch.
  if (!fetchResult.ok) {
    const e = fetchResult.error;
    await deps.prisma.providerSyncCheck.create({
      data: {
        organizationId: input.organizationId,
        providerSyncRunId: runId,
        providerId: local.id,
        npi: local.npi,
        checkedAt: now,
        action: "FETCH_FAILED",
        actionDetail: e.code,
        cmsStatus: null,
        cmsLastUpdatedAt: null,
        dispatchedCommandLogId: null,
        errorCode: e.code,
        errorMetadata: { ...e.metadata, message: e.message },
      },
    });
    summary.fetchFailedCount += 1;
    return;
  }

  const cms = fetchResult.snapshot; // may be null = NOT_FOUND_AT_CMS shortcut
  const action = diffProviderAgainstCms(local, cms);

  // Branch on the diff engine's discriminant.
  switch (action.kind) {
    case "NONE":
      await deps.prisma.providerSyncCheck.create({
        data: buildCheckRow({
          input,
          runId,
          local,
          cms,
          now,
          action: "NONE",
          actionDetail: action.reason,
          dispatchedCommandLogId: null,
        }),
      });
      summary.noChangeCount += 1;
      return;

    case "UPDATE":
      await handleUpdateAction({ deps, input, runId, local, cms, action, now, summary });
      return;

    case "DEACTIVATE":
      await handleDeactivateAction({ deps, input, runId, local, cms, action, now, summary });
      return;

    case "REACTIVATION_CANDIDATE":
    case "NOT_FOUND_AT_CMS":
    case "ENUMERATION_TYPE_MISMATCH":
      await handleReviewItemAction({ deps, input, runId, local, cms, action, now, summary });
      return;

    default: {
      // Compile-time exhaustiveness.
      const _exhaustive: never = action;
      throw new errors.InternalError({
        code: "NPI_SYNC_UNKNOWN_ACTION",
        message: "Diff engine returned an unknown SyncAction kind.",
        metadata: { runId, providerId: local.id, action: _exhaustive },
      });
    }
  }
}

// ---------------------------------------------------------------------
// UPDATE branch
// ---------------------------------------------------------------------

async function handleUpdateAction(args: {
  readonly deps: RunNpiSyncForOrgDeps;
  readonly input: RunNpiSyncForOrgInput;
  readonly runId: string;
  readonly local: ProviderRowProjection;
  readonly cms: CmsNpiSnapshot | null;
  readonly action: Extract<SyncAction, { kind: "UPDATE" }>;
  readonly now: Date;
  readonly summary: Mutable<RunNpiSyncForOrgSummary>;
}): Promise<void> {
  const { deps, input, runId, local, cms, action, now, summary } = args;
  const idempotencyKey = buildIdempotencyKey(runId, local.id, "UPDATE");

  const result = await deps.dispatchUpdateProvider(
    { providerId: local.id, ...action.changes },
    { idempotencyKey }
  );

  if (!result.ok) {
    // Race. Write a NONE row with the race code so the audit
    // trail records "we observed an UPDATE diff but the dispatch
    // lost a race to a concurrent operator action".
    await deps.prisma.providerSyncCheck.create({
      data: buildCheckRow({
        input,
        runId,
        local,
        cms,
        now,
        action: "NONE",
        actionDetail: `race:${result.raceCode}`,
        dispatchedCommandLogId: null,
      }),
    });
    summary.noChangeCount += 1;
    return;
  }

  await deps.prisma.providerSyncCheck.create({
    data: buildCheckRow({
      input,
      runId,
      local,
      cms,
      now,
      action: "UPDATE",
      actionDetail: serializeChangedKeys(action.changes),
      dispatchedCommandLogId: result.commandLogId,
    }),
  });
  summary.providersUpdated += 1;
}

// ---------------------------------------------------------------------
// DEACTIVATE branch
// ---------------------------------------------------------------------

async function handleDeactivateAction(args: {
  readonly deps: RunNpiSyncForOrgDeps;
  readonly input: RunNpiSyncForOrgInput;
  readonly runId: string;
  readonly local: ProviderRowProjection;
  readonly cms: CmsNpiSnapshot | null;
  readonly action: Extract<SyncAction, { kind: "DEACTIVATE" }>;
  readonly now: Date;
  readonly summary: Mutable<RunNpiSyncForOrgSummary>;
}): Promise<void> {
  const { deps, input, runId, local, cms, action, now, summary } = args;
  const idempotencyKey = buildIdempotencyKey(runId, local.id, "DEACTIVATE");

  // Defensive: the diff engine only emits DEACTIVATE when cms.status
  // === 'D', which means cms is non-null. But TypeScript narrowing
  // doesn't cross the function boundary, so we re-derive the
  // reasonText here from `action.reasonText` (which the engine
  // already computed via `buildSyncDeactivationReasonText`).
  const result = await deps.dispatchDeactivateProvider(
    {
      providerId: local.id,
      reason: action.reason as ProviderDeactivationReason,
      reasonText: action.reasonText,
    },
    { idempotencyKey }
  );

  if (!result.ok) {
    await deps.prisma.providerSyncCheck.create({
      data: buildCheckRow({
        input,
        runId,
        local,
        cms,
        now,
        action: "NONE",
        actionDetail: `race:${result.raceCode}`,
        dispatchedCommandLogId: null,
      }),
    });
    summary.noChangeCount += 1;
    return;
  }

  await deps.prisma.providerSyncCheck.create({
    data: buildCheckRow({
      input,
      runId,
      local,
      cms,
      now,
      action: "DEACTIVATE",
      actionDetail: action.reason,
      dispatchedCommandLogId: result.commandLogId,
    }),
  });
  summary.providersDeactivated += 1;
}

// ---------------------------------------------------------------------
// Review-item branch (REACTIVATION_CANDIDATE / NOT_FOUND_AT_CMS /
// ENUMERATION_TYPE_MISMATCH)
// ---------------------------------------------------------------------

async function handleReviewItemAction(args: {
  readonly deps: RunNpiSyncForOrgDeps;
  readonly input: RunNpiSyncForOrgInput;
  readonly runId: string;
  readonly local: ProviderRowProjection;
  readonly cms: CmsNpiSnapshot | null;
  readonly action: Extract<
    SyncAction,
    { kind: "REACTIVATION_CANDIDATE" | "NOT_FOUND_AT_CMS" | "ENUMERATION_TYPE_MISMATCH" }
  >;
  readonly now: Date;
  readonly summary: Mutable<RunNpiSyncForOrgSummary>;
}): Promise<void> {
  const { deps, input, runId, local, cms, action, now, summary } = args;

  const actionDetail = buildReviewItemActionDetail(action);

  // Write the check row FIRST. The review_item row references it
  // via FK, so the check id must exist before we attempt the
  // review-item insert.
  const check = await deps.prisma.providerSyncCheck.create({
    data: buildCheckRow({
      input,
      runId,
      local,
      cms,
      now,
      action: action.kind,
      actionDetail,
      dispatchedCommandLogId: null,
    }),
  });

  // Now try to open a review item. The partial unique index
  // enforces "at most one OPEN per (provider, kind)" — a duplicate
  // insert (worker re-emitting a finding still being reviewed)
  // raises P2002, which we treat as "already open, skip".
  try {
    await deps.prisma.providerSyncReviewItem.create({
      data: {
        organizationId: input.organizationId,
        providerId: local.id,
        providerSyncRunId: runId,
        providerSyncCheckId: check.id,
        kind: action.kind,
        discoveredAt: now,
        // For NOT_FOUND_AT_CMS: cmsSnapshot is null (the whole
        // point — CMS returned no result). For the other two
        // kinds we serialize the full snapshot.
        cmsSnapshot: action.kind === "NOT_FOUND_AT_CMS" ? null : serializeCmsSnapshot(cms),
        localSnapshot: serializeLocalSnapshot(local),
      },
    });
  } catch (cause) {
    if (!isPrismaUniqueViolation(cause)) {
      throw cause;
    }
    // Idempotent re-emit: prior OPEN review item is still the
    // operator's actionable handle. The check row above already
    // recorded the new observation.
  }

  switch (action.kind) {
    case "REACTIVATION_CANDIDATE":
      summary.reactivationCandidatesCreated += 1;
      return;
    case "NOT_FOUND_AT_CMS":
      summary.notFoundAtCmsCount += 1;
      return;
    case "ENUMERATION_TYPE_MISMATCH":
      summary.enumerationTypeMismatchCount += 1;
      return;
  }
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

interface BuildCheckRowArgs {
  readonly input: RunNpiSyncForOrgInput;
  readonly runId: string;
  readonly local: ProviderRowProjection;
  readonly cms: CmsNpiSnapshot | null;
  readonly now: Date;
  readonly action: ProviderSyncCheckCreateData["action"];
  readonly actionDetail: string | null;
  readonly dispatchedCommandLogId: string | null;
}

function buildCheckRow(args: BuildCheckRowArgs): ProviderSyncCheckCreateData {
  return {
    organizationId: args.input.organizationId,
    providerSyncRunId: args.runId,
    providerId: args.local.id,
    npi: args.local.npi,
    checkedAt: args.now,
    action: args.action,
    actionDetail: args.actionDetail,
    cmsStatus: args.cms?.status ?? null,
    cmsLastUpdatedAt: args.cms?.lastUpdatedAtCms ?? null,
    dispatchedCommandLogId: args.dispatchedCommandLogId,
    errorCode: null,
    errorMetadata: null,
  };
}

function buildIdempotencyKey(
  runId: string,
  providerId: string,
  action: "UPDATE" | "DEACTIVATE"
): string {
  return `npi-sync:${runId}:${providerId}:${action}`;
}

function buildReviewItemActionDetail(
  action: Extract<
    SyncAction,
    { kind: "REACTIVATION_CANDIDATE" | "NOT_FOUND_AT_CMS" | "ENUMERATION_TYPE_MISMATCH" }
  >
): string | null {
  switch (action.kind) {
    case "REACTIVATION_CANDIDATE":
      return null;
    case "NOT_FOUND_AT_CMS":
      return null;
    case "ENUMERATION_TYPE_MISMATCH":
      return `local=NPI-1,cms=${action.cmsType}`;
  }
}

function serializeChangedKeys(changes: ProviderUpdateChanges): string {
  return Object.keys(changes).sort().join(",");
}

function serializeCmsSnapshot(cms: CmsNpiSnapshot | null): Record<string, unknown> | null {
  if (cms === null) return null;
  // Direct serialization is fine: every field is a JSON primitive
  // (string / number / null / nested-object-of-the-same), and the
  // Date column serializes to an ISO string via the column's
  // `cmsLastUpdatedAt` field which we also expose denormalized.
  return {
    npi: cms.npi,
    enumerationType: cms.enumerationType,
    status: cms.status,
    firstName: cms.firstName,
    lastName: cms.lastName,
    credential: cms.credential,
    practiceAddress:
      cms.practiceAddress === null
        ? null
        : {
            line1: cms.practiceAddress.line1,
            line2: cms.practiceAddress.line2,
            city: cms.practiceAddress.city,
            stateCode: cms.practiceAddress.stateCode,
            postalCode: cms.practiceAddress.postalCode,
            phone: cms.practiceAddress.phone,
          },
    lastUpdatedAtCms: cms.lastUpdatedAtCms.toISOString(),
  };
}

function serializeLocalSnapshot(local: ProviderRowProjection): Record<string, unknown> {
  return {
    id: local.id,
    organizationId: local.organizationId,
    npi: local.npi,
    status: local.status,
    firstName: local.firstName,
    lastName: local.lastName,
    credential: local.credential,
    addressLine1: local.addressLine1,
    addressLine2: local.addressLine2,
    city: local.city,
    state: local.state,
    postalCode: local.postalCode,
    phone: local.phone,
  };
}

function isPrismaUniqueViolation(cause: unknown): boolean {
  if (cause === null || typeof cause !== "object") return false;
  const c = cause as { code?: unknown };
  return c.code === "P2002";
}

interface DescribedError {
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly errorMetadata: Record<string, unknown>;
}

function describeRunError(cause: unknown): DescribedError {
  if (cause instanceof errors.PharmaxError) {
    return {
      errorCode: cause.code,
      errorMessage: cause.message,
      errorMetadata: { ...cause.metadata },
    };
  }
  if (cause instanceof Error) {
    return {
      errorCode: "NPI_SYNC_RUN_UNEXPECTED",
      errorMessage: cause.message,
      errorMetadata: { name: cause.name },
    };
  }
  return {
    errorCode: "NPI_SYNC_RUN_UNEXPECTED",
    errorMessage: String(cause),
    errorMetadata: {},
  };
}

async function finalizeRun(
  deps: RunNpiSyncForOrgDeps,
  runId: string,
  status: "COMPLETED" | "PARTIAL",
  summary: RunNpiSyncForOrgSummary,
  completedAt: Date
): Promise<void> {
  await deps.prisma.providerSyncRun.update({
    where: { id: runId },
    data: {
      status,
      completedAt,
      providersScanned: summary.providersScanned,
      providersFetchedFromCms: summary.providersFetchedFromCms,
      noChangeCount: summary.noChangeCount,
      providersUpdated: summary.providersUpdated,
      providersDeactivated: summary.providersDeactivated,
      reactivationCandidatesCreated: summary.reactivationCandidatesCreated,
      notFoundAtCmsCount: summary.notFoundAtCmsCount,
      enumerationTypeMismatchCount: summary.enumerationTypeMismatchCount,
      fetchFailedCount: summary.fetchFailedCount,
    },
  });
}

// ---------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------

type Mutable<T> = { -readonly [P in keyof T]: T[P] };

// ---------------------------------------------------------------------
// Adapter builder: convenience for the slice-5 drain.
// ---------------------------------------------------------------------

/**
 * Translate a thrown error from the command bus into the worker's
 * `DispatchResult` discriminant. Exposed so the slice-5 drain's
 * `dispatchUpdateProvider` / `dispatchDeactivateProvider` adapters
 * — which CALL `executeCommand` and wrap the result — can use the
 * same race-code classification the worker tests pin against.
 *
 * Returns `null` if the error is NOT a recognized race; caller
 * should re-throw in that case.
 */
export function classifyDispatchError(cause: unknown): ProviderRaceCode | null {
  if (cause === null || typeof cause !== "object") return null;
  const c = cause as { code?: unknown };
  if (typeof c.code !== "string") return null;
  return RACE_CODES.has(c.code) ? (c.code as ProviderRaceCode) : null;
}

// `ProviderStatus` is intentionally re-exported so callers in
// `apps/worker` can build `ProviderRowProjection` literals without
// pulling `@pharmax/database` for the enum alone.
export { ProviderStatus };
