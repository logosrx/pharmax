// UPS tracking poller — per-tick logic.
//
// Mirrors the FedEx tracking poller. Differences are payload-shape
// only: UPS's Track API v1 is one tracking number per call (no batch
// endpoint), so `UpsClient.trackShipmentBatch` iterates sequentially
// with per-tracking-number error isolation. The poller still groups
// by org so credential decryption + OAuth happen once per org, not
// once per shipment.

import { executeCommand } from "@pharmax/command-bus";
import { CarrierCredentialStatus, ShippingProvider, type PrismaClient } from "@pharmax/database";
import { decryptField } from "@pharmax/crypto";
import {
  isUpsTrackingNumber,
  normalizeUpsStatus,
  RecordShipmentTrackingEvent,
  UpsClient,
  type UpsTrackPackage,
} from "@pharmax/shipping";
import type { logger as loggerContract } from "@pharmax/platform-core";
import { getMeter } from "@pharmax/telemetry";
import { buildTenancyContext, withSystemContext, withTenancyContext } from "@pharmax/tenancy";
import { ulid } from "ulid";

import {
  claimActiveUpsShipments,
  type ActiveUpsShipmentRow,
  type UpsShipmentClaimClient,
} from "./claim-active-ups-shipments.js";

// Meters are defined in the FedEx poller module via a per-module getMeter
// call. We register a separate meter scope here so the dashboard can
// optionally split FedEx-vs-UPS by instrumentation scope if needed,
// but the metric names + the `carrier` label are identical so they
// merge cleanly in Prometheus.
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

const CARRIER_UPS = { carrier: "ups" };

type Logger = loggerContract.Logger;

export interface UpsTrackingPollerDeps {
  readonly client: PrismaClient & UpsShipmentClaimClient;
  readonly logger: Logger;
  readonly actorEmailLocalPart?: string;
  readonly upsFetch?: typeof fetch;
}

export interface UpsTrackingPollerOptions {
  readonly batchSize: number;
  readonly staleThresholdMs: number;
}

export interface UpsTrackingPollerTickResult {
  readonly claimed: number;
  readonly polled: number;
  readonly recorded: number;
  readonly skippedNoCredential: number;
  readonly skippedNoStatus: number;
  readonly failed: number;
}

interface DecryptedUpsCredential {
  readonly credentialId: string;
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly shipperNumber: string;
  readonly baseUrl: string | null;
}

