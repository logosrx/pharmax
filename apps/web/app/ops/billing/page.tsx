// /ops/billing — invoice list for the operator's tenancy.
//
// Permission-gated on `billing.read` (the broadest billing
// permission; finer-grained actions are gated on the detail page).

import Link from "next/link";

import { type InvoiceStatus } from "@pharmax/database";
import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../src/server/auth/resolve-tenancy.js";
import { listInvoices } from "../../../src/server/ops/list-invoices.js";

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

function statusBadgeClass(status: InvoiceStatus): string {
  switch (status) {
    case "PAID":
      return "border-emerald-700 bg-emerald-950 text-emerald-200";
    case "OPEN":
      return "border-blue-700 bg-blue-950 text-blue-200";
    case "DRAFT":
      return "border-neutral-700 bg-neutral-900 text-neutral-300";
    case "VOID":
      return "border-neutral-700 bg-neutral-900 text-neutral-500";
    case "UNCOLLECTIBLE":
      return "border-red-700 bg-red-950 text-red-200";
    default:
      return "border-neutral-700 bg-neutral-900 text-neutral-300";
  }
}

export default async function BillingListPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null; // proxy handles redirect; layout already rendered error

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.BILLING_READ)) {
    return (
      <main className="space-y-3">
        <h1 className="text-2xl font-semibold text-neutral-50">Billing</h1>
        <p className="text-neutral-400">
          You don&apos;t have permission to view billing. Contact your admin to request the{" "}
          <code className="text-neutral-200">billing.read</code> grant.
        </p>
      </main>
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
    <main className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-neutral-50">Billing</h1>
        <p className="text-sm text-neutral-400">
          Invoices for this organization. Open an invoice to finalize, credit, or refund.
        </p>
      </header>

      <nav className="flex flex-wrap gap-2">
        {STATUS_FILTERS.map((f) => {
          const active = (f.value === "ALL" && status === undefined) || f.value === status;
          const href = f.value === "ALL" ? "/ops/billing" : `/ops/billing?status=${f.value}`;
          return (
            <Link
              key={f.value}
              href={href}
              className={`rounded-md border px-3 py-1.5 text-sm ${
                active
                  ? "border-neutral-500 bg-neutral-800 text-neutral-50"
                  : "border-neutral-800 bg-neutral-950 text-neutral-400 hover:bg-neutral-900"
              }`}
            >
              {f.label}
            </Link>
          );
        })}
      </nav>

      {result.rows.length === 0 ? (
        <div className="rounded-md border border-neutral-800 bg-neutral-950 p-6 text-sm text-neutral-400">
          No invoices match this filter.
        </div>
      ) : (
        <ul className="space-y-2">
          {result.rows.map((row) => (
            <li
              key={row.invoiceId}
              className="rounded-md border border-neutral-800 bg-neutral-950 p-4"
            >
              <Link
                href={`/ops/billing/${row.invoiceId}`}
                className="flex flex-wrap items-center justify-between gap-3"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm text-neutral-100">{row.invoiceNumber}</span>
                    <span
                      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs ${statusBadgeClass(
                        row.status
                      )}`}
                    >
                      {row.status}
                    </span>
                  </div>
                  <div className="text-xs text-neutral-500">
                    {row.lineCount} line{row.lineCount === 1 ? "" : "s"} ·{" "}
                    {row.dueAt !== null
                      ? `due ${row.dueAt.toISOString().slice(0, 10)}`
                      : "no due date"}
                  </div>
                </div>
                <div className="space-y-1 text-right">
                  <div className="font-mono text-sm text-neutral-100">
                    {formatMoney(row.totalCents, row.currency)}
                  </div>
                  <div className="text-xs text-neutral-500">
                    Due {formatMoney(row.amountDueCents, row.currency)}
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
