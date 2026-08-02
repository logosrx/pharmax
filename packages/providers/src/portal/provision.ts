// provisionPortalAccountInTx — create the PENDING_SETUP portal
// credential slot for a freshly approved prescriber (ADR-0033,
// slice 2).
//
// Called INSIDE the approval command's transaction (both paths:
// automated proofing PASS and human review), immediately after the
// roster row is created — approval, roster row, and portal slot are
// atomic. No credential exists yet; the one-time setup token is
// minted post-commit by `IssuePortalSetupToken` so the bearer secret
// never rides the approval command's output.
//
// The (organizationId, email) unique constraint backs portal
// sign-in. If another portal account in the org already uses the
// application email (e.g. a shared office inbox), provisioning is
// SKIPPED rather than failing the approval — the roster row is the
// product-critical outcome; ops can provision a credential manually
// later. Callers surface the skip in audit metadata.

import { randomUUID } from "node:crypto";

import type { Prisma } from "@pharmax/database";

export type ProvisionPortalAccountResult =
  | { readonly provisioned: true; readonly portalAccountId: string }
  | { readonly provisioned: false; readonly reason: "EMAIL_TAKEN" };

export async function provisionPortalAccountInTx(
  tx: Pick<Prisma.TransactionClient, "portalAccount">,
  input: {
    readonly organizationId: string;
    readonly providerId: string;
    readonly applicationId: string;
    readonly email: string;
    readonly now: Date;
  }
): Promise<ProvisionPortalAccountResult> {
  const email = input.email.toLowerCase();

  const emailTaken = await tx.portalAccount.findUnique({
    where: { organizationId_email: { organizationId: input.organizationId, email } },
    select: { id: true },
  });
  if (emailTaken !== null) {
    return { provisioned: false, reason: "EMAIL_TAKEN" };
  }

  const portalAccountId = randomUUID();
  await tx.portalAccount.create({
    data: {
      id: portalAccountId,
      organizationId: input.organizationId,
      providerId: input.providerId,
      applicationId: input.applicationId,
      email,
      // hashedPassword stays NULL; status defaults to PENDING_SETUP.
      createdAt: input.now,
      updatedAt: input.now,
    },
    select: { id: true },
  });

  return { provisioned: true, portalAccountId };
}
