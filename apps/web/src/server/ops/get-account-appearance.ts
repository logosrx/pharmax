// Account-appearance projection — drives `/ops/account/appearance`.
//
// The signed-in operator's saved console theme. Self-scoped (the page
// passes the session's own userId) — not an admin surface.
//
// PHI: none.
// Tenancy: explicit `organizationId` + `userId` predicates on top of
// RLS scope.

import "server-only";

import { readInOrgScope } from "@pharmax/database";

import { themeChoiceFromPreference, type ThemeChoice } from "../../lib/theme.js";

export async function getAccountAppearance(options: {
  readonly organizationId: string;
  readonly userId: string;
}): Promise<{ readonly theme: ThemeChoice }> {
  return readInOrgScope(options.organizationId, async (tx) => {
    const user = await tx.user.findFirst({
      where: { id: options.userId, organizationId: options.organizationId },
      select: { themePreference: true },
    });
    return { theme: themeChoiceFromPreference(user?.themePreference ?? "DARK") };
  });
}
