// /ops/orders/[orderId] — operator order-detail page.
//
// PHI surface: this page DECRYPTS patient identity, contact, and
// prescription `sig`. Gated on `orders.read` AND `patients.read`.
// Every render that displays PHI dispatches `ViewPatient` BEFORE
// rendering, writing a tamper-evident chain-hashed audit row in
// `audit_log` + emitting `patient.viewed.v1`. If the audit write
// fails, the page refuses to render the patient block (fail closed on
// the "every PHI display has an audit row" invariant).
//
// PHI rendering rule: every decrypted value renders inside a <dd>,
// "—" for null fields.

import Link from "next/link";

import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../src/server/auth/resolve-tenancy.js";
import { auditPatientView } from "../../../../src/server/ops/audit-patient-view.js";
import { getOrderDetail } from "../../../../src/server/ops/get-order-detail.js";
import { PageHeader, Section } from "../../../../src/components/ui/page.js";
import { Card, CardContent, CardHeader, CardTitle } from "../../../../src/components/ui/card.js";
import { Badge } from "../../../../src/components/ui/badge.js";
import { Banner, EmptyState } from "../../../../src/components/ui/feedback.js";
import { DataList, Table, THead, TH, TBody, TR, TD } from "../../../../src/components/ui/data.js";
import { buttonClass } from "../../../../src/components/ui/button.js";
import { Icon } from "../../../../src/components/ui/icon.js";
import { priorityMeta, statusMeta } from "../../../../src/components/ui/workflow.js";
import { StageTimeline } from "../../../../src/components/ops/stage-timeline.js";
import type { Tone } from "../../../../src/components/ui/badge.js";

function dash(value: string | null): string {
  return value ?? "—";
}
function formatDate(value: Date | null): string {
  return value === null ? "—" : value.toISOString().slice(0, 10);
}
function formatDateTime(value: Date): string {
  return value.toISOString().replace("T", " ").slice(0, 19) + "Z";
}
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}
function matchStrategyLabel(strategy: string): string {
  switch (strategy) {
    case "EXTERNAL_ORDER_NUMBER":
      return "Auto-matched";
    case "MANUAL_ORDER_ID":
      return "Resolved · order";
    case "MANUAL_PATIENT_ID":
      return "Resolved · patient";
    case "UNMATCHED":
      return "Unmatched";
    default:
      return strategy;
  }
}
function matchStrategyTone(strategy: string): Tone {
  switch (strategy) {
    case "MANUAL_ORDER_ID":
    case "MANUAL_PATIENT_ID":
      return "info";
    case "EXTERNAL_ORDER_NUMBER":
      return "success";
    default:
      return "neutral";
  }
}
function trackingSourceLabel(source: string | null): string {
  if (source === null) return "no tracking";
  switch (source) {
    case "MANUAL":
      return "manual tracking";
    case "ORDER":
      return "order shipment";
    case "TRACKING_EVENT":
      return "carrier event";
    default:
      return source;
  }
}
function formatAddress(p: {
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly postalCode: string | null;
}): string {
  const parts: string[] = [];
  if (p.addressLine1 !== null) parts.push(p.addressLine1);
  if (p.addressLine2 !== null) parts.push(p.addressLine2);
  const cityStateZip = [p.city, p.state, p.postalCode].filter((s) => s !== null).join(" ");
  if (cityStateZip.length > 0) parts.push(cityStateZip);
  return parts.length === 0 ? "—" : parts.join(", ");
}

function GuardPage({ grant }: { readonly grant: string }) {
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Order" title="Order detail" />
      <EmptyState
        icon="shield"
        title="You don't have access to this order"
        description={
          <>
            This is a PHI-decrypting surface. Ask your admin for the{" "}
            <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[11px] text-fg">
              {grant}
            </code>{" "}
            grant.
          </>
        }
      />
    </div>
  );
}

