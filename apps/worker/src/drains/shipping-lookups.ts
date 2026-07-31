// Production implementations of `WebhookTargetResolver` for the
// EasyPost webhook drainer.
//
// The resolver bridges from a tenant-less inbound webhook event to
// the per-tenant `(organizationId, shipmentId, actorUserId)` tuple
// the domain command needs. Both reads run in **system context**
// (RLS bypass) because the webhook payload carries no tenant
// identity; this is one of the few legitimate uses of
// `withSystemContext` in application code (see eslint.config.js
// "Override 3b" for the architectural justification).
//
// PHI: neither read decrypts PHI. The shipment row is non-PHI
// (organizationId + tracking number); the actor row is a service-user
// email lookup keyed on `shipping-webhook@<org-slug>.test`.

import { ShipmentCarrier, type PrismaClient } from "@pharmax/database";
import {
  type EasyPostWebhookEventRecord,
  type FedExWebhookTargetResolver,
  type ResolvedWebhookTarget,
  type WebhookTargetResolver,
} from "@pharmax/shipping";
import { withSystemContext } from "@pharmax/tenancy";

export interface CreateEasyPostTargetResolverOptions {
  readonly client: PrismaClient;
  /**
   * Local part of the per-org service-user email
   * (`<emailLocalPart>@<org-slug>.test`). Defaults to
   * `"shipping-webhook"` to match the seed convention.
   */
  readonly emailLocalPart?: string;
}

export function createEasyPostTargetResolver(
  options: CreateEasyPostTargetResolverOptions
): WebhookTargetResolver {
  const { client } = options;
  const emailLocalPart = options.emailLocalPart ?? "shipping-webhook";

  return {
    async resolve(record: EasyPostWebhookEventRecord): Promise<ResolvedWebhookTarget | null> {
      const trackingCode = record.payload.result.tracking_code;
      const externalTrackerId = record.payload.result.id;
      if (typeof trackingCode !== "string" || trackingCode.length === 0) {
        return null;
      }

      // The Prisma tenancy extension throws on tenant-scoped reads
      // outside a tenancy frame. `withSystemContext` is the explicit
      // bypass that lets the worker drain read across tenants for
      // this single resolution step.
      return withSystemContext("worker-drain:easypost-target-resolve", async () => {
        // Resolution order matters for tenant safety:
        //
        //   1. `externalTrackerId` — the EasyPost tracker object id
        //      persisted at purchase time. Unique per EasyPost
        //      object, so it can NEVER match another tenant's
        //      shipment.
        //   2. Tracking-number fallback — only for shipments with no
        //      stored tracker id (manual BYO-tracking shipments).
        //      Carrier tracking numbers get REUSED across time and
        //      accounts; resolving by tracking number alone let a
        //      webhook for one org's shipment update the NEWEST
        //      shipment globally, including another tenant's. The
        //      fallback therefore also requires the shipment to lack
        //      a tracker id (a tracker-linked shipment must match on
        //      its tracker id or not at all).
        const byTrackerId =
          typeof externalTrackerId === "string" && externalTrackerId.length > 0
            ? await client.shipment.findFirst({
                where: { externalTrackerId },
                select: { id: true, organizationId: true },
              })
            : null;
        const shipment =
          byTrackerId ??
          (await client.shipment.findFirst({
            where: { trackingNumber: trackingCode, externalTrackerId: null },
            select: { id: true, organizationId: true },
            orderBy: { createdAt: "desc" },
          }));
        if (shipment === null) {
          return null;
        }
        const org = await client.organization.findUnique({
          where: { id: shipment.organizationId },
          select: { slug: true },
        });
        if (org === null) {
          return null;
        }
        const user = await client.user.findFirst({
          where: {
            organizationId: shipment.organizationId,
            email: `${emailLocalPart}@${org.slug}.test`,
          },
          select: { id: true },
        });
        if (user === null) {
          return null;
        }
        return Object.freeze({
          organizationId: shipment.organizationId,
          shipmentId: shipment.id,
          actorUserId: user.id,
        });
      });
    },
  };
}

export interface CreateFedExTargetResolverOptions {
  readonly client: PrismaClient;
  /** Same service-user convention as the EasyPost resolver. */
  readonly emailLocalPart?: string;
}

/**
 * Resolver for the FedEx AIV webhook drainer. Resolution is by
 * tracking number, narrowed to FedEx-carrier shipments WITHOUT an
 * EasyPost tracker id:
 *
 *   - `carrier = FEDEX` — an AIV push can only describe a FedEx
 *     shipment; the narrow keeps a reused tracking number from
 *     matching another carrier's row.
 *   - `externalTrackerId IS NULL` — shipments purchased through
 *     EasyPost already receive tracking via the EasyPost webhook;
 *     matching them here would double-ingest.
 *   - newest-first, same reuse caveat as the EasyPost
 *     tracking-number fallback (carrier tracking numbers recycle
 *     over time; the newest match is the live one).
 */
export function createFedExTargetResolver(
  options: CreateFedExTargetResolverOptions
): FedExWebhookTargetResolver {
  const { client } = options;
  const emailLocalPart = options.emailLocalPart ?? "shipping-webhook";

  return {
    async resolve(trackingNumber: string): Promise<ResolvedWebhookTarget | null> {
      if (trackingNumber.length === 0) {
        return null;
      }

      return withSystemContext("worker-drain:fedex-webhook-target-resolve", async () => {
        const shipment = await client.shipment.findFirst({
          where: {
            trackingNumber,
            carrier: ShipmentCarrier.FEDEX,
            externalTrackerId: null,
          },
          select: { id: true, organizationId: true },
          orderBy: { createdAt: "desc" },
        });
        if (shipment === null) {
          return null;
        }
        const org = await client.organization.findUnique({
          where: { id: shipment.organizationId },
          select: { slug: true },
        });
        if (org === null) {
          return null;
        }
        const user = await client.user.findFirst({
          where: {
            organizationId: shipment.organizationId,
            email: `${emailLocalPart}@${org.slug}.test`,
          },
          select: { id: true },
        });
        if (user === null) {
          return null;
        }
        return Object.freeze({
          organizationId: shipment.organizationId,
          shipmentId: shipment.id,
          actorUserId: user.id,
        });
      });
    },
  };
}
