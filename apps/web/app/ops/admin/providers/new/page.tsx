// /ops/admin/providers/new — register a prescriber.
//
// Until now `RegisterProvider` was reachable only from the partner API
// and the onboarding-approval flow, so a pharmacy adding a prescriber it
// already knows had no way to do it. This is that way.
//
// The NPI lookup lives in a client component because it is interactive;
// everything else stays server-rendered. Nothing here is PHI —
// prescriber identity and practice address are public registry data.
//
// Permission gate: `providers.create`, matching both the command and the
// lookup route the form calls.

import Link from "next/link";

import { geo } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../../src/server/auth/resolve-tenancy.js";
import { PageHeader, Section } from "../../../../../src/components/ui/page.js";
import { Card, CardContent } from "../../../../../src/components/ui/card.js";
import { Banner, PermissionDenied } from "../../../../../src/components/ui/feedback.js";
import { Icon } from "../../../../../src/components/ui/icon.js";
import { ActionForm, SubmitButton } from "../../../../../src/components/ops/action-form.js";
import { RegisterProviderFields } from "../../../../../src/components/ops/register-provider-fields.js";

export default async function RegisterProviderPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.PROVIDERS_CREATE)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Directory" title="Register a prescriber" />
        <PermissionDenied grant="providers.create" />
      </div>
    );
  }

  const flashError = typeof query["error"] === "string" ? query["error"] : null;

  return (
    <div className="space-y-6 animate-fade-in">
      <Link
        href="/ops/admin/providers"
        className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-fg"
      >
        <Icon name="arrowLeft" size={15} />
        Back to prescribers
      </Link>

      <PageHeader
        eyebrow="Directory"
        title="Register a prescriber"
        description="Registering records the prescriber. Affiliate them with a client before they can write prescriptions for it."
      />

      {flashError !== null ? (
        <Banner tone="danger" title="Registration failed">
          {flashError}
        </Banner>
      ) : null}

      <Section title="Prescriber">
        <Card>
          <CardContent>
            <ActionForm action="/api/ops/admin/providers/register" className="space-y-4">
              <RegisterProviderFields stateCodes={geo.US_JURISDICTION_CODES} />
              <SubmitButton variant="go" icon="plus">
                Register prescriber
              </SubmitButton>
            </ActionForm>
          </CardContent>
        </Card>
      </Section>
    </div>
  );
}
