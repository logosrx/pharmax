// /ops/admin/batches/receive — inbound lot receiving (DSCSA).
//
// Receiving-dock form: record an inbound shipment against a catalog
// product + site. Submits to `/api/ops/inventory/receive-lot`, which
// dispatches `ReceiveLot` (ADR-0035 slice 3): create-or-extend the
// lot, write the LOT_RECEIVED ledger credit, and store the DSCSA
// Transaction Information + Transaction Statement attestation.
//
// The command refuses receipt without the seller's TS and refuses
// already-expired stock — the form mirrors both rules but the
// backend is the source of truth.
//
// Permission gate: `inventory.receive`. Supply-chain data only — no
// PHI on this page.

import Link from "next/link";

import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../../src/server/auth/resolve-tenancy.js";
import { listPharmacySites } from "../../../../../src/server/ops/list-pharmacy-sites.js";
import { listProducts } from "../../../../../src/server/ops/list-products.js";
import { PageHeader, Section } from "../../../../../src/components/ui/page.js";
import { Card, CardContent } from "../../../../../src/components/ui/card.js";
import { Banner, PermissionDenied } from "../../../../../src/components/ui/feedback.js";
import { Field, Input, Select } from "../../../../../src/components/ui/field.js";
import { Icon } from "../../../../../src/components/ui/icon.js";
import { ActionForm, SubmitButton } from "../../../../../src/components/ops/action-form.js";

export default async function ReceiveLotPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.INVENTORY_RECEIVE)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Directory" title="Receive inventory" />
        <PermissionDenied grant="inventory.receive" />
      </div>
    );
  }

  const [sites, products] = await Promise.all([
    listPharmacySites({ organizationId: session.tenancy.organizationId }),
    listProducts({ organizationId: session.tenancy.organizationId, limit: 200 }),
  ]);

  const flashError = typeof params["error"] === "string" ? params["error"] : null;

  return (
    <div className="space-y-6 animate-fade-in">
      <Link
        href="/ops/admin/batches"
        className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-fg"
      >
        <Icon name="arrowLeft" size={15} />
        Back to batches
      </Link>

      <PageHeader
        eyebrow="Directory"
        title="Receive inventory"
        description="Record an inbound lot shipment with its DSCSA Transaction Information. Receipt is refused without the seller's Transaction Statement, and expired stock is refused at the door."
      />

      {flashError !== null ? (
        <Banner tone="danger" title="Receipt was not recorded">
          {flashError}
        </Banner>
      ) : null}

      {sites.length === 0 || products.rows.length === 0 ? (
        <Banner tone="warning" title="Catalog not ready">
          Receiving needs at least one pharmacy site and one catalog product.
        </Banner>
      ) : (
        <Card>
          <CardContent>
            <ActionForm action="/api/ops/inventory/receive-lot" className="space-y-6">
              <Section title="Lot">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <Field label="Site">
                    <Select name="siteId" required defaultValue={sites[0]?.siteId}>
                      {sites.map((s) => (
                        <option key={s.siteId} value={s.siteId}>
                          {s.code} — {s.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Product">
                    <Select name="productId" required>
                      {products.rows.map((p) => (
                        <option key={p.productId} value={p.productId}>
                          {p.name}
                          {p.strength !== null ? ` ${p.strength}` : ""} · {p.ndc}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Lot number">
                    <Input name="lotNumber" required maxLength={120} className="font-mono" />
                  </Field>
                  <Field label="Expiration date">
                    <Input name="expirationDate" type="date" required />
                  </Field>
                  <Field label="Quantity received">
                    <Input name="quantity" type="number" min="0.0001" step="any" required />
                  </Field>
                </div>
              </Section>

              <Section title="DSCSA Transaction Information">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <Field label="Product name (as on TI)">
                    <Input name="productName" required maxLength={300} />
                  </Field>
                  <Field label="Strength">
                    <Input name="strength" required maxLength={100} />
                  </Field>
                  <Field label="Dosage form">
                    <Input name="dosageForm" required maxLength={100} />
                  </Field>
                  <Field label="Container size">
                    <Input name="containerSize" required maxLength={100} />
                  </Field>
                  <Field label="Container count">
                    <Input name="containerCount" type="number" min="1" step="1" required />
                  </Field>
                  <Field label="Transaction date">
                    <Input name="transactionDate" type="date" required />
                  </Field>
                  <Field
                    label="Shipment date"
                    help="Only when it differs from the transaction date"
                  >
                    <Input name="shipmentDate" type="date" />
                  </Field>
                  <Field label="Source document ref" help="EPCIS event/file id, ASN, or invoice">
                    <Input name="sourceDocumentRef" maxLength={300} className="font-mono" />
                  </Field>
                </div>
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Seller name">
                    <Input name="sellerName" required maxLength={300} />
                  </Field>
                  <Field label="Seller address">
                    <Input name="sellerAddress" required maxLength={1000} />
                  </Field>
                  <Field label="Buyer name">
                    <Input name="buyerName" required maxLength={300} />
                  </Field>
                  <Field label="Buyer address">
                    <Input name="buyerAddress" required maxLength={1000} />
                  </Field>
                </div>
              </Section>

              <label className="flex items-start gap-2 text-sm text-fg">
                <input
                  type="checkbox"
                  name="transactionStatementReceived"
                  className="mt-0.5"
                  required
                />
                <span>
                  The seller&apos;s <strong>Transaction Statement</strong> accompanied this
                  shipment. Receipt is refused without it (21 USC 360eee-1).
                </span>
              </label>

              <SubmitButton variant="go" icon="check">
                Record receipt
              </SubmitButton>
            </ActionForm>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
