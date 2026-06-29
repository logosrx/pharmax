// /ops/billing — invoice list for the operator's tenancy.
//
// Permission-gated on `billing.read`; finer-grained actions (finalize,
// credit, refund) are gated on the detail page.

import { type InvoiceStatus } from "@pharmax/database";
import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../src/server/auth/resolve-tenancy.js";
import { listInvoices } from "../../../src/server/ops/list-invoices.js";
import { PageHeader, FilterTabs } from "../../../src/components/ui/page.js";
import { LinkCard } from "../../../src/components/ui/card.js";
import { Badge, type Tone } from "../../../src/components/ui/badge.js";
import { EmptyState, PermissionDenied } from "../../../src/components/ui/feedback.js";

const STATUS_FILTERS: ReadonlyArray<{ value: InvoiceStatus | "ALL"; label: string }> = [
  { value: "ALL", label: "All" },
  { value: "DRAFT", label: "Draft" },
  { value: "OPEN", label: "Open" },
  { value: "PAID", label: "Paid" },
  { value: "VOID", label: "Void" },
  { value: "UNCOLLECTIBLE", label: "Uncollectible" },
];

function formatMoney(cents: number, currency: string): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}${currency.toUpperCase()} ${(Math.abs(cents) / 100).toFixed(2)}`;
}

function statusTone(status: InvoiceStatus): Tone {
  switch (status) {
    case "PAID":
      return "success";
    case "OPEN":
      return "info";
    case "UNCOLLECTIBLE":
      return "danger";
    case "DRAFT":
    case "VOID":
    default:
      return "neutral";
  }
}

export default async function BillingListPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.BILLING_READ)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Finance" title="Billing" />
        <PermissionDenied grant="billing.read" />
      </div>
    );
  }

  const statusParam = typeof params["status"] === "string" ? params["status"] : "ALL";
  const status =
    statusParam !== "ALL" && STATUS_FILTERS.some((f) => f.value === statusParam)
      ? (statusParam as InvoiceStatus)
      : undefined;

  const result = await listInvoices({
    organizationId: session.tenancy.organizationId,
    ...(status !== undefined ? { status } : {}),
  });

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        eyebrow="Finance"
        title="Billing"
        description="Invoices for this organization. Open an invoice to finalize, credit, or refund."
      />

      <FilterTabs
        items={STATUS_FILTERS.map((f) => ({
          href: f.value === "ALL" ? "/ops/billing" : `/ops/billing?status=${f.value}`,
          label: f.label,
          active: (f.value === "ALL" && status === undefined) || f.value === status,
        }))}
      />

      {result.rows.length === 0 ? (
        <EmptyState icon="billing" title="No invoices match this filter" />
      ) : (
        <div className="space-y-2">
          {result.rows.map((row) => (
            <LinkCard
              key={row.invoiceId}
              href={`/ops/billing/${row.invoiceId}`}
              end={
                <div className="space-y-0.5">
                  <div className="font-mono text-base font-semibold text-fg tabular-nums">
                    {formatMoney(row.totalCents, row.currency)}
                  </div>
                  <div className="text-xs text-subtle">
                    Due {formatMoney(row.amountDueCents, row.currency)}
                  </div>
                </div>
              }
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm font-medium text-fg">{row.invoiceNumber}</span>
                <Badge tone={statusTone(row.status)}>{row.status}</Badge>
              </div>
              <div className="mt-1 text-xs text-subtle">
                {row.lineCount} line{row.lineCount === 1 ? "" : "s"} ·{" "}
                {row.dueAt !== null ? `due ${row.dueAt.toISOString().slice(0, 10)}` : "no due date"}
              </div>
            </LinkCard>
          ))}
        </div>
      )}
    </div>
  );
}
