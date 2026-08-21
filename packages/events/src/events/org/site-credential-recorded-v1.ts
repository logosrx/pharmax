// org.site_credential.recorded.v1 — the tenant pharmacy recorded one of
// its own regulatory credentials.
//
// Producer: `RecordSiteCredential` (`@pharmax/orgs`).
// Consumers: compliance reporting and the credential-expiry warning
//   drain. A lapsed resident licence is the single fact most likely to
//   stop a pharmacy dispensing lawfully, and nothing was watching it
//   before this model existed.
//
// Go-live G-1. Pharmax is a software vendor and holds none of these
// itself; it records and enforces against the customer's.
//
// The identifier IS carried. A pharmacy licence number, NPI, NCPDP and
// NABP identifier are all published in public registries. The site's
// own DEA registration number is the one member of this set that is
// not — see the command, which keeps it out of the payload.
//
// PHI: none.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const KINDS = ["STATE_PHARMACY_LICENSE", "DEA_REGISTRATION", "NPI", "NCPDP", "NABP"] as const;

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    credentialId: z.uuid(),
    siteId: z.uuid(),
    kind: z.enum(KINDS),
    /** Required for STATE_PHARMACY_LICENSE; null otherwise. */
    state: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .nullable(),
    /**
     * The credential number, EXCEPT for DEA_REGISTRATION where it is
     * null: the site's DEA registration is not public and belongs in
     * the outbox no more than a prescriber's does.
     */
    identifier: z.string().min(1).max(64).nullable(),
    /** Null when no expiry was recorded — a gap, not a lapse. */
    expiresAt: z.iso.date().nullable(),
    renewed: z.boolean(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrgSiteCredentialRecordedV1 = defineEvent({
  name: "org.site_credential.recorded",
  version: 1,
  aggregateType: "SiteCredential",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.credentialId,
  owner: "orgs",
  retention: "7y",
  phiSafe: true,
  routingKey: "tenant.provisioning",
  description:
    "Emitted when a pharmacy site's own regulatory credential is recorded or renewed (go-live G-1). Carries the identifier for publicly-registered credentials and null for the site's DEA registration, which is not public.",
});

export type OrgSiteCredentialRecordedV1Payload = z.infer<typeof payloadSchema>;
