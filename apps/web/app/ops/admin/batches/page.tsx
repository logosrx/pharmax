// /ops/admin/batches — inventory lot (batch) directory.
//
// Read-only list of the org's inventory lots ordered by soonest
// expiration, with a status filter. Expired lots surface a danger
// badge — they are assignment-blocked at fill time regardless of
// status. Hold / deplete / assign stay behind the fill workflow
// commands; this page never mutates.
//
// Permission gate: `inventory.read`.

import Link from "next/link";

import { LotStatus } from "@pharmax/database";
import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../src/server/auth/resolve-tenancy.js";
import { listLots } from "../../../../src/server/ops/list-lots.js";
import { PageHeader, Section, FilterTabs } from "../../../../src/components/ui/page.js";
import { Table, THead, TH, TBody, TR, TD } from "../../../../src/components/ui/data.js";
import { Badge, type Tone } from "../../../../src/components/ui/badge.js";
import { EmptyState, PermissionDenied } from "../../../../src/components/ui/feedback.js";
import { buttonClass } from "../../../../src/components/ui/button.js";
import { Icon } from "../../../../src/components/ui/icon.js";

const STATUS_TONES: Record<LotStatus, Tone> = {
  [LotStatus.ACTIVE]: "success",
  [LotStatus.ON_HOLD]: "warning",
  [LotStatus.DEPLETED]: "neutral",
};

function pluck(
  params: Record<string, string | string[] | undefined>,
  key: string
): string | undefined {
  const v = params[key];
  if (typeof v !== "string" || v.trim().length === 0) return undefined;
  return v.trim();
}

function parseStatus(value: string | undefined): LotStatus | undefined {
  return value !== undefined && (Object.values(LotStatus) as string[]).includes(value)
    ? (value as LotStatus)
    : undefined;
}

function pageHref(input: {
  readonly status?: LotStatus | undefined;
  readonly productId?: string | undefined;
  readonly cursor?: string | undefined;
}): string {
  const search = new URLSearchParams();
  if (input.status !== undefined) search.set("status", input.status);
  if (input.productId !== undefined) search.set("productId", input.productId);
  if (input.cursor !== undefined) search.set("cursor", input.cursor);
  const qs = search.toString();
  return qs.length === 0 ? "/ops/admin/batches" : `/ops/admin/batches?${qs}`;
}

function formatDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default async function BatchAdminPage({
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
        <PageHeader eyebrow="Directory" title="Batches" />
        <PermissionDenied grant="inventory.read" />
      </div>
    );
  }

  const status = parseStatus(pluck(params, "status"));
  const productId = pluck(params, "productId");
  const cursor = pluck(params, "cursor");
  const result = await listLots({
    organizationId: session.tenancy.organizationId,
    ...(status !== undefined ? { status } : {}),
    ...(productId !== undefined ? { productId } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  });

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        eyebrow="Directory"
        title="Batches"
        description="Inventory lots by soonest expiration. Expired or held lots are blocked at assignment time — status changes happen through the fill workflow, never here."
      />

      <div className="flex flex-wrap items-center gap-3">
        <FilterTabs
          items={[
            { href: pageHref({ productId }), label: "All", active: status === undefined },
            ...Object.values(LotStatus).map((s) => ({
              href: pageHref({ status: s, productId }),
              label: s.replace("_", " "),
              active: status === s,
            })),
          ]}
        />
        {productId !== undefined ? (
          <Link href={pageHref({ status })} className="text-xs text-muted hover:text-fg">
            Filtered to one product — clear
          </Link>
        ) : null}
      </div>

      <Section title="Lots" count={result.rows.length}>
        {result.rows.length === 0 ? (
          <EmptyState icon="batches" title="No lots match this filter" />
        ) : (
          <Table>
            <THead>
              <TH>Lot #</TH>
              <TH>Product</TH>
              <TH>Site</TH>
              <TH>Status</TH>
              <TH>Expires</TH>
            </THead>
            <TBody>
              {result.rows.map((row) => (
                <TR key={row.lotId}>
                  <TD className="font-mono text-xs font-medium">{row.lotNumber}</TD>
                  <TD>
                    <div className="font-medium">
                      {row.productName}
                      {row.productStrength !== null ? (
                        <span className="text-muted"> · {row.productStrength}</span>
                      ) : null}
                    </div>
                    <div className="font-mono text-xs text-subtle">{row.productNdc}</div>
                  </TD>
                  <TD>
                    <span className="font-mono text-xs">{row.siteCode}</span>{" "}
                    <span className="text-muted">{row.siteName}</span>
                  </TD>
                  <TD>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={STATUS_TONES[row.status]}>{row.status.replace("_", " ")}</Badge>
                      {row.expired ? <Badge tone="danger">EXPIRED</Badge> : null}
                    </div>
                  </TD>
                  <TD>
                    <span
                      className={
                        row.expired ? "font-mono text-xs text-tone-danger" : "font-mono text-xs"
                      }
                    >
                      {formatDay(row.expirationDate)}
                    </span>
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
            href={pageHref({ status, productId, cursor: result.nextCursor })}
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
