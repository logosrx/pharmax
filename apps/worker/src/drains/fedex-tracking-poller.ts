// FedEx tracking poller — per-tick logic.
//
// FedEx (unlike EasyPost) does not push tracking events to a webhook
// by default; the production pattern is a polling worker that hits
// the Track API on a schedule. Each tick:
//
//   1. Claim up to `batchSize` FedEx shipments due for a poll (read
//      across orgs in system context — same legitimate bridge as the
//      EasyPost drain, see eslint Override 3b).
//   2. Group by `organizationId` and, per group, enter that org's
//      tenancy + resolve the FedEx `ShippingAdapter` via the
//      per-tenant `carrier_credential` row.
//   3. Build a `FedExClient` from the adapter and call
//      `trackShipmentBatch` with up to 30 tracking numbers per
//      request (the FedEx Track API hard cap).
//   4. For each returned `trackResult`, ingest the FULL
//      `scanEvents[]` history — every scan (departed facility,
//      arrived hub, out for delivery, ...) becomes one
//      `RecordShipmentTrackingEvent` dispatch with `source =
//      "FEDEX"`, a synthetic per-scan `externalEventId`
//      (`fedex:{trackingNumber}:scan:{eventType}:{date}`), and the
//      scan's city/state/country location. Scans are dispatched
//      oldest-first so the shipment's cached status lands on the
//      newest scan. When a result carries no scans at all we fall
//      back to a single event from `latestStatusDetail`. The
//      command's row-level unique constraint `(organizationId,
//      source, externalEventId)` makes repeated polls a no-op; a
//      per-org pre-query of already-recorded event ids avoids
//      re-dispatching the whole scan history on every tick.
//
// The carrier's current delivery estimate (`dateAndTimes` entry of
// type `ESTIMATED_DELIVERY`) rides along on the newest dispatched
// event and refreshes `shipment.estimatedDeliveryAt`.
//
// Per-shipment failures are isolated — a bad tracking result for
// one shipment does not abort the rest of the tick. Per-org failures
// (credential missing, OAuth failure) are isolated likewise. The
// drainer returns a tick result with succeeded / skipped / failed
// counts for log lines and future metrics.
//
// Adapter handle: `resolveShippingAdapter` returns a `ShippingAdapter`
// whose runtime type we know to be `FedExShippingAdapter` (because we
// asked the registry for `FEDEX`). To call `trackShipmentBatch` we
// need the underlying `FedExClient` — the factory wires the client
// into the adapter, but the `ShippingAdapter` interface only exposes
// `purchaseLabel` / `cancelLabel`. To avoid leaking adapter internals
// across the boundary, the poller builds its own `FedExClient`
// directly from the resolved `CarrierCredentialContext` — which is
// the actual transport for the tracking call.

import { executeCommand } from "@pharmax/command-bus";
import {
  CarrierCredentialStatus,
  ShipmentTrackingSource,
  ShippingProvider,
} from "@pharmax/database";
import { decryptField } from "@pharmax/crypto";
import type { PrismaClient } from "@pharmax/database";
import {
  FedExClient,
  isFedExTrackingNumber,
  normalizeFedExTrackResult,
  pickEstimatedDeliveryAt,
  RecordShipmentTrackingEvent,
  type FedExTrackResponse,
} from "@pharmax/shipping";
import type { logger as loggerContract } from "@pharmax/platform-core";
import { getMeter } from "@pharmax/telemetry";
import { buildTenancyContext, withSystemContext, withTenancyContext } from "@pharmax/tenancy";
import { ulid } from "ulid";

import {
  claimActiveFedExShipments,
  type ActiveFedExShipmentRow,
  type FedExShipmentClaimClient,
} from "./claim-active-fedex-shipments.js";

const meter = getMeter("@pharmax/worker.shipping");

const shippingTrackingPollDurationHistogram = meter.createHistogram(
  "pharmax_shipping_tracking_poll_duration_seconds",
  {
    description: "Wall-clock time to poll a carrier tracking endpoint for one batch of shipments.",
    unit: "s",
    advice: { explicitBucketBoundaries: [0.1, 0.5, 1, 2.5, 5, 10, 30] },
  }
);

const shippingTrackingPollFailuresCounter = meter.createCounter(
  "pharmax_shipping_tracking_poll_failures_total",
  { description: "Carrier tracking poll attempts that threw (network, auth, parse, 5xx)." }
);

