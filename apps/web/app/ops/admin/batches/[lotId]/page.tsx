// /ops/admin/batches/[lotId] — lot chain-of-custody (recall view).
//
// One lot, door to patient-facing order, PHI-safe (identifiers
// only): DSCSA receipts, the inventory ledger, dispensing
// assignments, and compounding-ingredient consumptions — the
// `getLotChainOfCustody` read from @pharmax/inventory (ADR-0035
// slice 3). This is the page a recall response starts from.
//
// Permission gate: `inventory.read`. Read-only; receiving happens on
// /ops/admin/batches/receive, everything else through the fill and
// compounding workflow commands.

import Link from "next/link";

import type { PrismaTxClient } from "@pharmax/command-bus";
import { readInOrgScope } from "@pharmax/database";
import { getLotChainOfCustody, type LotChainOfCustody } from "@pharmax/inventory";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../../src/server/auth/resolve-tenancy.js";
import { PageHeader, Section } from "../../../../../src/components/ui/page.js";
import { Table, THead, TH, TBody, TR, TD } from "../../../../../src/components/ui/data.js";
import { Badge, type Tone } from "../../../../../src/components/ui/badge.js";
import { Banner, EmptyState, PermissionDenied } from "../../../../../src/components/ui/feedback.js";
import { buttonClass } from "../../../../../src/components/ui/button.js";
import { Icon } from "../../../../../src/components/ui/icon.js";

const STATUS_TONES: Record<string, Tone> = {
  ACTIVE: "success",
  ON_HOLD: "warning",
  DEPLETED: "neutral",
};

function formatDay(iso: string): string {
  return iso.slice(0, 10);
}

