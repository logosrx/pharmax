// Regression test for the P0 tenant-isolation fix.
//
// Before this fix, the package exported a RAW PrismaClient and the
// `@pharmax/tenancy` extension was defined but never applied. Read
// helpers like `prisma.reportSchedule.findMany()` therefore ran with
// NO org filter — leaking across tenants under a BYPASSRLS connection
// role, or returning zero rows under `pharmax_app`.
//
// This suite pins the wiring so the leak cannot silently return:
//
//   1. The exported `prisma` is the TENANCY-ENFORCED client. A query
//      on a tenant-scoped model with NO ALS frame fails closed with
//      `TENANCY_NO_CONTEXT` (the extension throws BEFORE touching the
//      database, so this needs no live Postgres).
//   2. A create that targets a DIFFERENT org than the active context
//      is blocked with `TENANCY_CROSS_ORG_WRITE` (also pre-DB).
//   3. `systemPrisma` is exported as a SEPARATE, raw client for
//      explicit cross-tenant system/bootstrap use.
//   4. The both-layers read wrapper `readInTenantContext` is exported.
//
// The happy-path "filter injection returns only the active org's
// rows" property is proven without a DB in
// `@pharmax/tenancy/anti-leak.test.ts` against a fake client, and at
// the DB (RLS) layer in `@pharmax/integration-tests/order.test.ts`.
// Here we only assert the THROW paths, which never reach the network.

import { describe, expect, it, beforeAll } from "vitest";

import {
  buildTenancyContext,
  withTenancyContext,
  TENANCY_CROSS_ORG_WRITE,
  TENANCY_NO_CONTEXT,
  type TenancyContext,
} from "@pharmax/tenancy";

import { prisma, systemPrisma, readInTenantContext } from "./index.js";

const ORG_A = "00000000-0000-4000-8000-00000000000a";
const ORG_B = "00000000-0000-4000-8000-00000000000b";

function ctxFor(organizationId: string): TenancyContext {
  return buildTenancyContext({
    organizationId,
    actor: {
      userId: "00000000-0000-4000-8000-000000000001",
      correlationId: "01J0TESTCORRELATION00000000",
    },
  });
}

beforeAll(() => {
  // The extension throws before any connection on the paths under
  // test, but set a dummy URL so client construction never reads a
  // real one from the environment.
  process.env["DATABASE_URL"] ??= "postgresql://test:test@localhost:5432/test";
  process.env["DIRECT_URL"] ??= "postgresql://test:test@localhost:5432/test";
});

describe("@pharmax/database canonical client is tenancy-enforced", () => {
  it("exports `prisma` (scoped) and `systemPrisma` (raw) as distinct clients", () => {
    expect(prisma).toBeDefined();
    expect(systemPrisma).toBeDefined();
    expect(prisma).not.toBe(systemPrisma);
    expect(typeof readInTenantContext).toBe("function");
  });

  it("fails CLOSED on a tenant-scoped query with no tenancy frame", async () => {
    await expect(prisma.reportSchedule.findMany()).rejects.toMatchObject({
      code: TENANCY_NO_CONTEXT,
    });
    await expect(prisma.order.findMany()).rejects.toMatchObject({
      code: TENANCY_NO_CONTEXT,
    });
    await expect(prisma.patient.findMany()).rejects.toMatchObject({
      code: TENANCY_NO_CONTEXT,
    });
  });

  it("blocks a create that targets a different org than the active context", async () => {
    await withTenancyContext(ctxFor(ORG_A), async () => {
      await expect(
        // Attempt to write a row stamped for ORG_B while scoped to ORG_A.
        prisma.reportSchedule.create({
          data: { organizationId: ORG_B } as never,
        })
      ).rejects.toMatchObject({ code: TENANCY_CROSS_ORG_WRITE });
    });
  });
});
