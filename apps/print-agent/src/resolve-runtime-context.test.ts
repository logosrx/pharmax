// Regression coverage for the boot-time tenancy chicken-and-egg:
// resolvePrintAgentRuntimeContext runs BEFORE any tenancy frame can
// exist (its whole job is producing that frame), so its reads must
// execute inside an explicit system-context frame. The 2026-07 prod
// crash loop ("Query on tenant-scoped model \"Organization\"
// attempted outside a tenancy context.") was this exact gap.

import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@pharmax/database";
import { describeCurrentContext, getSystemContextReason } from "@pharmax/tenancy";

import {
  PrintAgentBootstrapError,
  resolvePrintAgentRuntimeContext,
} from "./resolve-runtime-context.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const SITE_ID = "00000000-0000-4000-8000-000000000002";
const TEAM_ID = "00000000-0000-4000-8000-000000000003";
const WORKSTATION_ID = "00000000-0000-4000-8000-000000000004";
const USER_ID = "00000000-0000-4000-8000-000000000009";

const INPUT = {
  organizationSlug: "main-pharmacy",
  workstationCode: "FILL-01",
  actorEmail: "print-agent@main-pharmacy.test",
};

interface ClientOverrides {
  organization?: { id: string } | null;
  workstation?: { id: string; siteId: string | null } | null;
  actor?: { id: string } | null;
  teamGrant?: { teamId: string | null; siteId: string | null } | null;
}

function buildClient(overrides: ClientOverrides = {}) {
  // Each fake delegate records the ALS frame kind observed at call
  // time so the test can prove the reads ran under system context.
  const observedFrames: Array<{ model: string; frame: string; reason: string | null }> = [];

  const record = (model: string): void => {
    observedFrames.push({
      model,
      frame: describeCurrentContext(),
      reason: getSystemContextReason(),
    });
  };

  const client = {
    organization: {
      findFirst: vi.fn(async () => {
        record("Organization");
        return overrides.organization !== undefined ? overrides.organization : { id: ORG_ID };
      }),
    },
    workstation: {
      findFirst: vi.fn(async () => {
        record("Workstation");
        return overrides.workstation !== undefined
          ? overrides.workstation
          : { id: WORKSTATION_ID, siteId: SITE_ID };
      }),
    },
    user: {
      findFirst: vi.fn(async () => {
        record("User");
        return overrides.actor !== undefined ? overrides.actor : { id: USER_ID };
      }),
    },
    userRole: {
      findFirst: vi.fn(async () => {
        record("UserRole");
        return overrides.teamGrant !== undefined ? overrides.teamGrant : null;
      }),
    },
  };

  return { client: client as unknown as PrismaClient, observedFrames };
}

describe("resolvePrintAgentRuntimeContext", () => {
  it("resolves with no ambient tenancy frame (boot conditions)", async () => {
    const { client } = buildClient();

    // Deliberately NOT wrapped in withTenancyContext/withSystemContext:
    // this is exactly how main.ts calls it at boot.
    expect(describeCurrentContext()).toBe("none");

    const runtime = await resolvePrintAgentRuntimeContext(client, INPUT);

    expect(runtime.organizationId).toBe(ORG_ID);
    expect(runtime.workstationId).toBe(WORKSTATION_ID);
    expect(runtime.actorUserId).toBe(USER_ID);
    expect(runtime.tenancy.organizationId).toBe(ORG_ID);
    expect(runtime.tenancy.workstationId).toBe(WORKSTATION_ID);
  });

  it("runs every identifier lookup inside a system-context frame", async () => {
    const { client, observedFrames } = buildClient();

    await resolvePrintAgentRuntimeContext(client, INPUT);

    expect(observedFrames.map((f) => f.model)).toEqual([
      "Organization",
      "Workstation",
      "User",
      "UserRole",
    ]);
    for (const observed of observedFrames) {
      expect(observed.frame).toBe("system");
      expect(observed.reason).toBe("print-agent:bootstrap-runtime-resolve");
    }
  });

  it("does not leak the system frame past resolution", async () => {
    const { client } = buildClient();

    await resolvePrintAgentRuntimeContext(client, INPUT);

    expect(describeCurrentContext()).toBe("none");
  });

  it("prefers the actor's team grant scope over the workstation site", async () => {
    const grantSiteId = "00000000-0000-4000-8000-000000000005";
    const { client } = buildClient({
      teamGrant: { teamId: TEAM_ID, siteId: grantSiteId },
    });

    const runtime = await resolvePrintAgentRuntimeContext(client, INPUT);

    expect(runtime.tenancy.teamId).toBe(TEAM_ID);
    expect(runtime.tenancy.siteId).toBe(grantSiteId);
  });

  it("falls back to the workstation site when no team grant exists", async () => {
    const { client } = buildClient({ teamGrant: null });

    const runtime = await resolvePrintAgentRuntimeContext(client, INPUT);

    expect(runtime.tenancy.siteId).toBe(SITE_ID);
    expect(runtime.tenancy.teamId).toBeUndefined();
  });

  it("throws PrintAgentBootstrapError when the organization is missing", async () => {
    const { client } = buildClient({ organization: null });

    await expect(resolvePrintAgentRuntimeContext(client, INPUT)).rejects.toThrow(
      PrintAgentBootstrapError
    );
  });

  it("throws PrintAgentBootstrapError when the workstation is missing", async () => {
    const { client } = buildClient({ workstation: null });

    await expect(resolvePrintAgentRuntimeContext(client, INPUT)).rejects.toThrow(
      PrintAgentBootstrapError
    );
  });

  it("throws PrintAgentBootstrapError when the actor is missing", async () => {
    const { client } = buildClient({ actor: null });

    await expect(resolvePrintAgentRuntimeContext(client, INPUT)).rejects.toThrow(
      PrintAgentBootstrapError
    );
  });
});
