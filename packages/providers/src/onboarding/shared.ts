// Shared pieces of the provider-onboarding command family
// (ADR-0033): the pinned policy coordinates, common error codes,
// and the approval-time roster-row creation both approval paths
// (automated proofing PASS, human review) share.

import { randomUUID } from "node:crypto";

import type { OutboxEventDraft } from "@pharmax/command-bus";
import type { Prisma, WorkflowPolicyStatus } from "@pharmax/database";
import { ProviderStatus } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";

/** The first non-order workflow policy (ADR-0033). */
export const PROVIDER_ONBOARDING_POLICY_CODE = "provider.onboarding";
export const PROVIDER_ONBOARDING_POLICY_VERSION = 1;

export const PROVIDER_ONBOARDING_POLICY_NOT_FOUND = "PROVIDER_ONBOARDING_POLICY_NOT_FOUND";
export const PROVIDER_ONBOARDING_APPLICATION_NOT_FOUND =
  "PROVIDER_ONBOARDING_APPLICATION_NOT_FOUND";
export const PROVIDER_ONBOARDING_INVALID_STATE = "PROVIDER_ONBOARDING_INVALID_STATE";
export const PROVIDER_ONBOARDING_ALREADY_OPEN = "PROVIDER_ONBOARDING_ALREADY_OPEN";
export const PROVIDER_ONBOARDING_NPI_ALREADY_REGISTERED =
  "PROVIDER_ONBOARDING_NPI_ALREADY_REGISTERED";

/** Prisma surface the onboarding commands read/write. */
export interface OnboardingPolicyRow {
  readonly id: string;
  readonly version: number;
  readonly status: WorkflowPolicyStatus;
}

/**
 * Resolve + pin the ACTIVE `provider.onboarding` policy for this
 * org. Missing or non-ACTIVE policy is a deployment/config error
 * (the seed creates it), surfaced as a typed NotFound so the
 * transport maps it cleanly instead of 500ing.
 */
export async function loadOnboardingPolicy(
  tx: Prisma.TransactionClient,
  organizationId: string
): Promise<OnboardingPolicyRow> {
  const policy = await tx.workflowPolicy.findUnique({
    where: {
      organizationId_code_version: {
        organizationId,
        code: PROVIDER_ONBOARDING_POLICY_CODE,
        version: PROVIDER_ONBOARDING_POLICY_VERSION,
      },
    },
    select: { id: true, version: true, status: true },
  });
  if (policy === null || policy.status !== "ACTIVE") {
    throw new errors.NotFoundError({
      code: PROVIDER_ONBOARDING_POLICY_NOT_FOUND,
      message:
        "The provider.onboarding workflow policy is not active for this organization. Run the seed / provisioning step before accepting applications.",
      metadata: {
        code: PROVIDER_ONBOARDING_POLICY_CODE,
        version: PROVIDER_ONBOARDING_POLICY_VERSION,
      },
    });
  }
  return policy;
}

/** The application fields the roster-row creation needs. */
export interface ApplicationRosterClaim {
  readonly npi: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly credential: string | null;
  readonly email: string;
  readonly phone: string | null;
}

/**
 * Create the `Provider` roster row for an approved application.
 * Same insert semantics as `RegisterProvider` (the applicant's
 * attested claim populates the row; the NPI-sync reconciliation
 * that governs manually-registered providers governs this row from
 * here on). Callers MUST have verified no roster row exists for
 * `(org, npi)` inside the same transaction.
 */
export async function createRosterRowFromApplication(
  tx: Prisma.TransactionClient,
  organizationId: string,
  claim: ApplicationRosterClaim
): Promise<string> {
  const providerId = randomUUID();
  await tx.provider.create({
    data: {
      id: providerId,
      organizationId,
      npi: claim.npi,
      firstName: claim.firstName,
      lastName: claim.lastName,
      ...(claim.credential === null ? {} : { credential: claim.credential }),
      email: claim.email,
      ...(claim.phone === null ? {} : { phone: claim.phone }),
      status: ProviderStatus.ACTIVE,
    },
  });
  return providerId;
}

/**
 * The `provider.registered.v1` outbox draft both approval paths
 * emit alongside their onboarding event — the roster trail and the
 * onboarding trail stay separate streams on purpose.
 */
export function providerRegisteredDraft(input: {
  readonly providerId: string;
  readonly organizationId: string;
  readonly npi: string;
  readonly occurredAt: string;
}): OutboxEventDraft {
  return {
    eventType: "provider.registered.v1",
    aggregateType: "Provider",
    aggregateId: input.providerId,
    payload: {
      providerId: input.providerId,
      organizationId: input.organizationId,
      npi: input.npi,
      occurredAt: input.occurredAt,
    },
  };
}

/**
 * The `provider.portal_account.provisioned.v1` outbox draft both
 * approval paths emit when the portal credential slot is created
 * alongside the roster row (ADR-0033 slice 2). Ids only — the setup
 * token is minted post-commit and never rides an event.
 */
export function portalAccountProvisionedDraft(input: {
  readonly portalAccountId: string;
  readonly organizationId: string;
  readonly providerId: string;
  readonly applicationId: string;
  readonly occurredAt: string;
}): OutboxEventDraft {
  return {
    eventType: "provider.portal_account.provisioned.v1",
    aggregateType: "PortalAccount",
    aggregateId: input.portalAccountId,
    payload: {
      portalAccountId: input.portalAccountId,
      organizationId: input.organizationId,
      providerId: input.providerId,
      applicationId: input.applicationId,
      occurredAt: input.occurredAt,
    },
  };
}