async function decryptUpsCredential(
  client: PrismaClient,
  organizationId: string
): Promise<DecryptedUpsCredential | null> {
  const credential = await client.carrierCredential.findFirst({
    where: {
      organizationId,
      provider: ShippingProvider.UPS,
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
    shipperNumber: credential.carrierAccountId,
    baseUrl: credential.baseUrl,
  });
}

interface PerOrgContext {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly client: UpsClient;
}

async function buildPerOrgContext(input: {
  prisma: PrismaClient;
  organizationId: string;
  actorEmailLocalPart: string;
  upsFetch?: typeof fetch;
}): Promise<PerOrgContext | null> {
  const org = await input.prisma.organization.findUnique({
    where: { id: input.organizationId },
    select: { slug: true },
  });
  if (org === null) {
    return null;
  }

  const credential = await decryptUpsCredential(input.prisma, input.organizationId);
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

  const client = new UpsClient({
    apiKey: credential.apiKey,
    apiSecret: credential.apiSecret,
    shipperNumber: credential.shipperNumber,
    ...(credential.baseUrl !== null ? { baseUrl: credential.baseUrl } : {}),
    ...(input.upsFetch !== undefined ? { fetch: input.upsFetch } : {}),
  });

  return Object.freeze({
    organizationId: input.organizationId,
    actorUserId: actor.id,
    client,
  });
}

/**
 * Pick the most recent activity timestamp from a UPS package payload.
 * UPS exposes date as `YYYYMMDD` and time as `HHMMSS` (24h); we
 * concatenate them into an ISO-8601 string. Returns null when no
 * activity is reported (uncommon — UPS always emits at least the
 * manifest/origin scan).
 */
function pickOccurredAt(pkg: UpsTrackPackage): Date | null {
  const latest = pkg.activity?.[0];
  if (latest === undefined) {
    return null;
  }
  const date = latest.date;
  const time = latest.time;
  if (typeof date !== "string" || date.length !== 8) {
    return null;
  }
  const year = date.slice(0, 4);
  const month = date.slice(4, 6);
  const day = date.slice(6, 8);
  const hh = typeof time === "string" && time.length >= 2 ? time.slice(0, 2) : "00";
  const mm = typeof time === "string" && time.length >= 4 ? time.slice(2, 4) : "00";
  const ss = typeof time === "string" && time.length >= 6 ? time.slice(4, 6) : "00";
  // UPS does not surface a timezone; treat as UTC. The downstream
  // RecordShipmentTrackingEvent comparison is "strictly newer", so
  // a few-hours skew is fine — the stable externalEventId is what
  // dedupes the row, not the exact timestamp.
  const iso = `${year}-${month}-${day}T${hh}:${mm}:${ss}Z`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function deriveExternalEventId(input: {
  trackingNumber: string;
  statusType: string;
  occurredAt: Date;
}): string {
  return `ups:${input.trackingNumber}:${input.statusType}:${input.occurredAt.toISOString()}`;
}

export function createUpsTrackingPoller(
  deps: UpsTrackingPollerDeps,
  options: UpsTrackingPollerOptions
): { tick: () => Promise<UpsTrackingPollerTickResult> } {
  const log = deps.logger.child({ component: "ups-tracking-poller" });
  const actorEmailLocalPart = deps.actorEmailLocalPart ?? "shipping-webhook";

  return {
    async tick(): Promise<UpsTrackingPollerTickResult> {
      const tally = {
        claimed: 0,
        polled: 0,
        recorded: 0,
        skippedNoCredential: 0,
        skippedNoStatus: 0,
        failed: 0,
      };

      // Step 1 — cross-tenant read of candidates.
      const candidates = await withSystemContext("worker-drain:ups-tracking-claim", async () =>
        claimActiveUpsShipments(deps.client, options)
      );
      tally.claimed = candidates.length;

      if (candidates.length === 0) {
        log.debug("drain.idle");
        return tally;
      }
      log.info("drain.claimed", { count: candidates.length });

      // Step 2 — group by org.
      const byOrg = new Map<string, ActiveUpsShipmentRow[]>();
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
          ctx = await withSystemContext("worker-drain:ups-tracking-credential", async () =>
            buildPerOrgContext({
              prisma: deps.client,
              organizationId,
              actorEmailLocalPart,
              ...(deps.upsFetch !== undefined ? { upsFetch: deps.upsFetch } : {}),
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

        const eligible = shipments.filter((s) => isUpsTrackingNumber(s.trackingNumber));
        if (eligible.length < shipments.length) {
          log.warn("drain.tracking_number.shape_mismatch", {
            organizationId,
            dropped: shipments.length - eligible.length,
          });
        }

        // Step 3 — sequential per-tracking-number poll (UPS Track v1
        // has no batch endpoint). Per-tracking-number errors are
        // already isolated inside trackShipmentBatch.
        const shipmentByTracking = new Map(eligible.map((s) => [s.trackingNumber, s] as const));
        const trackingNumbers = eligible.map((s) => s.trackingNumber);
        const pollStartNs = process.hrtime.bigint();
        let batch;
        try {
          batch = await ctx.client.trackShipmentBatch(trackingNumbers);
          shippingTrackingPollDurationHistogram.record(
            Number(process.hrtime.bigint() - pollStartNs) / 1_000_000_000,
            CARRIER_UPS
          );
        } catch (cause) {
          shippingTrackingPollDurationHistogram.record(
            Number(process.hrtime.bigint() - pollStartNs) / 1_000_000_000,
            CARRIER_UPS
          );
          shippingTrackingPollFailuresCounter.add(1, CARRIER_UPS);
          throw cause;
        }

        // Step 4 — per-result dispatch inside the org's tenancy.
        for (const entry of batch.results) {
          const shipment = shipmentByTracking.get(entry.trackingNumber);
          if (shipment === undefined) {
            log.warn("drain.track.unmatched_result", {
              organizationId,
              trackingNumber: entry.trackingNumber,
            });
            continue;
          }
          if (entry.error !== null) {
            tally.failed += 1;
            log.error("drain.track.per_tracking_failed", {
              organizationId,
              trackingNumber: entry.trackingNumber,
              providerErrorCode: entry.error.providerErrorCode,
              httpStatus: entry.error.httpStatus,
            });
            continue;
          }

          const pkg = entry.package;
          const statusType = pkg?.currentStatus?.type;
          if (pkg === null || typeof statusType !== "string" || statusType.length === 0) {
            tally.skippedNoStatus += 1;
            continue;
          }
          const occurredAt = pickOccurredAt(pkg) ?? new Date();
          const kind = normalizeUpsStatus(statusType);
          const externalEventId = deriveExternalEventId({
            trackingNumber: entry.trackingNumber,
            statusType,
            occurredAt,
          });
          const signatureVerifiedAt = new Date();

          const tenancy = buildTenancyContext({
            organizationId: ctx.organizationId,
            actor: { userId: ctx.actorUserId, correlationId: ulid() },
          });

          tally.polled += 1;
          try {
            await withTenancyContext(tenancy, async () => {
              await executeCommand(
                RecordShipmentTrackingEvent,
                {
                  shipmentId: shipment.id,
                  source: "UPS",
                  externalEventId,
                  kind,
                  carrierStatus: statusType,
                  ...(typeof pkg.currentStatus?.description === "string"
                    ? { carrierStatusDetail: pkg.currentStatus.description }
                    : {}),
                  occurredAt: occurredAt.toISOString(),
                  signatureVerifiedAt: signatureVerifiedAt.toISOString(),
                  rawPayload: pkg as unknown as Record<string, unknown>,
                },
                { idempotencyKey: `ups-poll:${externalEventId}` }
              );
            });
            tally.recorded += 1;
            shippingTrackingEventsRecordedCounter.add(1, CARRIER_UPS);
          } catch (cause) {
            const code = (cause as { code?: string } | undefined)?.code;
            if (
              code === "COMMAND_IDEMPOTENCY_PAYLOAD_MISMATCH" ||
              code === "SHIPMENT_TRACKING_DUPLICATE_EVENT"
            ) {
              tally.recorded += 1;
              shippingTrackingEventsRecordedCounter.add(1, CARRIER_UPS);
            } else {
              tally.failed += 1;
              log.error("drain.track.dispatch_failed", {
                organizationId,
                shipmentId: shipment.id,
                trackingNumber: entry.trackingNumber,
                errorMessage: cause instanceof Error ? cause.message : "unknown",
              });
            }
          }
        }
      }

      log.info("drain.tick.complete", tally);
      return tally;
    },
  };
}
