import type { PrismaClient } from "@pharmax/database";
import { OrganizationStatus, UserStatus, WorkstationStatus } from "@pharmax/database";
import { buildTenancyContext, type TenancyContext } from "@pharmax/tenancy";
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
