// /ops/admin/compound-batches/new — record a finished production run.
//
// The compounding team fills this in the moment a batch physically
// exists: which compound, which site, how many units, compounded
// when, BUD until when. Submits to
// `/api/ops/inventory/create-compound-batch`, which dispatches
// `CreateCompoundBatch` — the batch number and EVERY unit serial are
// minted server-side in that one transaction, so the form previews
// them live but never generates them.
//
// Permission gate: `inventory.batch.create`. Catalog/inventory data
// only — no PHI on this page.

import Link from "next/link";

import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../../src/server/auth/resolve-tenancy.js";
import { listCompoundProducts } from "../../../../../src/server/ops/list-compound-products.js";
import { listPharmacySites } from "../../../../../src/server/ops/list-pharmacy-sites.js";
import { PageHeader, Section } from "../../../../../src/components/ui/page.js";
import { Card, CardContent } from "../../../../../src/components/ui/card.js";
import { Banner, EmptyState, PermissionDenied } from "../../../../../src/components/ui/feedback.js";
import { Icon } from "../../../../../src/components/ui/icon.js";
import { ActionForm, SubmitButton } from "../../../../../src/components/ops/action-form.js";
import { CompoundBatchFields } from "../../../../../src/components/ops/compound-batch-fields.js";

export default async function NewCompoundBatchPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.INVENTORY_BATCH_CREATE)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Directory" title="New compound batch" />
        <PermissionDenied grant="inventory.batch.create" />
      </div>
    );
  }

  const [products, sites] = await Promise.all([
    listCompoundProducts({ organizationId: session.tenancy.organizationId }),
    listPharmacySites({ organizationId: session.tenancy.organizationId }),
  ]);

  const flashError = typeof params["error"] === "string" ? params["error"] : null;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-6 animate-fade-in">
      <Link
        href="/ops/admin/compound-batches"
        className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-fg"
      >
        <Icon name="arrowLeft" size={15} />
        Back to compound batches
      </Link>

      <PageHeader
        eyebrow="Directory"
        title="New compound batch"
        description="Record a finished production run. Saving mints the batch number and a serial for every unit, and starts the batch in COMPOUNDED — send it to the testing lab from its detail page."
      />

      {flashError !== null ? (
        <Banner tone="danger" title="Batch was not recorded">
          {flashError}
        </Banner>
      ) : null}

      {products.length === 0 ? (
        <EmptyState
          icon="products"
          title="No compound products in the catalog yet"
          description="Batches are recorded against a compound product's frozen serial identity — define the compound first."
          action={{
            label: "New compound",
            href: "/ops/admin/products/new",
            icon: "plus",
          }}
        />
      ) : (
        <Card>
          <CardContent>
            <ActionForm action="/api/ops/inventory/create-compound-batch" className="space-y-6">
              <Section title="Production run">
                <CompoundBatchFields
                  products={products.map((p) => ({
                    productId: p.productId,
                    name: p.name,
                    strength: p.strength,
                    pharmaxProductId: p.pharmaxProductId,
                    unitKind: p.unitKind,
                    serialDrugInitial: p.serialDrugInitial,
                    serialDrugMg: p.serialDrugMg,
                  }))}
                  sites={sites.map((s) => ({ siteId: s.siteId, code: s.code, name: s.name }))}
                  defaultCompoundedOn={today}
                />
              </Section>

              <SubmitButton variant="go" icon="check">
                Record batch & mint serials
              </SubmitButton>
            </ActionForm>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
