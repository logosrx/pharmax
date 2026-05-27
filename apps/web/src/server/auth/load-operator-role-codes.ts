// Load the operator's role-code list for the MFA floor check.
//
// Why a separate loader (we already have `PrismaPermissionLoader`):
//
//   - The MFA floor decision needs ROLE codes (`OrgAdmin`,
//     `BillingManager`), not the resolved permission set the
//     command bus consumes. Reusing the permission loader would
//     pull a 4-table JOIN when a 2-table one suffices.
//
//   - The role codes are denormalized into the `Role` table
//     directly; the permission loader's flattening drops the
//     code column.
//
// Tenancy: scoped via `organizationId` predicate on the SQL.
// Runs in system context because the call site precedes the
// per-request tenancy frame (the wrapper resolves session first,
// then loads roles BEFORE entering the command-bus tenancy).
//
// PHI invariant: role codes and user-role rows carry no PHI.

import "server-only";

import { Prisma, prisma } from "@pharmax/database";
import { withSystemContext } from "@pharmax/tenancy";

interface RoleCodeRow {
  readonly code: string;
}

export async function loadOperatorRoleCodes(input: {
  readonly organizationId: string;
  readonly userId: string;
}): Promise<ReadonlyArray<string>> {
  const rows = await withSystemContext("apps/web:load-operator-role-codes", async () =>
    prisma.$queryRaw<RoleCodeRow[]>(
      Prisma.sql`
        SELECT DISTINCT r.code AS "code"
        FROM user_role ur
        JOIN role r ON r.id = ur.role_id
        WHERE ur.organization_id = ${input.organizationId}::uuid
          AND ur.user_id         = ${input.userId}::uuid
      `
    )
  );
  return rows.map((r) => r.code);
}