const shippingTrackingEventsRecordedCounter = meter.createCounter(
  "pharmax_shipping_tracking_events_recorded_total",
  {
    description:
      "Tracking events successfully recorded into the shipment_tracking_event ledger. Includes idempotent re-records.",
  }
);

const CARRIER_FEDEX = { carrier: "fedex" };

type Logger = loggerContract.Logger;

const FEDEX_BATCH_SIZE = 30;

export interface FedExTrackingPollerDeps {
  readonly client: PrismaClient & FedExShipmentClaimClient;
  readonly logger: Logger;
  /**
   * Per-org service-user email used to enter tenancy for the
   * `RecordShipmentTrackingEvent` dispatch. Defaults to
   * `shipping-webhook@<org-slug>.test` — matches the seed convention
   * the EasyPost drain already uses.
   */
  readonly actorEmailLocalPart?: string;
  /**
   * Override for FedEx HTTP transport (tests inject a stub fetch).
   * Production leaves this undefined → `globalThis.fetch`.
   */
  readonly fedexFetch?: typeof fetch;
}

export interface FedExTrackingPollerOptions {
  readonly batchSize: number;
  readonly staleThresholdMs: number;
  /** See `ClaimActiveFedExShipmentsOptions.maxShipmentAgeDays`. */
  readonly maxShipmentAgeDays: number;
}

export interface FedExTrackingPollerTickResult {
  readonly claimed: number;
  readonly polled: number;
  readonly recorded: number;
  readonly skippedNoCredential: number;
  readonly skippedNoStatus: number;
  readonly failed: number;
}

interface DecryptedFedExCredential {
  readonly credentialId: string;
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly accountNumber: string;
  readonly baseUrl: string | null;
}

/**
 * Decrypt the org's FedEx credential and split the colon-packed
 * API key. Returns null when no ACTIVE credential exists (caller
 * skips the whole org) or when the packed key is malformed.
 */
async function decryptFedExCredential(
  client: PrismaClient,
  organizationId: string
): Promise<DecryptedFedExCredential | null> {
  const credential = await client.carrierCredential.findFirst({
    where: {
      organizationId,
      provider: ShippingProvider.FEDEX,
      status: CarrierCredentialStatus.ACTIVE,
    },
    select: { id: true, apiKeyEnc: true, carrierAccountId: true, baseUrl: true },
  });
  if (credential === null) {
    return null;
  }

  const packed = await decryptField({
    envelope: credential.apiKeyEnc,
    binding: {
      tenantId: organizationId,
      table: "carrier_credential",
      column: "apiKey",
      recordId: credential.id,
    },
  });

  const colonIdx = packed.indexOf(":");
  if (colonIdx <= 0 || colonIdx === packed.length - 1) {
    return null;
  }
  if (credential.carrierAccountId === null || credential.carrierAccountId.length === 0) {
    return null;
  }

  return Object.freeze({
    credentialId: credential.id,
    apiKey: packed.slice(0, colonIdx),
    apiSecret: packed.slice(colonIdx + 1),
    accountNumber: credential.carrierAccountId,
    baseUrl: credential.baseUrl,
  });
}

interface PerOrgContext {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly client: FedExClient;
}

async function buildPerOrgContext(input: {
  prisma: PrismaClient;
  organizationId: string;
  actorEmailLocalPart: string;
  fedexFetch?: typeof fetch;
}): Promise<PerOrgContext | null> {
  const org = await input.prisma.organization.findUnique({
    where: { id: input.organizationId },
    select: { slug: true },
  });
  if (org === null) {
    return null;
  }

  const credential = await decryptFedExCredential(input.prisma, input.organizationId);
  if (credential === null) {
    return null;
  }

  const actor = await input.prisma.user.findFirst({
    where: {
      organizationId: input.organizationId,
      email: `${input.actorEmailLocalPart}@${org.slug}.test`,
    },
    select: { id: true },
  });
  if (actor === null) {
    return null;
  }

  const client = new FedExClient({
    apiKey: credential.apiKey,
    apiSecret: credential.apiSecret,
    accountNumber: credential.accountNumber,
    ...(credential.baseUrl !== null ? { baseUrl: credential.baseUrl } : {}),
    ...(input.fedexFetch !== undefined ? { fetch: input.fedexFetch } : {}),
  });

  return Object.freeze({
    organizationId: input.organizationId,
    actorUserId: actor.id,
    client,
  });
}

// Normalization (scan extraction, externalEventId derivation, status
// mapping, occurredAt/estimate typing) lives in `@pharmax/shipping`
// (`fedex-track-normalization.ts`) and is SHARED with the AIV webhook
// pipeline — both channels must derive identical externalEventIds so
// a webhook push and a poll of the same physical scan deduplicate at
// the unique-constraint layer.

