// /ops/account/appearance — the operator's own console theme.
//
// Self-service surface: dark / light / system, saved to the account via
// the SetThemePreference command so the choice follows the operator to
// every device (the sign-in route seeds the render-hint cookie from
// it). No RBAC permission gate — the loader is self-scoped to the
// session's userId.

import { PageHeader, Section } from "../../../../src/components/ui/page.js";
import { AccountNav } from "../../../../src/components/account/account-nav.js";
import { AppearanceSelector } from "../../../../src/components/account/appearance-selector.js";
import { resolveOperatorTenancyContext } from "../../../../src/server/auth/resolve-tenancy.js";
import { getAccountAppearance } from "../../../../src/server/ops/get-account-appearance.js";

export default async function AccountAppearancePage() {
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const appearance = await getAccountAppearance({
    organizationId: session.tenancy.organizationId,
    userId: session.tenancy.actor.userId,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Account"
        title="Appearance"
        description="How the console looks for you, on every device."
      />

      <AccountNav />

      <Section title="Theme">
        <AppearanceSelector initialTheme={appearance.theme} />
      </Section>
    </div>
  );
}
