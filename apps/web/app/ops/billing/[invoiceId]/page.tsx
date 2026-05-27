// /ops/billing/[invoiceId] — invoice detail with action forms.
//
// Renders the invoice + its lines, then shows action forms for
// each operator action available given (a) the invoice's status
// and (b) the operator's permissions.

import Link from "next/link";

import { CREDIT_INVOICE_KINDS } from "@pharmax/billing";
import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../src/server/auth/resolve-tenancy.js";
import { getInvoiceDetail } from "../../../../src/server/ops/list-invoices.js";

const REFUND_REASONS = [
  { value: "requested_by_customer", label: "Requested by customer" },
  { value: "duplicate", label: "Duplicate charge" },
  { value: "fraudulent", label: "Fraudulent" },
];

function formatMoney(cents: number, currency: string): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}${currency.toUpperCase()} ${(Math.abs(cents) / 100).toFixed(2)}`;
}

const FLASH_MESSAGES: Readonly<Record<string, string>> = {
  finalized: "Invoice finalized (DRAFT → OPEN).",
  credited: "Credit line applied.",
  refunded: "Refund issued via Stripe.",
};

export default async function InvoiceDetailPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly invoiceId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ invoiceId }, search] = await Promise.all([params, searchParams]);
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.BILLING_READ)) {
    return (
      <main className="space-y-3">
        <h1 className="text-2xl font-semibold text-neutral-50">Billing</h1>
        <p className="text-neutral-400">You don&apos;t have permission to view billing.</p>
      </main>
    );
  }

  const invoice = await getInvoiceDetail({
    organizationId: session.tenancy.organizationId,
    invoiceId,
  });

  if (invoice === null) {
    return (
      <main className="space-y-3">
        <h1 className="text-2xl font-semibold text-neutral-50">Invoice not found</h1>
        <p className="text-neutral-400">
          This invoice doesn&apos;t exist in your organization.{" "}
          <Link href="/ops/billing" className="text-blue-400 hover:underline">
            Back to billing
          </Link>
        </p>
      </main>
    );
  }

  const flash = typeof search["flash"] === "string" ? search["flash"] : null;
  const flashError = typeof search["error"] === "string" ? search["error"] : null;

  const canFinalize =
    invoice.status === "DRAFT" &&
    hasOperatorPermission(permissions, PERMISSIONS.BILLING_FINALIZE_INVOICE);
  const canCredit =
    invoice.status !== "VOID" &&
    hasOperatorPermission(permissions, PERMISSIONS.BILLING_CREDIT_INVOICE);
  const canRefund =
    invoice.status === "PAID" &&
    invoice.stripeChargeId !== null &&
    hasOperatorPermission(permissions, PERMISSIONS.BILLING_ISSUE_REFUND);

  return (
    <main className="space-y-6">
      <div>
        <Link href="/ops/billing" className="text-sm text-blue-400 hover:underline">
          ← Back to billing
        </Link>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="font-mono text-2xl font-semibold text-neutral-50">
            {invoice.invoiceNumber}
          </h1>
          <p className="text-xs text-neutral-500">
            Clinic <code className="text-neutral-300">{invoice.clinicId}</code>
            {invoice.stripeInvoiceId !== null ? (
              <>
                {" · "}Stripe <code className="text-neutral-300">{invoice.stripeInvoiceId}</code>
              </>
            ) : null}
          </p>
        </div>
        <div className="space-y-1 text-right">
          <div className="font-mono text-2xl text-neutral-50">
            {formatMoney(invoice.totalCents, invoice.currency)}
          </div>
          <div className="text-xs text-neutral-500">
            Status <span className="text-neutral-300">{invoice.status}</span>
          </div>
        </div>
      </header>

      {flash !== null && FLASH_MESSAGES[flash] !== undefined ? (
        <div className="rounded-md border border-emerald-700 bg-emerald-950 px-4 py-3 text-sm text-emerald-200">
          {FLASH_MESSAGES[flash]}
        </div>
      ) : null}
      {flashError !== null ? (
        <div className="rounded-md border border-red-700 bg-red-950 px-4 py-3 text-sm text-red-200">
          {flashError}
        </div>
      ) : null}

      <section className="grid grid-cols-1 gap-3 rounded-md border border-neutral-800 bg-neutral-950 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <div className="text-xs text-neutral-500">Subtotal</div>
          <div className="font-mono text-sm text-neutral-100">
            {formatMoney(invoice.subtotalCents, invoice.currency)}
          </div>
        </div>
        <div>
          <div className="text-xs text-neutral-500">Total</div>
          <div className="font-mono text-sm text-neutral-100">
            {formatMoney(invoice.totalCents, invoice.currency)}
          </div>
        </div>
        <div>
          <div className="text-xs text-neutral-500">Paid</div>
          <div className="font-mono text-sm text-neutral-100">
            {formatMoney(invoice.amountPaidCents, invoice.currency)}
          </div>
        </div>
        <div>
          <div className="text-xs text-neutral-500">Due</div>
          <div className="font-mono text-sm text-neutral-100">
            {formatMoney(invoice.amountDueCents, invoice.currency)}
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-400">Lines</h2>
        {invoice.lines.length === 0 ? (
          <div className="rounded-md border border-neutral-800 bg-neutral-950 p-4 text-sm text-neutral-500">
            No lines yet.
          </div>
        ) : (
          <ul className="divide-y divide-neutral-800 overflow-hidden rounded-md border border-neutral-800 bg-neutral-950">
            {invoice.lines.map((l) => (
              <li
                key={l.invoiceLineId}
                className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
              >
                <div>
                  <div className="text-neutral-100">{l.description}</div>
                  <div className="text-xs text-neutral-500">
                    {l.kind} · qty {l.quantity}
                    {l.orderId !== null ? (
                      <>
                        {" · order "}
                        <code className="text-neutral-300">{l.orderId}</code>
                      </>
                    ) : null}
                  </div>
                </div>
                <div
                  className={`font-mono text-sm ${
                    l.amountCents < 0 ? "text-emerald-300" : "text-neutral-100"
                  }`}
                >
                  {formatMoney(l.amountCents, invoice.currency)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-400">Actions</h2>

        {!canFinalize && !canCredit && !canRefund ? (
          <p className="text-sm text-neutral-500">
            No actions available given this invoice&apos;s status and your permissions.
          </p>
        ) : null}

        {canFinalize ? (
          <form
            action={`/api/ops/billing/invoices/${invoice.invoiceId}/finalize`}
            method="POST"
            className="space-y-2 rounded-md border border-neutral-800 bg-neutral-950 p-4"
          >
            <div className="text-sm text-neutral-200">Finalize (DRAFT → OPEN)</div>
            <div className="flex flex-wrap items-end gap-2">
              <label className="text-xs text-neutral-500">
                Days until due
                <input
                  type="number"
                  name="daysUntilDue"
                  min={0}
                  max={365}
                  defaultValue={30}
                  className="ml-2 w-20 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-100"
                />
              </label>
              <button
                type="submit"
                className="rounded-md border border-blue-700 bg-blue-900 px-3 py-1.5 text-sm text-blue-100 hover:bg-blue-800"
              >
                Finalize
              </button>
            </div>
          </form>
        ) : null}

        {canCredit ? (
          <form
            action={`/api/ops/billing/invoices/${invoice.invoiceId}/credit`}
            method="POST"
            className="space-y-2 rounded-md border border-neutral-800 bg-neutral-950 p-4"
          >
            <div className="text-sm text-neutral-200">Apply credit / discount / adjustment</div>
            <div className="flex flex-wrap items-end gap-2">
              <select
                name="kind"
                defaultValue="CREDIT"
                className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-100"
              >
                {CREDIT_INVOICE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
              <input
                type="number"
                name="amountCents"
                placeholder="amount (cents)"
                min={1}
                className="w-32 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-100"
                required
              />
              <input
                type="text"
                name="description"
                placeholder="description (required)"
                maxLength={500}
                className="min-w-[16rem] flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-100"
                required
              />
              <input
                type="text"
                name="reasonText"
                placeholder="operator note (optional)"
                maxLength={2000}
                className="min-w-[12rem] flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-100"
              />
              <button
                type="submit"
                className="rounded-md border border-amber-700 bg-amber-900 px-3 py-1.5 text-sm text-amber-100 hover:bg-amber-800"
              >
                Apply credit
              </button>
            </div>
          </form>
        ) : null}

        {canRefund ? (
          <form
            action={`/api/ops/billing/invoices/${invoice.invoiceId}/refund`}
            method="POST"
            className="space-y-2 rounded-md border border-neutral-800 bg-neutral-950 p-4"
          >
            <div className="text-sm text-neutral-200">Issue Stripe refund</div>
            <div className="flex flex-wrap items-end gap-2">
              <input
                type="number"
                name="amountCents"
                placeholder="amount (cents)"
                min={1}
                max={invoice.amountPaidCents}
                className="w-32 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-100"
                required
              />
              <select
                name="reason"
                defaultValue="requested_by_customer"
                className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-100"
              >
                {REFUND_REASONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
              <input
                type="text"
                name="operatorNote"
                placeholder="operator note (optional)"
                maxLength={2000}
                className="min-w-[12rem] flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-100"
              />
              <button
                type="submit"
                className="rounded-md border border-red-700 bg-red-900 px-3 py-1.5 text-sm text-red-100 hover:bg-red-800"
              >
                Issue refund
              </button>
            </div>
            <p className="text-xs text-neutral-500">
              Stripe charge: <code className="text-neutral-300">{invoice.stripeChargeId}</code>
            </p>
          </form>
        ) : null}
      </section>
    </main>
  );
}
