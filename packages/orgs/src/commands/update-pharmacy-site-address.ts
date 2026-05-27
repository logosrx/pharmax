// UpdatePharmacySiteAddress — admin command to populate or change
// the business address on a `pharmacy_site` row.
//
// Why this command exists:
//   - Site address is non-PHI but operationally critical: the
//     carrier auto-purchase flow (PurchaseShipmentLabel) requires
//     a valid ship-from address. Until this address is set, the
//     /ops/shipping page surfaces a "configure site address" hint
//     instead of the auto-purchase button.
//   - Even though the address columns are plaintext, mutations
//     still go through the command bus so we get the standard
//     audit + outbox + idempotency surface — the same pattern as
//     every other admin command (RegisterCarrierCredential, etc.).
//
// Permission: `org.manage_sites` (ORGANIZATION scope; OrgAdmin only
// by default — see role-templates.ts).
//
// PHI invariant: no PHI in inputs or persisted columns. Audit +
// outbox metadata echoes only siteId + the changed-field names
// (NOT the address values themselves, in case operators paste in
// PHI-shaped data by mistake on an unusual deployment).

import type { Command, HandlerResult } from "@pharmax/command-bus";
import type { Prisma } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

export const PHARMACY_SITE_NOT_FOUND = "PHARMACY_SITE_NOT_FOUND";

const inputSchema = z
  .object({
    siteId: z.uuid(),
    addressLine1: z.string().trim().min(1).max(200),
    addressLine2: z.string().trim().min(1).max(200).optional(),
    city: z.string().trim().min(1).max(100),
    state: z.string().trim().min(1).max(80),
    postalCode: z.string().trim().min(1).max(20),
    country: z
      .string()
      .trim()
      .length(2)
      .regex(/^[A-Z]{2}$/, "expected ISO-3166-1 alpha-2 country code"),
    phone: z.string().trim().min(1).max(40).optional(),
  })
  .strict();

export type UpdatePharmacySiteAddressInput = z.infer<typeof inputSchema>;

export interface UpdatePharmacySiteAddressOutput {
  readonly siteId: string;
  readonly fieldsChanged: ReadonlyArray<string>;
}

export const UpdatePharmacySiteAddress: Command<
  UpdatePharmacySiteAddressInput,
  UpdatePharmacySiteAddressOutput
> = {
  name: "UpdatePharmacySiteAddress",
  inputSchema,
  permission: PERMISSIONS.ORG_MANAGE_SITES,
  redactFields: [],

  async handle({
    input,
    ctx,
    tx,
    commandLogId,
  }): Promise<HandlerResult<UpdatePharmacySiteAddressOutput>> {
    const existing = await tx.pharmacySite.findFirst({
      where: { id: input.siteId, organizationId: ctx.organizationId },
      select: {
        id: true,
        addressLine1: true,
        addressLine2: true,
        city: true,
        state: true,
        postalCode: true,
        country: true,
        phone: true,
      },
    });
    if (existing === null) {
      throw new errors.NotFoundError({
        code: PHARMACY_SITE_NOT_FOUND,
        message: "Pharmacy site not found in this organization.",
        metadata: { siteId: input.siteId },
      });
    }

    // Compute the diff so audit metadata captures WHICH fields the
    // operator changed without echoing the address values (defense
    // against accidental PHI paste).
    const fieldsChanged: string[] = [];
    if (existing.addressLine1 !== input.addressLine1) fieldsChanged.push("addressLine1");
    if ((existing.addressLine2 ?? undefined) !== input.addressLine2) {
      fieldsChanged.push("addressLine2");
    }
    if (existing.city !== input.city) fieldsChanged.push("city");
    if (existing.state !== input.state) fieldsChanged.push("state");
    if (existing.postalCode !== input.postalCode) fieldsChanged.push("postalCode");
    if (existing.country !== input.country) fieldsChanged.push("country");
    if ((existing.phone ?? undefined) !== input.phone) fieldsChanged.push("phone");

    await tx.pharmacySite.update({
      where: { id: existing.id },
      data: {
        addressLine1: input.addressLine1,
        addressLine2: input.addressLine2 ?? null,
        city: input.city,
        state: input.state,
        postalCode: input.postalCode,
        country: input.country,
        phone: input.phone ?? null,
      },
    });

    return {
      output: Object.freeze({
        siteId: existing.id,
        fieldsChanged: Object.freeze([...fieldsChanged]),
      }),
      audit: {
        action: "org.site.address_updated",
        resourceType: "PharmacySite",
        resourceId: existing.id,
        metadata: {
          siteId: existing.id,
          fieldsChanged: fieldsChanged satisfies Prisma.InputJsonValue,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "org.site.address_updated.v1",
          aggregateType: "PharmacySite",
          aggregateId: existing.id,
          payload: {
            organizationId: ctx.organizationId,
            siteId: existing.id,
            fieldsChanged: fieldsChanged satisfies Prisma.InputJsonValue,
            occurredAt: new Date().toISOString(),
          },
        },
      ],
    };
  },
};
