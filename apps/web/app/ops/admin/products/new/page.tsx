// /ops/admin/products/new — create an in-house compound product.
//
// Admin form: define a compound (name, strength, counting unit,
// serial identity) and submit to `/api/ops/catalog/create-compound-
// product`, which dispatches `CreateCompoundProduct`. The command
// mints the org's next Pharmax Product ID under a row lock and
// freezes the serial identity that every batch unit number of this
// product will carry (the "T30" in PHX-T30-1-040327-11) — so the
// form previews that serial live before the admin commits.
//
// Permission gate: `catalog.compound_product.create`. Catalog data
// only — no PHI on this page.

import Link from "next/link";

import { PERMISSIONS } from "@pharmax/rbac";
import { ControlledSubstanceSchedule, ProductUnitKind } from "@pharmax/database";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../../src/server/auth/resolve-tenancy.js";
import { listPharmacySites } from "../../../../../src/server/ops/list-pharmacy-sites.js";
import { PageHeader, Section } from "../../../../../src/components/ui/page.js";
import { Card, CardContent } from "../../../../../src/components/ui/card.js";
import { Banner, PermissionDenied } from "../../../../../src/components/ui/feedback.js";
import { Field, Input, Select } from "../../../../../src/components/ui/field.js";
import { Icon } from "../../../../../src/components/ui/icon.js";
import { ActionForm, SubmitButton } from "../../../../../src/components/ops/action-form.js";
import { CompoundSerialFields } from "../../../../../src/components/ops/compound-serial-fields.js";

const UNIT_KIND_LABELS: Readonly<Record<ProductUnitKind, string>> = {
  VIAL: "Vials",
  TABLET: "Tablets",
  CAPSULE: "Capsules",
  SYRINGE: "Syringes",
  PEN: "Pens",
  TROCHE: "Troches",
  OTHER: "Other units",
};

const SCHEDULE_LABELS: Readonly<Record<ControlledSubstanceSchedule, string>> = {
  NON_CONTROLLED: "Not controlled",
  CII: "Schedule II",
  CIII: "Schedule III",
  CIV: "Schedule IV",
  CV: "Schedule V",
};

export default async function NewCompoundProductPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.CATALOG_COMPOUND_PRODUCT_CREATE)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Directory" title="New compound" />
        <PermissionDenied grant="catalog.compound_product.create" />
      </div>
    );
  }

  const sites = await listPharmacySites({ organizationId: session.tenancy.organizationId });
  const sampleSiteCode = sites[0]?.code ?? "PHX";

  const flashError = typeof params["error"] === "string" ? params["error"] : null;

  return (
    <div className="space-y-6 animate-fade-in">
      <Link
        href="/ops/admin/products"
        className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-fg"
      >
        <Icon name="arrowLeft" size={15} />
        Back to products
      </Link>

      <PageHeader
        eyebrow="Directory"
        title="New compound"
        description="Define an in-house compound. Saving mints the org's next Pharmax Product ID and freezes the serial identity printed in every batch unit number — get the initial and mg right before committing."
      />

      {flashError !== null ? (
        <Banner tone="danger" title="Compound was not created">
          {flashError}
        </Banner>
      ) : null}

      <Card>
        <CardContent>
          <ActionForm action="/api/ops/catalog/create-compound-product" className="space-y-6">
            <Section title="Compound">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <Field label="Name" help='e.g. "Tirzepatide/Glycine"'>
                  <Input name="name" required maxLength={300} autoComplete="off" />
                </Field>
                <Field
                  label="Strength"
                  help='Per-container strengths and volume, e.g. "10mg/20mg/3mL"'
                >
                  <Input name="strength" required maxLength={100} className="font-mono" />
                </Field>
                <Field label="Dosage form" help='Optional, e.g. "Injectable solution"'>
                  <Input name="form" maxLength={100} />
                </Field>
                <Field label="Counted in" help="The unit a batch is counted and serialized in">
                  <Select name="unitKind" required defaultValue="VIAL">
                    {Object.values(ProductUnitKind).map((kind) => (
                      <option key={kind} value={kind}>
                        {UNIT_KIND_LABELS[kind]}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="DEA schedule">
                  <Select name="controlledSubstanceSchedule" defaultValue="NON_CONTROLLED">
                    {Object.values(ControlledSubstanceSchedule).map((schedule) => (
                      <option key={schedule} value={schedule}>
                        {SCHEDULE_LABELS[schedule]}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            </Section>

            <Section title="Serial identity">
              <CompoundSerialFields sampleSiteCode={sampleSiteCode} />
            </Section>

            <SubmitButton variant="go" icon="check">
              Create compound
            </SubmitButton>
          </ActionForm>
        </CardContent>
      </Card>
    </div>
  );
}
