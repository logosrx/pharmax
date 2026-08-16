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
//
// This is also the PV1 clinical-screening review surface. The findings
// panel sits directly under the prescription lines, because a finding
// is a claim about a drug ("no drug knowledge is available for
// <NDC>") and the pharmacist has to have the drug, strength and sig in
// front of them to judge it. It is the only place an acknowledgement
// can be recorded; see `screening-findings-panel.tsx`.

import Link from "next/link";
import { redirect } from "next/navigation";

import { OrderStatus } from "@pharmax/database";
import { PERMISSIONS } from "@pharmax/rbac";
import { screenedFindingsDigest } from "@pharmax/verification";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../src/server/auth/resolve-tenancy.js";
import { auditPatientView } from "../../../../src/server/ops/audit-patient-view.js";
import { getOrderDetail } from "../../../../src/server/ops/get-order-detail.js";
import { getOrderScreening } from "../../../../src/server/ops/get-order-screening.js";
import { getPatientAllergies } from "../../../../src/server/ops/get-patient-allergies.js";
import { PatientAllergyPanel } from "../../../../src/components/ops/patient-allergy-panel.js";
import { resolveOrderSearchToken } from "../../../../src/server/ops/resolve-order-search-token.js";
import { PageHeader, Section } from "../../../../src/components/ui/page.js";
import { Card, CardContent, CardHeader, CardTitle } from "../../../../src/components/ui/card.js";
import { Badge } from "../../../../src/components/ui/badge.js";
import { Banner, EmptyState } from "../../../../src/components/ui/feedback.js";
import { DataList, Table, THead, TH, TBody, TR, TD } from "../../../../src/components/ui/data.js";
import { buttonClass } from "../../../../src/components/ui/button.js";
import { Icon } from "../../../../src/components/ui/icon.js";
import { priorityMeta, statusMeta } from "../../../../src/components/ui/workflow.js";
import { QueueFlash } from "../../../../src/components/ops/flash.js";
import { CompoundCoveragePanel } from "../../../../src/components/ops/compound-coverage-panel.js";
import { describePv1ScreeningError } from "../../../../src/components/ops/pv1-screening-errors.js";
import { Pv1DecisionPanel } from "../../../../src/components/ops/pv1-decision-panel.js";
import {
  ScreeningFindingsPanel,
  type AcknowledgeGate,
} from "../../../../src/components/ops/screening-findings-panel.js";
import { StageTimeline } from "../../../../src/components/ops/stage-timeline.js";
import type { Tone } from "../../../../src/components/ui/badge.js";

