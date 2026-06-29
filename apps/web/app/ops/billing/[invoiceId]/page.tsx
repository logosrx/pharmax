// /ops/billing/[invoiceId] — invoice detail with action forms.
//
// Renders the invoice + lines, then surfaces the action forms
// available given the invoice's status and the operator's
// permissions (finalize / credit / refund).

import Link from "next/link";

import { CREDIT_INVOICE_KINDS } from "@pharmax/billing";
import { type InvoiceStatus } from "@pharmax/database";
import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../src/server/auth/resolve-tenancy.js";
import { getInvoiceDetail } from "../../../../src/server/ops/list-invoices.js";
import { PageHeader, Section } from "../../../../src/components/ui/page.js";
import { Card, CardContent, CardHeader, CardTitle } from "../../../../src/components/ui/card.js";
import { Badge, type Tone } from "../../../../src/components/ui/badge.js";
import { EmptyState, PermissionDenied } from "../../../../src/components/ui/feedback.js";
import { Stat, Table, THead, TH, TBody, TR, TD } from "../../../../src/components/ui/data.js";
import { Field, Input, Select } from "../../../../src/components/ui/field.js";
import { buttonClass } from "../../../../src/components/ui/button.js";
import { Icon } from "../../../../src/components/ui/icon.js";
import { QueueFlash } from "../../../../src/components/ops/flash.js";
import { ActionForm, SubmitButton } from "../../../../src/components/ops/action-form.js";

const REFUND_REASONS = [
  { value: "requested_by_customer", label: "Requested by customer" },
  { value: "duplicate", label: "Duplicate charge" },
  { value: "fraudulent", label: "Fraudulent" },
];

