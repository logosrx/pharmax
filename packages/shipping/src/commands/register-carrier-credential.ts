// RegisterCarrierCredential — admin "plug in your API key" path.
//
// Activates a new ACTIVE carrier credential for an organization +
// provider pair. If an ACTIVE credential already exists, the prior
// row is automatically DISABLED so the unique partial index
// `(organizationId, provider) WHERE status = ACTIVE` is respected
// and audit history is preserved.
//
// Encryption choke point:
//   - `apiKey` and `webhookSecret` are received as plaintext on the
//     command input. They are NEVER persisted plaintext: the handler
//     calls `encryptField` once per value before insert, with AAD
//     bound to `{tenantId: orgId, table: "carrier_credential",
//      column: "<apiKey|webhookSecret>", recordId: newCredentialId}`.
//   - The bus's `redactFields` declaration scrubs both fields from
//     `command_log.requestPayload` so the replay record carries only
//     metadata (provider, presence-of-webhook-secret, carrierAccountId).
//
// Composite credentials (FedEx, UPS):
//   - Pack the two halves as `"<key>:<secret>"` and pass that string
//     as `apiKey`. The factory splits it back apart at resolve time.
//   - This keeps the encryption surface to a single column and
//     mirrors EasyPost's single-API-key model.
//
// PHI invariant:
//   - API keys are NOT PHI but ARE high-impact secrets. Audit
//     metadata + outbox payload echo only the provider name, the
//     new credential id, and whether a webhook secret is set —
//     never the key material itself.

import { randomUUID } from "node:crypto";

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { encryptField } from "@pharmax/crypto";
import { CarrierCredentialStatus, Prisma, ShippingProvider } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

export const CARRIER_CREDENTIAL_REPLACED_PRIOR = "CARRIER_CREDENTIAL_REPLACED_PRIOR";

const providerSchema = z.enum([
  ShippingProvider.EASYPOST,
  ShippingProvider.FEDEX,
  ShippingProvider.UPS,
]);

const inputSchema = z
  .object({
    provider: providerSchema,
    apiKey: z.string().min(1).max(2000),
    webhookSecret: z.string().min(1).max(2000).optional(),
    carrierAccountId: z.string().min(1).max(128).optional(),
    baseUrl: z.string().url().max(500).optional(),
    notes: z.string().min(1).max(500).optional(),
  })
  .strict();

export type RegisterCarrierCredentialInput = z.infer<typeof inputSchema>;

export interface RegisterCarrierCredentialOutput {
  readonly credentialId: string;
  readonly provider: ShippingProvider;
  readonly replacedCredentialId: string | null;
}

const REDACT_FIELDS = Object.freeze(["apiKey", "webhookSecret"] as const);

export const RegisterCarrierCredential: Command<
  RegisterCarrierCredentialInput,
  RegisterCarrierCredentialOutput
> = {
  name: "RegisterCarrierCredential",
  inputSchema,
  permission: PERMISSIONS.SHIP_MANAGE_CARRIER_CREDENTIALS,
  redactFields: REDACT_FIELDS,

  async handle({
    input,
    ctx,
    tx,
    commandLogId,
  }): Promise<HandlerResult<RegisterCarrierCredentialOutput>> {
    const credentialId = randomUUID();
    const tenantId = ctx.organizationId;

    const apiKeyEnc = (await encryptField({
      plaintext: input.apiKey,
      binding: {
        tenantId,
        table: "carrier_credential",
        column: "apiKey",
        recordId: credentialId,
      },
    })) as unknown as Prisma.InputJsonValue;

    const webhookSecretEnc: Prisma.InputJsonValue | typeof Prisma.JsonNull =
      input.webhookSecret === undefined
        ? Prisma.JsonNull
        : ((await encryptField({
            plaintext: input.webhookSecret,
            binding: {
              tenantId,
              table: "carrier_credential",
              column: "webhookSecret",
              recordId: credentialId,
            },
          })) as unknown as Prisma.InputJsonValue);

    // Disable any prior ACTIVE credential for this (org, provider)
    // pair so the partial unique index `(org, provider) WHERE
    // status = 'ACTIVE'` is respected. The DISABLED row stays for
    // audit/replay traceability — no row deletion.
    const prior = await tx.carrierCredential.findFirst({
      where: {
        organizationId: tenantId,
        provider: input.provider,
        status: CarrierCredentialStatus.ACTIVE,
      },
      select: { id: true },
    });
    if (prior !== null) {
      await tx.carrierCredential.update({
        where: { id: prior.id },
        data: { status: CarrierCredentialStatus.DISABLED },
      });
    }

    try {
      await tx.carrierCredential.create({
        data: {
          id: credentialId,
          organizationId: tenantId,
          provider: input.provider,
          apiKeyEnc,
          webhookSecretEnc,
          carrierAccountId: input.carrierAccountId ?? null,
          baseUrl: input.baseUrl ?? null,
          notes: input.notes ?? null,
          status: CarrierCredentialStatus.ACTIVE,
          createdByUserId: ctx.actor.userId,
          createCommandLogId: commandLogId,
        },
      });
    } catch (cause) {
      if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === "P2002") {
        // Concurrent writer beat us to the unique-active slot. Surface
        // as a conflict; the operator should retry (which will read
        // the now-ACTIVE row and DISABLE it like we tried to).
        throw new errors.ConflictError({
          code: "CARRIER_CREDENTIAL_RACE_LOST",
          message:
            "Another writer registered a credential for this provider concurrently. Retry to replace it.",
          metadata: { provider: input.provider },
          cause,
        });
      }
      throw cause;
    }

    return {
      output: {
        credentialId,
        provider: input.provider,
        replacedCredentialId: prior?.id ?? null,
      },
      audit: {
        action: "shipping.carrier_credential.registered",
        resourceType: "CarrierCredential",
        resourceId: credentialId,
        metadata: {
          provider: input.provider,
          credentialId,
          replacedCredentialId: prior?.id ?? null,
          hasWebhookSecret: input.webhookSecret !== undefined,
          hasCarrierAccountId: input.carrierAccountId !== undefined,
          hasBaseUrl: input.baseUrl !== undefined,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "shipping.carrier_credential.registered.v1",
          aggregateType: "CarrierCredential",
          aggregateId: credentialId,
          payload: {
            organizationId: tenantId,
            credentialId,
            provider: input.provider,
            replacedCredentialId: prior?.id ?? null,
            hasWebhookSecret: input.webhookSecret !== undefined,
          },
        },
      ],
    };
  },
};

export { CARRIER_CREDENTIAL_REPLACED_PRIOR as _CARRIER_CREDENTIAL_REPLACED_PRIOR };
