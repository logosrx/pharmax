// RecordSiteCredential — record or renew one of the tenant pharmacy's
// own regulatory credentials. Go-live G-1.
//
// WHY THIS EXISTS. Pharmax is a software vendor and a HIPAA Business
// Associate; it holds no pharmacy licence and no DEA registration. Its
// customers hold both, and until this command there was nowhere to put
// them: `PharmacySite` carried name, code, timezone, address and phone
// and no credential field at all. A pharmacy cannot adopt software with
// nowhere to record its licence, because the gap surfaces as the
// customer's inspection finding — which makes it Pharmax's commercial
// problem rather than a nice-to-have.
//
// A STATE LICENCE NAMES A STATE; nothing else here does. The database
// enforces that pairing with a CHECK constraint, and this command
// refuses it earlier so the operator gets a message about the field
// they got wrong rather than a constraint violation.
//
// RENEWAL IS AN UPDATE on `(organizationId, siteId, kind, identifier)`.
// A renewed licence is the same licence with a later date. A licence
// with a genuinely new number is a new row, and the superseded one is
// revoked with a reason.
//
// PHI: none. These are the pharmacy's own registration identifiers.
// The site's DEA registration number is kept out of the outbox payload
// for the same reason a prescriber's is — see the event definition.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import {
  CredentialStatus,
  CredentialVerificationMethod,
  Prisma,
  SiteCredentialKind,
} from "@pharmax/database";
import { errors, geo } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

export const RECORD_SITE_CREDENTIAL_SITE_NOT_FOUND = "RECORD_SITE_CREDENTIAL_SITE_NOT_FOUND";
export const RECORD_SITE_CREDENTIAL_STATE_REQUIRED = "RECORD_SITE_CREDENTIAL_STATE_REQUIRED";
export const RECORD_SITE_CREDENTIAL_STATE_NOT_ALLOWED = "RECORD_SITE_CREDENTIAL_STATE_NOT_ALLOWED";
export const RECORD_SITE_CREDENTIAL_UNKNOWN_STATE = "RECORD_SITE_CREDENTIAL_UNKNOWN_STATE";
export const RECORD_SITE_CREDENTIAL_EXPIRY_BEFORE_ISSUE =
  "RECORD_SITE_CREDENTIAL_EXPIRY_BEFORE_ISSUE";

const inputSchema = z
  .object({
    siteId: z.uuid(),
    kind: z.enum(SiteCredentialKind),
    /** Required for STATE_PHARMACY_LICENSE, forbidden otherwise. */
    state: z.string().length(2).optional(),
    identifier: z.string().trim().min(1).max(64),
    issuedAt: z.iso.date().optional(),
    /** Absent means not recorded. A recorded past date means lapsed. */
    expiresAt: z.iso.date().optional(),
    verificationMethod: z.enum(CredentialVerificationMethod).optional(),
  })
  .strict();

export type RecordSiteCredentialInput = z.infer<typeof inputSchema>;

export interface RecordSiteCredentialOutput {
  readonly credentialId: string;
  readonly siteId: string;
  readonly kind: SiteCredentialKind;
  readonly state: string | null;
  readonly expiresAt: string | null;
  readonly renewed: boolean;
}

