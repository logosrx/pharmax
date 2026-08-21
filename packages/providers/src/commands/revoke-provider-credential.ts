// RevokeProviderCredential — withdraw a prescriber's DEA registration
// or state licence.
//
// ONE COMMAND FOR BOTH KINDS, discriminated by `credentialKind`. The
// alternative — a command per model — would duplicate the reason-code
// discipline, the audit shape and the guard sequence three times over,
// and the thing being expressed is identical in both cases: authority
// this prescriber had yesterday, they do not have today.
//
// SUSPENDED IS A SEPARATE TARGET FROM REVOKED, not a softer synonym.
// Both block prescribing identically, so the distinction earns its
// keep only in the record — and that is exactly where it matters. A
// board suspension pending a hearing and a permanent revocation
// produce very different answers to "may we reinstate this", and a
// reviewer six months later has nothing but this field to tell them
// apart.
//
// The row is transitioned, never deleted. "Was this prescriber
// authorized on the day they wrote this prescription" has to stay
// answerable for the life of the prescription record, and the tables
// grant no DELETE to either database role.
//
// PHI: none. `reason` describes a professional credential and must not
// describe a patient — reviewer-enforced, length-capped here.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { CredentialStatus } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

export const REVOKE_CREDENTIAL_NOT_FOUND = "REVOKE_CREDENTIAL_NOT_FOUND";
export const REVOKE_CREDENTIAL_ALREADY_INACTIVE = "REVOKE_CREDENTIAL_ALREADY_INACTIVE";

export const PROVIDER_CREDENTIAL_KINDS = ["DEA_REGISTRATION", "STATE_LICENSE"] as const;
export type ProviderCredentialKind = (typeof PROVIDER_CREDENTIAL_KINDS)[number];

const inputSchema = z
  .object({
    credentialKind: z.enum(PROVIDER_CREDENTIAL_KINDS),
    credentialId: z.uuid(),
    /** REVOKED is terminal; SUSPENDED is expected to return. */
    toStatus: z.enum([CredentialStatus.REVOKED, CredentialStatus.SUSPENDED]),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export type RevokeProviderCredentialInput = z.infer<typeof inputSchema>;

export interface RevokeProviderCredentialOutput {
  readonly credentialId: string;
  readonly credentialKind: ProviderCredentialKind;
  readonly providerId: string;
  readonly toStatus: CredentialStatus;
}

export const RevokeProviderCredential: Command<
  RevokeProviderCredentialInput,
  RevokeProviderCredentialOutput
> = {
  name: "RevokeProviderCredential",
  inputSchema,
  permission: PERMISSIONS.PROVIDERS_CREDENTIALS_MANAGE,
  redactFields: [],

  async handle({
    input,
    ctx,
    tx,
    clock,
    commandLogId,
  }): Promise<HandlerResult<RevokeProviderCredentialOutput>> {
    const isDea = input.credentialKind === "DEA_REGISTRATION";

    // Two shapes, one decision. Loaded separately because the models
    // differ in what they carry (a licence has a state, a registration
    // has schedules) but converge on the fields this command needs.
    const credential = isDea
      ? await tx.providerDeaRegistration.findFirst({
          where: { id: input.credentialId, organizationId: ctx.organizationId },
          select: {
            id: true,
            status: true,
            provider: { select: { id: true, npi: true } },
          },
        })
      : await tx.providerStateLicense.findFirst({
          where: { id: input.credentialId, organizationId: ctx.organizationId },
          select: {
            id: true,
            status: true,
            state: true,
            provider: { select: { id: true, npi: true } },
          },
        });

    if (credential === null) {
      throw new errors.NotFoundError({
        code: REVOKE_CREDENTIAL_NOT_FOUND,
        message: "Credential not found in this organization.",
        metadata: { credentialId: input.credentialId, credentialKind: input.credentialKind },
      });
    }
    if (credential.status !== CredentialStatus.ACTIVE) {
      // Surfaced rather than silently re-applied: an operator who
      // believes they just revoked something already revoked has a
      // different picture from reality, and re-stamping the row would
      // overwrite the original reason with the new one.
      throw new errors.ValidationError({
        code: REVOKE_CREDENTIAL_ALREADY_INACTIVE,
        message: `This credential is already ${credential.status}.`,
        metadata: { credentialId: credential.id, status: credential.status },
      });
    }

    const now = clock.now();

    if (isDea) {
      await tx.providerDeaRegistration.update({
        where: { id: credential.id },
        data: { status: input.toStatus },
      });
    } else {
      await tx.providerStateLicense.update({
        where: { id: credential.id },
        data: { status: input.toStatus },
      });
    }

    const state = "state" in credential ? credential.state : null;

    return {
      output: Object.freeze({
        credentialId: credential.id,
        credentialKind: input.credentialKind,
        providerId: credential.provider.id,
        toStatus: input.toStatus,
      }),
      audit: {
        action: "provider.credential.revoked",
        resourceType: isDea ? "ProviderDeaRegistration" : "ProviderStateLicense",
        resourceId: credential.id,
        metadata: {
          credentialKind: input.credentialKind,
          providerId: credential.provider.id,
          npi: credential.provider.npi,
          state,
          toStatus: input.toStatus,
          reason: input.reason,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "provider.credential.revoked.v1",
          aggregateType: "Provider",
          aggregateId: credential.provider.id,
          payload: {
            organizationId: ctx.organizationId,
            credentialId: credential.id,
            credentialKind: input.credentialKind,
            providerId: credential.provider.id,
            npi: credential.provider.npi,
            state,
            toStatus: input.toStatus,
            reason: input.reason,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