export default async function LotChainOfCustodyPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly lotId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ lotId }, sp] = await Promise.all([params, searchParams]);
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.INVENTORY_READ)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Directory" title="Lot custody" />
        <PermissionDenied grant="inventory.read" />
      </div>
    );
  }

  let custody: LotChainOfCustody | null = null;
  try {
    custody = await readInOrgScope(session.tenancy.organizationId, (tx) =>
      getLotChainOfCustody({
        // The scoped-read client is the same interactive-transaction
        // shape minus lifecycle methods; the custody read only issues
        // findFirst/findMany.
        tx: tx as unknown as PrismaTxClient,
        organizationId: session.tenancy.organizationId,
        lotId,
      })
    );
  } catch (cause) {
    if (!(cause instanceof errors.NotFoundError)) throw cause;
  }

  if (custody === null) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Directory" title="Lot not found" />
        <EmptyState
          icon="batches"
          title="This lot doesn't exist in your organization"
          action={
            <Link
              href="/ops/admin/batches"
              className={buttonClass({ variant: "secondary", size: "sm" })}
            >
              Back to batches
            </Link>
          }
        />
      </div>
    );
  }

  const flash = typeof sp["flash"] === "string" ? sp["flash"] : null;
  const expired = new Date(custody.lot.expirationDate).getTime() < Date.now();

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
        eyebrow="Chain of custody"
        title={<span className="font-mono">{custody.lot.lotNumber}</span>}
        description="Door to order, PHI-safe: DSCSA receipts, ledger movements, dispensing assignments, and compounding consumptions for this lot."
        actions={
          <div className="flex items-center gap-1.5">
            <Badge tone={STATUS_TONES[custody.lot.status] ?? "neutral"}>
              {custody.lot.status.replace("_", " ")}
            </Badge>
            {expired ? <Badge tone="danger">EXPIRED</Badge> : null}
          </div>
        }
      />

      {flash !== null ? <Banner tone="success">{flash}</Banner> : null}

      <div className="text-sm text-muted">
        Expires <span className="font-mono">{formatDay(custody.lot.expirationDate)}</span> · product{" "}
        <Link
          href={`/ops/admin/batches?productId=${custody.lot.productId}`}
          className="text-brand hover:underline"
        >
          view sibling lots
        </Link>
      </div>

      <Section title="DSCSA receipts" count={custody.receipts.length}>
        {custody.receipts.length === 0 ? (
          <EmptyState
            icon="batches"
            title="No receipts recorded for this lot"
            description="DSCSA receiving records appear here when the lot is received against a transaction document."
          />
        ) : (
          <Table>
            <THead>
              <TH>Transaction date</TH>
              <TH>Seller</TH>
              <TH>Quantity</TH>
              <TH>Containers</TH>
              <TH>Source doc</TH>
              <TH>Received by</TH>
            </THead>
            <TBody>
              {custody.receipts.map((r) => (
                <TR key={r.dscsaTransactionId}>
                  <TD className="font-mono text-xs">
                    {formatDay(r.transactionDate)}
                    {r.shipmentDate !== null ? (
                      <span className="text-subtle"> (shipped {formatDay(r.shipmentDate)})</span>
                    ) : null}
                  </TD>
                  <TD>{r.sellerName}</TD>
                  <TD className="font-mono text-xs">{r.quantity}</TD>
                  <TD className="font-mono text-xs">{r.containerCount}</TD>
                  <TD className="font-mono text-xs">{r.sourceDocumentRef ?? "—"}</TD>
                  <TD className="font-mono text-xs">{r.receivedByUserId}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Section>

      <Section title="Inventory ledger" count={custody.ledger.length}>
        {custody.ledger.length === 0 ? (
          <EmptyState
            icon="batches"
            title="No ledger movements yet"
            description="Every receipt, assignment, and adjustment posts a movement here — the trail starts with the first transaction."
          />
        ) : (
          <Table>
            <THead>
              <TH>When</TH>
              <TH>Reason</TH>
              <TH>Δ Quantity</TH>
              <TH>Order line</TH>
            </THead>
            <TBody>
              {custody.ledger.map((m) => (
                <TR key={m.id}>
                  <TD className="font-mono text-xs">
                    {m.occurredAt.slice(0, 16).replace("T", " ")}
                  </TD>
                  <TD>
                    <Badge tone={m.quantityDelta.startsWith("-") ? "warning" : "success"}>
                      {m.reason.replace(/_/g, " ")}
                    </Badge>
                  </TD>
                  <TD className="font-mono text-xs">{m.quantityDelta}</TD>
                  <TD className="font-mono text-xs">{m.orderLineId ?? "—"}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Section>

      <Section title="Dispensed to order lines" count={custody.dispensed.length}>
        {custody.dispensed.length === 0 ? (
          <EmptyState
            icon="batches"
            title="Never assigned to an order line"
            description="Assignments appear here when the fill bench dispenses from this lot."
          />
        ) : (
          <Table>
            <THead>
              <TH>Assigned at</TH>
              <TH>Order</TH>
              <TH>Order line</TH>
              <TH>Assigned by</TH>
            </THead>
            <TBody>
              {custody.dispensed.map((d) => (
                <TR key={d.lotAssignmentId}>
                  <TD className="font-mono text-xs">
                    {d.assignedAt.slice(0, 16).replace("T", " ")}
                  </TD>
                  <TD>
                    <Link
                      href={`/ops/orders/${d.orderId}`}
                      className="font-mono text-xs text-brand hover:underline"
                    >
                      {d.orderId}
                    </Link>
                  </TD>
                  <TD className="font-mono text-xs">{d.orderLineId}</TD>
                  <TD className="font-mono text-xs">{d.assignedByUserId}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Section>

      <Section title="Consumed by compounded preparations" count={custody.compounded.length}>
        {custody.compounded.length === 0 ? (
          <EmptyState
            icon="batches"
            title="Never consumed as a compounding ingredient"
            description="Usage appears here when a compounding formula draws on this lot during preparation."
          />
        ) : (
          <Table>
            <THead>
              <TH>Prepared at</TH>
              <TH>Formula</TH>
              <TH>Quantity used</TH>
              <TH>Order</TH>
            </THead>
            <TBody>
              {custody.compounded.map((c) => (
                <TR key={`${c.compoundingRecordId}:${c.orderLineId}`}>
                  <TD className="font-mono text-xs">
                    {c.preparedAt.slice(0, 16).replace("T", " ")}
                  </TD>
                  <TD>
                    <span className="font-mono text-xs">{c.formulaCode}</span> v{c.formulaVersion}
                  </TD>
                  <TD className="font-mono text-xs">{c.quantity}</TD>
                  <TD>
                    <Link
                      href={`/ops/orders/${c.orderId}`}
                      className="font-mono text-xs text-brand hover:underline"
                    >
                      {c.orderId}
                    </Link>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Section>
    </div>
  );
}
