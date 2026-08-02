// Public application-status lookup (ADR-0033, slice 2).
//
// The application id (a v4 UUID returned only in the submit response)
// acts as the lookup capability: unguessable, and the projection it
// unlocks is deliberately tiny — status + timestamps. No identity
// claim fields are ever returned, so even a leaked id exposes no
// contact details. Runs in system context (the applicant has no
// principal until approval).

import "server-only";

import { prisma, type PrismaClient, type ProviderOnboardingStatus } from "@pharmax/database";
import {
  applySystemSessionGuc,
  withSystemContext,
  type SessionGucExecutor,
} from "@pharmax/tenancy";

const REASON = "portal:application-status";

export interface PortalApplicationStatus {
  readonly applicationId: string;
  readonly status: ProviderOnboardingStatus;
  readonly submittedAt: Date;
  readonly decidedAt: Date | null;
}

export async function getPortalApplicationStatus(
  applicationId: string,
  client: Pick<PrismaClient, "$transaction"> = prisma
): Promise<PortalApplicationStatus | null> {
  return withSystemContext(REASON, () =>
    client.$transaction(async (tx) => {
      await applySystemSessionGuc(tx as unknown as SessionGucExecutor, REASON);
      const row = await tx.providerOnboardingApplication.findUnique({
        where: { id: applicationId },
        select: { id: true, status: true, createdAt: true, decidedAt: true },
      });
      if (row === null) return null;
      return {
        applicationId: row.id,
        status: row.status,
        submittedAt: row.createdAt,
        decidedAt: row.decidedAt,
      };
    })
  );
}