export const RecordSiteCredential: Command<RecordSiteCredentialInput, RecordSiteCredentialOutput> =
  {
    name: "RecordSiteCredential",
    inputSchema,
    permission: PERMISSIONS.ORG_SITE_CREDENTIALS_MANAGE,
    // The site's own DEA registration is as sensitive as a prescriber's.
    // It shares the input field with public identifiers, so the whole
    // field is redacted rather than conditionally — a conditional
    // redaction is one refactor away from being wrong.
    redactFields: Object.freeze(["identifier"] as const),

    async handle({
      input,
      ctx,
      tx,
      clock,
      commandLogId,
    }): Promise<HandlerResult<RecordSiteCredentialOutput>> {
      const isStateLicense = input.kind === SiteCredentialKind.STATE_PHARMACY_LICENSE;

      let state: string | null = null;
      if (isStateLicense) {
        if (input.state === undefined) {
          throw new errors.ValidationError({
            code: RECORD_SITE_CREDENTIAL_STATE_REQUIRED,
            message: "A state pharmacy licence must name the state that issued it.",
            issues: [{ path: ["state"], message: "required for STATE_PHARMACY_LICENSE" }],
          });
        }
        state = geo.normalizeJurisdictionCode(input.state);
        if (state === null) {
          throw new errors.ValidationError({
            code: RECORD_SITE_CREDENTIAL_UNKNOWN_STATE,
            message: `"${input.state}" is not a US state or territory code.`,
            issues: [{ path: ["state"], message: "unknown jurisdiction" }],
          });
        }
      } else if (input.state !== undefined) {
        // An NPI or NCPDP identifier with a state attached invites
        // someone to filter on it, and the database CHECK refuses it
        // anyway. Reject with a message about the field.
        throw new errors.ValidationError({
          code: RECORD_SITE_CREDENTIAL_STATE_NOT_ALLOWED,
          message: `A ${input.kind} credential is not state-specific. Remove the state.`,
          issues: [{ path: ["state"], message: `not allowed for ${input.kind}` }],
        });
      }

      const site = await tx.pharmacySite.findFirst({
        where: { id: input.siteId, organizationId: ctx.organizationId },
        select: { id: true, code: true },
      });
      if (site === null) {
        throw new errors.NotFoundError({
          code: RECORD_SITE_CREDENTIAL_SITE_NOT_FOUND,
          message: "Pharmacy site not found in this organization.",
          metadata: { siteId: input.siteId },
        });
      }

      const issuedAt = input.issuedAt === undefined ? null : new Date(input.issuedAt);
      const expiresAt = input.expiresAt === undefined ? null : new Date(input.expiresAt);
      if (issuedAt !== null && expiresAt !== null && expiresAt.getTime() < issuedAt.getTime()) {
        throw new errors.ValidationError({
          code: RECORD_SITE_CREDENTIAL_EXPIRY_BEFORE_ISSUE,
          message: "The expiry date is before the issue date. Check the two dates.",
          issues: [{ path: ["expiresAt"], message: "before issuedAt" }],
        });
      }

      const identifier = input.identifier.trim();
      const existing = await tx.siteCredential.findFirst({
        where: {
          organizationId: ctx.organizationId,
          siteId: site.id,
          kind: input.kind,
          identifier,
        },
        select: { id: true },
      });

      const now = clock.now();
      const verificationMethod = input.verificationMethod ?? CredentialVerificationMethod.ATTESTED;
      const verified = verificationMethod !== CredentialVerificationMethod.ATTESTED;
      const renewed = existing !== null;

      const data = {
        state,
        issuedAt,
        expiresAt,
        status: CredentialStatus.ACTIVE,
        verificationMethod,
        verifiedAt: verified ? now : null,
        verifiedByUserId: verified ? ctx.actor.userId : null,
        recordedByUserId: ctx.actor.userId,
      };

      let credentialId: string;
      if (existing !== null) {
        await tx.siteCredential.update({ where: { id: existing.id }, data });
        credentialId = existing.id;
      } else {
        try {
          const created = await tx.siteCredential.create({
            data: {
              organizationId: ctx.organizationId,
              siteId: site.id,
              kind: input.kind,
              identifier,
              ...data,
            },
            select: { id: true },
          });
          credentialId = created.id;
        } catch (cause) {
          if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === "P2002") {
            throw new errors.ConflictError({
              code: "RECORD_SITE_CREDENTIAL_CONCURRENT",
              message: "This credential was recorded concurrently. Reload the site.",
              metadata: { siteId: site.id, kind: input.kind },
              cause,
            });
          }
          throw cause;
        }
      }

      const expiresAtIso = expiresAt === null ? null : expiresAt.toISOString().slice(0, 10);
      // Public registries publish licence, NPI, NCPDP and NABP numbers.
      // The site's own DEA registration they do not.
      const publishableIdentifier =
        input.kind === SiteCredentialKind.DEA_REGISTRATION ? null : identifier;

      return {
        output: Object.freeze({
          credentialId,
          siteId: site.id,
          kind: input.kind,
          state,
          expiresAt: expiresAtIso,
          renewed,
        }),
        audit: {
          action: "org.site_credential.recorded",
          resourceType: "SiteCredential",
          resourceId: credentialId,
          metadata: {
            siteId: site.id,
            siteCode: site.code,
            kind: input.kind,
            state,
            identifier: publishableIdentifier,
            expiresAt: expiresAtIso,
            hasExpiry: expiresAt !== null,
            verificationMethod,
            renewed,
            commandLogId,
          },
        },
        outboxEvents: [
          {
            eventType: "org.site_credential.recorded.v1",
            aggregateType: "SiteCredential",
            aggregateId: credentialId,
            payload: {
              organizationId: ctx.organizationId,
              credentialId,
              siteId: site.id,
              kind: input.kind,
              state,
              identifier: publishableIdentifier,
              expiresAt: expiresAtIso,
              renewed,
              occurredAt: now.toISOString(),
            },
          },
        ],
      };
    },
  };