export function createFedExTrackingPoller(
  deps: FedExTrackingPollerDeps,
  options: FedExTrackingPollerOptions
): { tick: () => Promise<FedExTrackingPollerTickResult> } {
  const log = deps.logger.child({ component: "fedex-tracking-poller" });
  const actorEmailLocalPart = deps.actorEmailLocalPart ?? "shipping-webhook";

  return {
    async tick(): Promise<FedExTrackingPollerTickResult> {
      const tally = {
        claimed: 0,
        polled: 0,
        recorded: 0,
        skippedNoCredential: 0,
        skippedNoStatus: 0,
        failed: 0,
      };

      // Step 1 — cross-tenant read of candidates.
      const candidates = await withSystemContext("worker-drain:fedex-tracking-claim", async () =>
        claimActiveFedExShipments(deps.client, options)
      );
      tally.claimed = candidates.length;

      if (candidates.length === 0) {
        log.debug("drain.idle");
        return tally;
      }
      log.info("drain.claimed", { count: candidates.length });

      // Step 2 — group by org.
      const byOrg = new Map<string, ActiveFedExShipmentRow[]>();
      for (const row of candidates) {
        const list = byOrg.get(row.organizationId);
        if (list === undefined) {
          byOrg.set(row.organizationId, [row]);
        } else {
          list.push(row);
        }
      }

      for (const [organizationId, shipments] of byOrg) {
        let ctx: PerOrgContext | null;
        try {
          ctx = await withSystemContext("worker-drain:fedex-tracking-credential", async () =>
            buildPerOrgContext({
              prisma: deps.client,
              organizationId,
              actorEmailLocalPart,
              ...(deps.fedexFetch !== undefined ? { fedexFetch: deps.fedexFetch } : {}),
            })
          );
        } catch (cause) {
          tally.skippedNoCredential += shipments.length;
          log.error("drain.credential.resolve_failed", {
            organizationId,
            errorMessage: cause instanceof Error ? cause.message : "unknown",
          });
          continue;
        }
        if (ctx === null) {
          tally.skippedNoCredential += shipments.length;
          log.warn("drain.credential.missing", { organizationId, count: shipments.length });
          continue;
        }

        // Step 3 — batch-poll FedEx in 30-per-call chunks.
        const eligible = shipments.filter((s) => isFedExTrackingNumber(s.trackingNumber));
        if (eligible.length < shipments.length) {
          log.warn("drain.tracking_number.shape_mismatch", {
            organizationId,
            dropped: shipments.length - eligible.length,
          });
        }
        const shipmentByTracking = new Map(eligible.map((s) => [s.trackingNumber, s] as const));

        let response: FedExTrackResponse;
        const pollStartNs = process.hrtime.bigint();
        try {
          response = await ctx.client.trackShipmentBatch(
            eligible.map((s) => s.trackingNumber).slice(0, FEDEX_BATCH_SIZE * 5)
          );
          shippingTrackingPollDurationHistogram.record(
            Number(process.hrtime.bigint() - pollStartNs) / 1_000_000_000,
            CARRIER_FEDEX
          );
        } catch (cause) {
          shippingTrackingPollDurationHistogram.record(
            Number(process.hrtime.bigint() - pollStartNs) / 1_000_000_000,
            CARRIER_FEDEX
          );
          shippingTrackingPollFailuresCounter.add(1, CARRIER_FEDEX);
          tally.failed += eligible.length;
          log.error("drain.track.batch_failed", {
            organizationId,
            count: eligible.length,
            errorMessage: cause instanceof Error ? cause.message : "unknown",
          });
          continue;
        }

        // Step 4 — pre-query already-recorded event ids for this
        // org's claimed shipments so a steady-state tick does not
        // re-dispatch the entire scan history of every shipment
        // (each dispatch is a full command execution). The unique
        // constraint remains the correctness layer; this is purely
        // a load optimization, so a failure here degrades to
        // constraint-layer dedupe rather than aborting the org.
        let recordedEventIds: ReadonlySet<string>;
        try {
          const rows = await withSystemContext("worker-drain:fedex-tracking-dedupe", async () =>
            deps.client.shipmentTrackingEvent.findMany({
              where: {
                organizationId,
                source: ShipmentTrackingSource.FEDEX,
                shipmentId: { in: eligible.map((s) => s.id) },
              },
              select: { externalEventId: true },
            })
          );
          recordedEventIds = new Set(rows.map((r) => r.externalEventId));
        } catch (cause) {
          recordedEventIds = new Set();
          log.warn("drain.track.dedupe_query_failed", {
            organizationId,
            errorMessage: cause instanceof Error ? cause.message : "unknown",
          });
        }

        // Step 5 — per-result dispatch inside the org's tenancy.
        // Every scan in the result's history becomes one event row;
        // oldest-first so the cached status ends on the newest scan.
        for (const ctr of response.output.completeTrackResults) {
          const trackingNumber = ctr.trackingNumber ?? "";
          const shipment = shipmentByTracking.get(trackingNumber);
          if (shipment === undefined) {
            log.warn("drain.track.unmatched_result", { organizationId, trackingNumber });
            continue;
          }

          const trackResult = ctr.trackResults?.[0];
          if (trackResult === undefined || trackResult.error !== undefined) {
            tally.skippedNoStatus += 1;
            continue;
          }

          const events = normalizeFedExTrackResult({ trackingNumber, trackResult });
          if (events.length === 0) {
            tally.skippedNoStatus += 1;
            continue;
          }

          const newEvents = events.filter((e) => !recordedEventIds.has(e.externalEventId));
          tally.polled += 1;
          if (newEvents.length === 0) {
            // Fully up to date — nothing new since the last tick.
            continue;
          }

          const estimatedDeliveryAt = pickEstimatedDeliveryAt(trackResult);
          const newestEventId = newEvents[newEvents.length - 1]?.externalEventId;
          const signatureVerifiedAt = new Date();

          for (const event of newEvents) {
            const tenancy = buildTenancyContext({
              organizationId: ctx.organizationId,
              actor: { userId: ctx.actorUserId, correlationId: ulid() },
            });

            try {
              await withTenancyContext(tenancy, async () => {
                await executeCommand(
                  RecordShipmentTrackingEvent,
                  {
                    shipmentId: shipment.id,
                    source: "FEDEX",
                    externalEventId: event.externalEventId,
                    kind: event.kind,
                    carrierStatus: event.carrierStatus,
                    ...(event.carrierStatusDetail !== null
                      ? { carrierStatusDetail: event.carrierStatusDetail }
                      : {}),
                    occurredAt: event.occurredAt.toISOString(),
                    signatureVerifiedAt: signatureVerifiedAt.toISOString(),
                    ...(event.scanCity !== null ? { scanCity: event.scanCity } : {}),
                    ...(event.scanStateOrProvince !== null
                      ? { scanStateOrProvince: event.scanStateOrProvince }
                      : {}),
                    ...(event.scanCountry !== null ? { scanCountry: event.scanCountry } : {}),
                    // The delivery estimate is a property of the
                    // track result, not of any single scan — attach
                    // it to the newest event only so the cached
                    // `shipment.estimatedDeliveryAt` refreshes once
                    // per poll.
                    ...(estimatedDeliveryAt !== null && event.externalEventId === newestEventId
                      ? { estimatedDeliveryAt: estimatedDeliveryAt.toISOString() }
                      : {}),
                    // Persist the raw scan (or full trackResult for
                    // the fallback) — useful for audit + future
                    // re-projection.
                    rawPayload: event.rawPayload,
                  },
                  { idempotencyKey: `fedex-poll:${event.externalEventId}` }
                );
              });
              tally.recorded += 1;
              shippingTrackingEventsRecordedCounter.add(1, CARRIER_FEDEX);
            } catch (cause) {
              // Already-recorded duplicate is the most common "failure"
              // and that's the whole point of the unique-constraint
              // idempotency. Surface as `recorded` (the event reached
              // its terminal state) rather than `failed`, but only when
              // the bus reports the bus-layer idempotency conflict.
              const code = (cause as { code?: string } | undefined)?.code;
              if (
                code === "COMMAND_IDEMPOTENCY_PAYLOAD_MISMATCH" ||
                code === "SHIPMENT_TRACKING_DUPLICATE_EVENT"
              ) {
                tally.recorded += 1;
                shippingTrackingEventsRecordedCounter.add(1, CARRIER_FEDEX);
              } else {
                tally.failed += 1;
                log.error("drain.track.dispatch_failed", {
                  organizationId,
                  shipmentId: shipment.id,
                  trackingNumber,
                  errorMessage: cause instanceof Error ? cause.message : "unknown",
                });
              }
            }
          }
        }
      }

      log.info("drain.tick.complete", tally);
      return tally;
    },
  };
}