const FLASH_MESSAGES: Readonly<Record<string, string>> = {
  finalized: "Invoice finalized (DRAFT → OPEN).",
  credited: "Credit line applied.",
  refunded: "Refund issued via Stripe.",
};

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
    default:
      return "neutral";
  }
}

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
      <div className="space-y-6">
        <PageHeader eyebrow="Finance" title="Billing" />
        <PermissionDenied grant="billing.read" />
      </div>
    );
  }

  const invoice = await getInvoiceDetail({
    organizationId: session.tenancy.organizationId,
    invoiceId,
  });

  if (invoice === null) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Finance" title="Invoice not found" />
        <EmptyState
          icon="billing"
          title="This invoice doesn't exist in your organization"
          action={
            <Link href="/ops/billing" className={buttonClass({ variant: "secondary", size: "sm" })}>
              Back to billing
            </Link>
          }
        />
      </div>
    );
  }

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
    <div className="space-y-6 animate-fade-in">
      <Link
        href="/ops/billing"
        className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-fg"
      >
        <Icon name="arrowLeft" size={15} />
        Back to billing
      </Link>

      <PageHeader
        eyebrow={
          <span className="normal-case tracking-normal text-subtle">
            Clinic <code>{invoice.clinicId}</code>
            {invoice.stripeInvoiceId !== null ? (
              <>
                {" · "}Stripe <code>{invoice.stripeInvoiceId}</code>
              </>
            ) : null}
          </span>
        }
        title={<span className="font-mono">{invoice.invoiceNumber}</span>}
        actions={
          <Badge tone={statusTone(invoice.status)} dot>
            {invoice.status}
          </Badge>
        }
      />

      <QueueFlash params={search} messages={FLASH_MESSAGES} />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Subtotal" value={formatMoney(invoice.subtotalCents, invoice.currency)} />
        <Stat
          label="Total"
          value={formatMoney(invoice.totalCents, invoice.currency)}
          tone="brand"
        />
        <Stat
          label="Paid"
          value={formatMoney(invoice.amountPaidCents, invoice.currency)}
          tone="success"
        />
        <Stat
          label="Due"
          value={formatMoney(invoice.amountDueCents, invoice.currency)}
          tone={invoice.amountDueCents > 0 ? "warning" : "neutral"}
        />
      </div>

      <Section title="Lines" count={invoice.lines.length}>
        {invoice.lines.length === 0 ? (
          <EmptyState icon="billing" title="No lines yet" />
        ) : (
          <Table>
            <THead>
              <TH>Description</TH>
              <TH>Kind</TH>
              <TH align="right">Qty</TH>
              <TH align="right">Amount</TH>
            </THead>
            <TBody>
              {invoice.lines.map((l) => (
                <TR key={l.invoiceLineId}>
                  <TD>
                    <div className="text-fg">{l.description}</div>
                    {l.orderId !== null ? (
                      <code className="text-xs text-subtle">order {l.orderId}</code>
                    ) : null}
                  </TD>
                  <TD>
                    <Badge tone="neutral">{l.kind}</Badge>
                  </TD>
                  <TD align="right">{l.quantity}</TD>
                  <TD align="right">
                    <span
                      className={`font-mono ${l.amountCents < 0 ? "text-emerald-300" : "text-fg"}`}
                    >
                      {formatMoney(l.amountCents, invoice.currency)}
                    </span>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Section>

      <Section title="Actions">
        {!canFinalize && !canCredit && !canRefund ? (
          <EmptyState
            icon="shield"
            title="No actions available"
            description="Nothing can be actioned given this invoice's status and your permissions."
          />
        ) : (
          <div className="space-y-3">
            {canFinalize ? (
              <Card>
                <CardHeader>
                  <CardTitle>Finalize · DRAFT → OPEN</CardTitle>
                </CardHeader>
                <CardContent>
                  <ActionForm
                    action={`/api/ops/billing/invoices/${invoice.invoiceId}/finalize`}
                    className="flex flex-wrap items-end gap-2"
                  >
                    <Field label="Days until due">
                      <Input
                        type="number"
                        name="daysUntilDue"
                        min={0}
                        max={365}
                        defaultValue={30}
                        className="w-28"
                      />
                    </Field>
                    <SubmitButton icon="check">Finalize</SubmitButton>
                  </ActionForm>
                </CardContent>
              </Card>
            ) : null}

            {canCredit ? (
              <Card>
                <CardHeader>
                  <CardTitle>Apply credit / discount / adjustment</CardTitle>
                </CardHeader>
                <CardContent>
                  <ActionForm
                    action={`/api/ops/billing/invoices/${invoice.invoiceId}/credit`}
                    className="grid grid-cols-1 gap-3 sm:grid-cols-2"
                  >
                    <Field label="Kind">
                      <Select name="kind" defaultValue="CREDIT">
                        {CREDIT_INVOICE_KINDS.map((k) => (
                          <option key={k} value={k}>
                            {k}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Amount (cents)" required>
                      <Input type="number" name="amountCents" min={1} required placeholder="2500" />
                    </Field>
                    <Field label="Description" required className="sm:col-span-2">
                      <Input
                        type="text"
                        name="description"
                        maxLength={500}
                        required
                        placeholder="Goodwill credit"
                      />
                    </Field>
                    <Field label="Operator note" className="sm:col-span-2">
                      <Input
                        type="text"
                        name="reasonText"
                        maxLength={2000}
                        placeholder="optional"
                      />
                    </Field>
                    <div className="sm:col-span-2">
                      <SubmitButton variant="secondary" icon="billing">
                        Apply credit
                      </SubmitButton>
                    </div>
                  </ActionForm>
                </CardContent>
              </Card>
            ) : null}

            {canRefund ? (
              <Card>
                <CardHeader>
                  <CardTitle>Issue Stripe refund</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <ActionForm
                    action={`/api/ops/billing/invoices/${invoice.invoiceId}/refund`}
                    confirm="Issue this refund via Stripe? This cannot be undone."
                    className="grid grid-cols-1 gap-3 sm:grid-cols-2"
                  >
                    <Field label="Amount (cents)" required>
                      <Input
                        type="number"
                        name="amountCents"
                        min={1}
                        max={invoice.amountPaidCents}
                        required
                      />
                    </Field>
                    <Field label="Reason">
                      <Select name="reason" defaultValue="requested_by_customer">
                        {REFUND_REASONS.map((r) => (
                          <option key={r.value} value={r.value}>
                            {r.label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Operator note" className="sm:col-span-2">
                      <Input
                        type="text"
                        name="operatorNote"
                        maxLength={2000}
                        placeholder="optional"
                      />
                    </Field>
                    <div className="sm:col-span-2">
                      <SubmitButton variant="danger" icon="billing">
                        Issue refund
                      </SubmitButton>
                    </div>
                  </ActionForm>
                  <p className="text-xs text-subtle">
                    Stripe charge: <code>{invoice.stripeChargeId}</code>
                  </p>
                </CardContent>
              </Card>
            ) : null}
          </div>
        )}
      </Section>
    </div>
  );
}
