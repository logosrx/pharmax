// /ops/admin/products — drug catalog directory.
//
// Read-only list of the org's Product rows (normalized NDC catalog).
// Lot counts link into the batches tab filtered to that product.
// Catalog mutation is not an operator-console surface yet — rows are
// created by intake/typing flows and seeds.
//
// Permission gate: `inventory.read`.

import Link from "next/link";

import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../src/server/auth/resolve-tenancy.js";
import { listProducts } from "../../../../src/server/ops/list-products.js";
import { PageHeader, Section } from "../../../../src/components/ui/page.js";
import { Table, THead, TH, TBody, TR, TD } from "../../../../src/components/ui/data.js";
import { EmptyState, PermissionDenied } from "../../../../src/components/ui/feedback.js";
import { inputClass } from "../../../../src/components/ui/field.js";
import { buttonClass } from "../../../../src/components/ui/button.js";
import { Icon } from "../../../../src/components/ui/icon.js";

function pluck(
  params: Record<string, string | string[] | undefined>,
  key: string
): string | undefined {
  const v = params[key];
  if (typeof v !== "string" || v.trim().length === 0) return undefined;
  return v.trim();
}

function pageHref(q: string | undefined, cursor: string): string {
  const search = new URLSearchParams();
  if (q !== undefined) search.set("q", q);
  search.set("cursor", cursor);
  return `/ops/admin/products?${search.toString()}`;
}

export default async function ProductAdminPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.INVENTORY_READ)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Directory" title="Products" />
        <PermissionDenied grant="inventory.read" />
      </div>
    );
  }

  const q = pluck(params, "q");
  const cursor = pluck(params, "cursor");
  const result = await listProducts({
    organizationId: session.tenancy.organizationId,
    ...(q !== undefined ? { q } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  });

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        eyebrow="Directory"
        title="Products"
        description="The org's drug catalog, keyed by normalized 11-digit NDC. NDC and drug name are plaintext by design — not PHI. Lot counts link into the batches tab."
      />

      <form method="GET" className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          name="q"
          defaultValue={q ?? ""}
          placeholder="Name or NDC prefix"
          autoComplete="off"
          className={inputClass("max-w-xs")}
        />
        <button type="submit" className={buttonClass({ variant: "primary" })}>
          <Icon name="search" size={16} />
          Search
        </button>
      </form>

      <Section title="Catalog" count={result.rows.length}>
        {result.rows.length === 0 ? (
          <EmptyState
            icon="products"
            title={q === undefined ? "No products in the catalog" : "No products match"}
          />
        ) : (
          <Table>
            <THead>
              <TH>NDC</TH>
              <TH>Name</TH>
              <TH>Strength</TH>
              <TH>Form</TH>
              <TH align="right">Batches</TH>
            </THead>
            <TBody>
              {result.rows.map((row) => (
                <TR key={row.productId}>
                  <TD className="font-mono text-xs">{row.ndc}</TD>
                  <TD className="font-medium">{row.name}</TD>
                  <TD>{row.strength ?? "—"}</TD>
                  <TD>{row.form ?? "—"}</TD>
                  <TD align="right">
                    {row.lotCount > 0 ? (
                      <Link
                        href={`/ops/admin/batches?productId=${row.productId}`}
                        className="font-medium text-tone-brand hover:underline"
                      >
                        {row.lotCount}
                      </Link>
                    ) : (
                      <span className="text-subtle">0</span>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Section>

      {result.nextCursor !== null ? (
        <div>
          <Link
            href={pageHref(q, result.nextCursor)}
            className={buttonClass({ variant: "secondary" })}
          >
            Next page
            <Icon name="arrowRight" size={16} />
          </Link>
        </div>
      ) : null}
    </div>
  );
}