export default async function OrderDetailPage({
  params,
}: {
  readonly params: Promise<{ readonly orderId: string }>;
}) {
  const { orderId } = await params;
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.ORDERS_READ)) {
    return <GuardPage grant="orders.read" />;
  }
  // Order detail is a PHI-decrypting surface; without `patients.read`
  // we refuse the whole page rather than render a half-populated view.
  if (!hasOperatorPermission(permissions, PERMISSIONS.PATIENTS_READ)) {
    return <GuardPage grant="patients.read" />;
  }

  const detail = await getOrderDetail({
    organizationId: session.tenancy.organizationId,
    orderId,
  });

  if (detail === null) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Order" title="Order not found" />
        <EmptyState
          icon="unmatched"
          title="This order doesn't exist in your organization"
          action={
            <Link href="/ops/pv1" className={buttonClass({ variant: "secondary", size: "sm" })}>
              Back to PV1 queue
            </Link>
          }
        />
      </div>
    );
  }

  // Tamper-evident PHI-view audit. If this fails we refuse to render
  // the patient block: "every PHI display has an audit row" is a
  // load-bearing invariant.
  const audit = await auditPatientView({
    organizationId: session.tenancy.organizationId,
    operatorUserId: session.operator.userId,
    patientId: detail.patient.patientId,
    surface: "ORDER_DETAIL_PAGE",
    orderId: detail.orderId,
    phiDecryptErrors: detail.phiDecryptErrors,
  });
  if (!audit.ok) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Order" title="Order detail" />
        <Banner tone="danger" title="PHI display blocked — audit could not be recorded">
          We could not record a PHI-view audit for this render and have refused to display patient
          identity. Operational fault: <code>{audit.code}</code>. Refresh to retry, or contact your
          admin if this persists.
        </Banner>
        <Link href="/ops/pv1" className={buttonClass({ variant: "secondary", size: "sm" })}>
          Back to PV1 queue
        </Link>
      </div>
    );
  }

  const patientName =
    detail.patient.firstName !== null || detail.patient.lastName !== null
      ? [detail.patient.firstName, detail.patient.middleName, detail.patient.lastName]
          .filter((s) => s !== null && s.length > 0)
          .join(" ")
      : "—";

  const sm = statusMeta(detail.currentStatus);
  const pm = priorityMeta(detail.priority);

  return (
    <div className="space-y-6 animate-fade-in">
      <Link
        href="/ops/pv1"
        className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-fg"
      >
        <Icon name="arrowLeft" size={15} />
        Back to queues
      </Link>

      <PageHeader
        eyebrow={
          <span className="font-mono normal-case tracking-normal text-subtle">
            {detail.orderId}
          </span>
        }
        title={<span className="font-mono">{detail.externalOrderNumber ?? detail.orderId}</span>}
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={pm.tone}>{pm.label}</Badge>
            <Badge tone={sm.tone} dot>
              {sm.label}
            </Badge>
          </div>
        }
      />

      <Card>
        <CardContent>
          <StageTimeline status={detail.currentStatus} />
        </CardContent>
      </Card>

      {audit.output.wasShredded ? (
        <Banner tone="warning" title="Patient was crypto-shredded (right-to-be-forgotten)">
          Identity fields below are permanently unreadable — order metadata is preserved for audit
          history only. Your access attempt is recorded.
        </Banner>
      ) : null}

      {detail.phiDecryptErrors ? (
        <Banner tone="danger" title="One or more PHI fields failed to decrypt">
          Treat the patient view as INCOMPLETE; do not make clinical decisions on this record until
          the cause is investigated (KMS misconfig, envelope corruption, or stale data). Operator{" "}
          <code>{session.operator.userId}</code>.
        </Banner>
      ) : null}

      <Section title="Patient">
        <Card>
          <CardContent>
            <DataList
              columns={3}
              items={[
                { label: "Name", value: patientName },
                { label: "Date of birth", value: dash(detail.patient.dateOfBirth) },
                { label: "Phone", value: dash(detail.patient.phone) },
                { label: "Email", value: dash(detail.patient.email) },
                { label: "Address", value: formatAddress(detail.patient), span: 3 },
              ]}
            />
          </CardContent>
        </Card>
        <p className="text-xs text-subtle">
          Patient id <code className="text-muted">{detail.patient.patientId}</code>
        </p>
      </Section>

      <Section title="Prescription lines" count={detail.lines.length}>
        {detail.lines.length === 0 ? (
          <EmptyState icon="fill" title="No lines on this order" />
        ) : (
          <div className="space-y-3">
            {detail.lines.map((line, idx) => (
              <Card key={line.orderLineId}>
                <CardHeader>
                  <div>
                    <div className="text-[11px] font-medium uppercase tracking-wide text-subtle">
                      Line {idx + 1}
                    </div>
                    <CardTitle className="text-base">
                      {line.drugName}
                      {line.drugStrength !== null ? ` ${line.drugStrength}` : ""}
                      {line.drugForm !== null ? ` (${line.drugForm})` : ""}
                    </CardTitle>
                    <div className="mt-0.5 font-mono text-xs text-subtle">
                      Rx {line.rxNumber} · NDC {line.drugNdc}
                    </div>
                  </div>
                  <div className="text-right text-xs text-muted">
                    <div className="text-fg">
                      Qty <span className="font-semibold tabular-nums">{line.quantityToFill}</span>
                    </div>
                    <div>
                      {line.daysSupplyToFill} day supply · {line.refillsRemaining} refills left
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <DataList
                    columns={2}
                    items={[
                      { label: "Sig (directions)", value: dash(line.sig) },
                      {
                        label: "Prescriber",
                        value: (
                          <>
                            {line.prescriberName} ·{" "}
                            <span className="font-mono text-xs text-muted">
                              NPI {line.prescriberNpi}
                            </span>
                          </>
                        ),
                      },
                      {
                        label: "Lot",
                        value:
                          line.assignedLotNumber !== null
                            ? `${line.assignedLotNumber} (exp ${formatDate(line.assignedLotExpiry)})`
                            : "Not yet assigned",
                      },
                      {
                        label: "Vial label",
                        value:
                          line.vialLabelId !== null ? (
                            <code className="font-mono text-xs">{line.vialLabelId}</code>
                          ) : (
                            "Not yet printed"
                          ),
                      },
                    ]}
                  />
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </Section>

      <Section title="Package photos" count={detail.packagePhotos.length}>
        {detail.packagePhotos.length === 0 ? (
          <EmptyState
            icon="dock"
            title="No sealed-package photos yet"
            description="Captures taken at the dock and matched to this order appear here."
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {detail.packagePhotos.map((photo) => (
              <Card key={photo.photoId}>
                <CardContent className="space-y-2">
                  {/* Authenticated byte-proxy — a plain <img> is intentional:
                      next/image would route this private, per-request-authorized
                      image through the public optimizer, which we do not want. */}
                  <img
                    src={`/api/ops/shipping/package-photos/${photo.photoId}/image`}
                    alt="Sealed package"
                    loading="lazy"
                    className="max-h-56 w-full rounded-md border border-line bg-surface-2 object-contain"
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={matchStrategyTone(photo.matchStrategy)}>
                      {matchStrategyLabel(photo.matchStrategy)}
                    </Badge>
                    <span className="text-xs text-subtle">
                      Captured {formatDateTime(photo.capturedAt)}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle">
                    <span>
                      tracking: {trackingSourceLabel(photo.trackingSource)}
                      {photo.trackingNumber !== null ? (
                        <>
                          {" — "}
                          <code className="font-mono text-muted">{photo.trackingNumber}</code>
                        </>
                      ) : null}
                    </span>
                    <span>
                      {photo.contentType.replace("image/", "")} · {formatBytes(photo.fileSize)}
                    </span>
                    <span className="font-mono">sha {photo.sha256.slice(0, 8)}…</span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </Section>

      <Section title="Recent events" count={detail.events.length}>
        {detail.events.length === 0 ? (
          <EmptyState icon="history" title="No events recorded yet" />
        ) : (
          <Table>
            <THead>
              <TH>Event</TH>
              <TH>Actor</TH>
              <TH align="right">Seq</TH>
              <TH align="right">When</TH>
            </THead>
            <TBody>
              {detail.events.map((evt) => (
                <TR key={evt.orderEventId}>
                  <TD>
                    <span className="font-mono text-xs text-fg">{evt.eventType}</span>
                  </TD>
                  <TD>
                    {evt.actorUserId !== null ? (
                      <code className="text-xs text-muted">{evt.actorUserId}</code>
                    ) : (
                      <span className="text-subtle">system</span>
                    )}
                  </TD>
                  <TD align="right">
                    <span className="tabular-nums text-muted">{evt.sequenceNumber}</span>
                  </TD>
                  <TD align="right">
                    <span className="font-mono text-xs text-muted">
                      {formatDateTime(evt.occurredAt)}
                    </span>
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
