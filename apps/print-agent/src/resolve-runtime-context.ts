// Boot-time bridge from the agent's tenant-less configuration
// (org slug + workstation code + actor email env vars) to the
// per-tenant runtime context every subsequent operation runs in.
//
// The identifier lookups run in **system context** (tenancy-filter
// bypass) because this is the chicken-and-egg point of the process:
// the tenancy frame cannot exist until these reads resolve the
// organization it would scope to. This mirrors the worker-drain
// webhook resolvers; eslint.config.js "Override 3k" scopes the
// withSystemContext allowance to exactly this file. Everything
// after boot runs inside the resolved tenancy via
// `withTenancyContext`.
//
// PHI: none of these reads decrypt PHI — org id by slug, workstation
// id by code, service-user id by email, and a role grant row.

import type { PrismaClient } from "@pharmax/database";
import { OrganizationStatus, UserStatus, WorkstationStatus } from "@pharmax/database";
import { buildTenancyContext, withSystemContext, type TenancyContext } from "@pharmax/tenancy";
import { ulid } from "ulid";

export interface PrintAgentRuntimeContext {
  readonly tenancy: TenancyContext;
  readonly organizationId: string;
  readonly workstationId: string;
  readonly actorUserId: string;
}

export class PrintAgentBootstrapError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PrintAgentBootstrapError";
  }
}

export async function resolvePrintAgentRuntimeContext(
  client: PrismaClient,
  input: {
    organizationSlug: string;
    workstationCode: string;
    actorEmail: string;
  }
): Promise<PrintAgentRuntimeContext> {
  // The Prisma tenancy extension throws on tenant-scoped reads
  // outside a tenancy frame, and no frame can exist yet — these
  // reads are what resolve the organization the frame scopes to.
  const { organization, workstation, actor, teamGrant } = await withSystemContext(
    "print-agent:bootstrap-runtime-resolve",
    async () => {
      const organization = await client.organization.findFirst({
        where: { slug: input.organizationSlug, status: OrganizationStatus.ACTIVE },
        select: { id: true },
      });
      if (organization === null) {
        throw new PrintAgentBootstrapError(
          `Organization slug "${input.organizationSlug}" not found or inactive.`
        );
      }

      const workstation = await client.workstation.findFirst({
        where: {
          organizationId: organization.id,
          code: input.workstationCode,
          status: WorkstationStatus.ACTIVE,
        },
        select: { id: true, siteId: true },
      });
      if (workstation === null) {
        throw new PrintAgentBootstrapError(
          `Workstation "${input.workstationCode}" not found or inactive for org "${input.organizationSlug}".`
        );
      }

      const actor = await client.user.findFirst({
        where: {
          organizationId: organization.id,
          email: input.actorEmail,
          status: { in: [UserStatus.ACTIVE, UserStatus.INVITED] },
        },
        select: { id: true },
      });
      if (actor === null) {
        throw new PrintAgentBootstrapError(
          `Actor "${input.actorEmail}" not found for org "${input.organizationSlug}".`
        );
      }

      const teamGrant = await client.userRole.findFirst({
        where: {
          organizationId: organization.id,
          userId: actor.id,
          teamId: { not: null },
        },
        select: { teamId: true, siteId: true },
        orderBy: { createdAt: "asc" },
      });

      return { organization, workstation, actor, teamGrant };
    }
  );

  const tenancy = buildTenancyContext({
    organizationId: organization.id,
    siteId: teamGrant?.siteId ?? workstation.siteId,
    ...(teamGrant?.teamId !== undefined && teamGrant.teamId !== null
      ? { teamId: teamGrant.teamId }
      : {}),
    workstationId: workstation.id,
    actor: { userId: actor.id, correlationId: ulid() },
  });

  return {
    tenancy,
    organizationId: organization.id,
    workstationId: workstation.id,
    actorUserId: actor.id,
  };
}
