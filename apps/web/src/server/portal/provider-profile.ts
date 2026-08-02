// Prescriber profile read for the portal profile page (ADR-0033,
// slice 3). Loads the CONTACT fields the portal profile form can
// edit — identity (name, NPI) and credential fields render read-only
// from the session identity, and DEA is never surfaced to the portal.
//
// System context, explicitly scoped to the session's own
// (organizationId, providerId) — same posture as every portal read.

import "server-only";

import { prisma, type PrismaClient } from "@pharmax/database";
import {
  applySystemSessionGuc,
  withSystemContext,
  type SessionGucExecutor,
} from "@pharmax/tenancy";

const REASON = "portal:load-provider-profile";

export interface PortalProviderProfile {
  readonly phone: string | null;
  readonly email: string | null;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly postalCode: string | null;
}

export async function getPortalProviderProfile(input: {
  readonly organizationId: string;
  readonly providerId: string;
  readonly client?: Pick<PrismaClient, "$transaction">;
}): Promise<PortalProviderProfile | null> {
  const client = input.client ?? prisma;
  return withSystemContext(REASON, () =>
    client.$transaction(async (tx) => {
      await applySystemSessionGuc(tx as unknown as SessionGucExecutor, REASON);
      const row = await tx.provider.findFirst({
        where: { id: input.providerId, organizationId: input.organizationId },
        select: {
          phone: true,
          email: true,
          addressLine1: true,
          addressLine2: true,
          city: true,
          state: true,
          postalCode: true,
        },
      });
      return row;
    })
  );
}