const ORDER_FLASH: Readonly<Record<string, string>> = {
  screening_acknowledged: "Screening finding acknowledged — recorded against your user.",
  screening_already_acknowledged: "You had already acknowledged that finding; nothing changed.",
};

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
/** "2d 4.5h" / "7.2h" / "45m" — operator-readable transit duration. */
function formatDuration(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const hours = seconds / 3600;
  if (hours < 24) return `${(Math.round(hours * 10) / 10).toString()}h`;
  const days = Math.floor(hours / 24);
  const remHours = Math.round((hours - days * 24) * 10) / 10;
  return remHours === 0 ? `${days}d` : `${days}d ${remHours}h`;
}
function shipmentStatusTone(status: string): Tone {
  switch (status) {
    case "DELIVERED":
      return "success";
    case "EXCEPTION":
    case "RETURN_TO_SENDER":
    case "FAILED_DELIVERY":
      return "danger";
    case "IN_TRANSIT":
    case "OUT_FOR_DELIVERY":
      return "info";
    default:
      return "neutral";
  }
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
            <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-2xs text-fg">
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
  searchParams,
}: {
  readonly params: Promise<{ readonly orderId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orderId } = await params;
  const query = await searchParams;
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

  // The route param may be an internal UUID, an external order
  // number (typed by the operator), or a scanned vial barcode
  // (`PX:<orderLineId>`) — the topbar search routes all three here.
  // Resolve to the canonical order id and redirect so the URL in
  // the address bar is always the internal id.
  const resolved = await resolveOrderSearchToken({
    organizationId: session.tenancy.organizationId,
    token: orderId,
  });
  if (resolved.kind === "order-id" && resolved.orderId !== orderId) {
    redirect(`/ops/orders/${resolved.orderId}`);
  }

  const detail =
    resolved.kind === "not-found"
      ? null
      : await getOrderDetail({
          organizationId: session.tenancy.organizationId,
          orderId: resolved.orderId,
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

  // The findings the GATE will evaluate, read from the persisted rows
  // and scoped to this operator's own acknowledgements.
  const screening = await getOrderScreening({
    organizationId: session.tenancy.organizationId,
    orderId: detail.orderId,
    pharmacistUserId: session.operator.userId,
  });

  // The allergy profile, beside the prescription it matters for.
  //
  // NOT a duplicate of the screening panel, and the difference is the
  // point. The screening panel says what the ENGINE concluded; with no
  // licensed drug-knowledge source wired it concludes almost nothing,
  // because it cannot resolve an NDC to its ingredients. This panel is
  // the input, rendered so a pharmacist can do the comparison the engine
  // cannot — which for an uncoded allergen is the only comparison there
  // will ever be. Read-only here: capture belongs on the patient record,
  // not mid-verification.
  const allergyProfile = hasOperatorPermission(permissions, PERMISSIONS.PATIENTS_ALLERGIES_READ)
    ? await getPatientAllergies({
        organizationId: session.tenancy.organizationId,
        patientId: detail.patient.patientId,
      })
    : null;

  // UI convenience only — `AcknowledgePV1ScreeningFinding` re-checks
  // both the permission and the order's stage, and it is the control.
  const acknowledgeGate: AcknowledgeGate = !hasOperatorPermission(
    permissions,
    PERMISSIONS.PV1_APPROVE
  )
    ? { kind: "NO_PERMISSION" }
    : detail.currentStatus !== OrderStatus.PV1_IN_PROGRESS
      ? { kind: "REVIEW_CLOSED" }
      : { kind: "OPEN" };

  const screeningError = describePv1ScreeningError(
    typeof query["error"] === "string" ? query["error"] : null
  );
  const flashParams = screeningError === null ? query : { ...query, error: undefined };

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

      <QueueFlash params={flashParams} messages={ORDER_FLASH} />

      {screeningError !== null ? (
        <Banner tone={screeningError.tone} title={screeningError.title}>
          {screeningError.guidance}
          <p className="mt-2 text-xs opacity-80">
            Refusal code <code>{screeningError.code}</code>
          </p>
        </Banner>
      ) : null}

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
          <EmptyState
            icon="fill"
            title="No lines on this order"
            description="Typing adds prescription lines — an order can't advance to PV1 without at least one."
          />
        ) : (
          <div className="space-y-3">
            {detail.lines.map((line, idx) => (
              <Card key={line.orderLineId}>
                <CardHeader>
                  <div>
                    <div className="text-2xs font-medium uppercase tracking-wide text-subtle">
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
                  {/* Compound screening coverage, per recipe row.
                      Extracted so the badge wiring is render-tested;
                      see the component header for why that matters. */}
                  {line.compound === null ? null : (
                    <CompoundCoveragePanel compound={line.compound} />
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </Section>

      {/* ABOVE the findings panel, deliberately. The findings panel is
          where a pharmacist signs; the allergy list is what they should
          have read before signing. Ordering it after would put the
          control before the evidence. */}
      {allergyProfile === null ? null : (
        <PatientAllergyPanel
          profile={allergyProfile}
          // Read-only at PV1. Capture is intake work and belongs on the
          // patient record; a form here would invite a pharmacist to
          // enter a history they are taking from the prescription in
          // front of them rather than from the patient.
          capabilities={{ canRecord: false, canAmendStatus: false }}
          actionBase={`/api/ops/admin/patients/${detail.patient.patientId}`}
          title="Patient allergies (verification input)"
          footnote={
            <p className="text-xs text-subtle">
              To record or correct an allergy, open the{" "}
              <Link
                href={`/ops/admin/patients/${detail.patient.patientId}`}
                className="underline hover:text-fg"
              >
                patient record
              </Link>
              . Findings below reflect the screen that ran at PV1; a change made now is picked up by
              the re-screen at approval.
            </p>
          }
        />
      )}

      <ScreeningFindingsPanel
        orderId={detail.orderId}
        screening={screening}
        gate={acknowledgeGate}
      />

      {/* The decision, immediately below the evidence — and bound to
          it. The digest is computed over the SAME projection the panel
          above just rendered, so the approve this form posts names the
          exact findings list on this screen; see the component header
          and `screening/digest.ts` for the refusal it arms. Rendered
          only while the review is open: once the order moves on there
          is no decision to take here. */}
      {detail.currentStatus === OrderStatus.PV1_IN_PROGRESS ? (
        <Pv1DecisionPanel
          orderId={detail.orderId}
          screening={screening}
          reviewedScreenDigest={
            screening === null
              ? null
              : screenedFindingsDigest(screening.findings.map((f) => f.fingerprint))
          }
          capabilities={{
            canApprove: hasOperatorPermission(permissions, PERMISSIONS.PV1_APPROVE),
            canReject: hasOperatorPermission(permissions, PERMISSIONS.PV1_REJECT),
          }}
        />
      ) : null}

      <Section title="Shipment">
        {detail.shipment === null ? (
          <EmptyState
            icon="shipping"
            title="No shipment yet"
            description="Created when the order is released to shipping and a label is purchased or a tracking number is entered."
          />
        ) : (
          (() => {
            const s = detail.shipment;
            // On-time verdict against the carrier's estimate. The
            // delivered comparison uses the persisted delivered-scan
            // moment; undelivered shipments show "past estimate"
            // once the estimate lapses.
            const onTime: { label: string; tone: Tone } | null =
              s.estimatedDeliveryAt === null
                ? null
                : s.deliveredAt !== null
                  ? s.deliveredAt.getTime() <= s.estimatedDeliveryAt.getTime()
                    ? { label: "Delivered on time", tone: "success" }
                    : { label: "Delivered late", tone: "danger" }
                  : Date.now() > s.estimatedDeliveryAt.getTime()
                    ? { label: "Past carrier estimate", tone: "warning" }
                    : null;
            return (
              <Card>
                <CardHeader>
                  <div>
                    <CardTitle className="text-base">
                      {s.carrier} · {s.serviceLevel}
                    </CardTitle>
                    <div className="mt-0.5 font-mono text-xs text-subtle">{s.trackingNumber}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    {onTime !== null ? <Badge tone={onTime.tone}>{onTime.label}</Badge> : null}
                    <Badge tone={shipmentStatusTone(s.status)} dot>
                      {s.status.replaceAll("_", " ")}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <DataList
                    columns={3}
                    items={[
                      {
                        label: "Handed to carrier",
                        value: s.confirmedAt === null ? "—" : formatDateTime(s.confirmedAt),
                      },
                      {
                        label: "Picked up",
                        value: s.pickedUpAt === null ? "—" : formatDateTime(s.pickedUpAt),
                      },
                      {
                        label: "Delivered",
                        value: s.deliveredAt === null ? "—" : formatDateTime(s.deliveredAt),
                      },
                      {
                        label: "Transit (pickup → delivery)",
                        value:
                          s.transitSeconds === null ? (
                            "—"
                          ) : (
                            <span className="font-semibold tabular-nums">
                              {formatDuration(s.transitSeconds)}
                            </span>
                          ),
                      },
                      {
                        label: "Carrier estimate",
                        value:
                          s.estimatedDeliveryAt === null
                            ? "—"
                            : formatDateTime(s.estimatedDeliveryAt),
                      },
                      {
                        label: "Signature required",
                        value:
                          s.signatureOption === null
                            ? "Carrier default"
                            : s.signatureOption.replaceAll("_", " ").toLowerCase(),
                      },
                      {
                        label: "Last carrier event",
                        value:
                          s.lastTrackingEventAt === null
                            ? "—"
                            : `${formatDateTime(s.lastTrackingEventAt)}${
                                s.lastTrackingEventKind === null
                                  ? ""
                                  : ` (${s.lastTrackingEventKind.replaceAll("_", " ").toLowerCase()})`
                              }`,
                      },
                    ]}
                  />
                </CardContent>
              </Card>
            );
          })()
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
          <EmptyState
            icon="history"
            title="No events recorded yet"
            description="Every workflow transition writes an event here — the trail starts the moment this order is claimed."
          />
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
