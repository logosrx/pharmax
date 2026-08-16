// /ops/admin/compound-batches — in-house compound batch directory.
//
// Paginated list of compound production runs with their quality
// lifecycle status (COMPOUNDED → TESTING → RELEASED ⇄ DISPENSING,
// REJECTED terminal), newest first, with a status filter. Batches
// past their Beyond-Use Date surface a danger badge — they are
// dispense-blocked regardless of status.
//
// All mutations go through the batch lifecycle commands (create here
// via /new; transitions on the batch detail page).
//
// Permission gate: `inventory.read`; the New batch button additionally
// requires `inventory.batch.create`.

import Link from "next/link";

import { CompoundBatchStatus } from "@pharmax/database";
import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../src/server/auth/resolve-tenancy.js";
import { listCompoundBatches } from "../../../../src/server/ops/list-compound-batches.js";
import { PageHeader, Section, FilterTabs } from "../../../../src/components/ui/page.js";
import { Table, THead, TH, TBody, TR, TD } from "../../../../src/components/ui/data.js";
import { Badge, type Tone } from "../../../../src/components/ui/badge.js";
import { Banner, EmptyState, PermissionDenied } from "../../../../src/components/ui/feedback.js";
import { buttonClass } from "../../../../src/components/ui/button.js";
import { Icon } from "../../../../src/components/ui/icon.js";

const STATUS_TONES: Record<CompoundBatchStatus, Tone> = {
  [CompoundBatchStatus.COMPOUNDED]: "neutral",
  [CompoundBatchStatus.TESTING]: "warning",
  [CompoundBatchStatus.RELEASED]: "success",
  [CompoundBatchStatus.DISPENSING]: "success",
  [CompoundBatchStatus.REJECTED]: "danger",
};

function pluck(
  params: Record<string, string | string[] | undefined>,
  key: string
): string | undefined {
  const v = params[key];
  if (typeof v !== "string" || v.trim().length === 0) return undefined;
  return v.trim();
}

function parseStatus(value: string | undefined): CompoundBatchStatus | undefined {
  return value !== undefined && (Object.values(CompoundBatchStatus) as string[]).includes(value)
    ? (value as CompoundBatchStatus)
    : undefined;
}

function pageHref(input: {
  readonly status?: CompoundBatchStatus | undefined;
  readonly productId?: string | undefined;
  readonly cursor?: string | undefined;
}): string {
  const search = new URLSearchParams();
  if (input.status !== undefined) search.set("status", input.status);
  if (input.productId !== undefined) search.set("productId", input.productId);
  if (input.cursor !== undefined) search.set("cursor", input.cursor);
  const qs = search.toString();
  return qs.length === 0 ? "/ops/admin/compound-batches" : `/ops/admin/compound-batches?${qs}`;
}

function formatDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default async function CompoundBatchesPage({
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
        <PageHeader eyebrow="Directory" title="Compound batches" />
        <PermissionDenied grant="inventory.read" />
      </div>
    );
  }

  const status = parseStatus(pluck(params, "status"));
  const productId = pluck(params, "productId");
  const cursor = pluck(params, "cursor");
  const flash = pluck(params, "flash") ?? null;
  const result = await listCompoundBatches({
    organizationId: session.tenancy.organizationId,
    ...(status !== undefined ? { status } : {}),
    ...(productId !== undefined ? { productId } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  });

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        eyebrow="Directory"
        title="Compound batches"
        description="In-house production runs and their quality lifecycle: compounded, at the testing lab, released, or actively dispensing. Every unit's serial was minted when its batch was recorded."
        actions={
          hasOperatorPermission(permissions, PERMISSIONS.INVENTORY_BATCH_CREATE) ? (
            <Link href="/ops/admin/compound-batches/new" className={buttonClass({ variant: "go" })}>
              <Icon name="plus" size={16} />
              New batch
            </Link>
          ) : null
        }
      />

      {flash !== null ? <Banner tone="success">{flash}</Banner> : null}

      <div className="flex flex-wrap items-center gap-3">
        <FilterTabs
          items={[
            { href: pageHref({ productId }), label: "All", active: status === undefined },
            ...Object.values(CompoundBatchStatus).map((s) => ({
              href: pageHref({ status: s, productId }),
              label: s,
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

      <Section title="Batches" count={result.rows.length}>
        {result.rows.length === 0 ? (
          <EmptyState
            icon="batches"
            title="No compound batches match this filter"
            description="Adjust the filter above, or record a new production run to mint its serials and start its quality lifecycle."
            action={{
              label: "New batch",
              href: "/ops/admin/compound-batches/new",
              icon: "plus",
            }}
          />
        ) : (
          <Table>
            <THead>
              <TH>Batch #</TH>
              <TH>Compound</TH>
              <TH>Site</TH>
              <TH>Units</TH>
              <TH>Status</TH>
              <TH>BUD</TH>
            </THead>
            <TBody>
              {result.rows.map((row) => (
                <TR key={row.batchId}>
                  <TD className="font-mono text-xs font-medium">
                    <Link
                      href={`/ops/admin/compound-batches/${row.batchId}`}
                      className="text-brand hover:underline"
                    >
                      {row.batchNumber}
                    </Link>
                  </TD>
                  <TD>
                    <div className="font-medium">
                      {row.productName}
                      {row.productStrength !== null ? (
                        <span className="text-muted"> · {row.productStrength}</span>
                      ) : null}
                    </div>
                    <div className="font-mono text-xs text-subtle">
                      {row.pharmaxProductId ?? "—"}
                    </div>
                  </TD>
                  <TD>
                    <span className="font-mono text-xs">{row.siteCode}</span>{" "}
                    <span className="text-muted">{row.siteName}</span>
                  </TD>
                  <TD className="font-mono text-xs">{row.unitCount}</TD>
                  <TD>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={STATUS_TONES[row.status]}>{row.status}</Badge>
                      {row.pastBud ? <Badge tone="danger">PAST BUD</Badge> : null}
                    </div>
                  </TD>
                  <TD>
                    <span
                      className={
                        row.pastBud ? "font-mono text-xs text-tone-danger" : "font-mono text-xs"
                      }
                    >
                      {formatDay(row.beyondUseDate)}
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
