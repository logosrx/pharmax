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

import type { PrismaClient } from "@pharmax/database";
import {
  type EasyPostWebhookEventRecord,
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
      if (typeof trackingCode !== "string" || trackingCode.length === 0) {
        return null;
      }

      // The Prisma tenancy extension throws on tenant-scoped reads
      // outside a tenancy frame. `withSystemContext` is the explicit
      // bypass that lets the worker drain read across tenants for
      // this single resolution step.
      return withSystemContext("worker-drain:easypost-target-resolve", async () => {
        const shipment = await client.shipment.findFirst({
          where: { trackingNumber: trackingCode },
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
