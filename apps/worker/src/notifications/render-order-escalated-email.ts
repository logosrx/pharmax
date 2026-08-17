// Render the two emergency-bucket escalation notification contexts
// into the subject + plain-text + HTML payload the email adapter
// needs:
//
//   - `ORDER_SLA_BREACH_ESCALATED_V1` (SLA breach path)
//   - `SHIPMENT_ESCALATED_V1`         (shipment exception path)
//
// Both templates share one file because they share an audience
// (OrgAdmin ops leads), one urgency register ("an order just landed
// in the EMERGENCY bucket and a human must look at it"), and one
// layout — only the middle detail rows differ.
//
// Renderers kept SEPARATE from the channel adapter for the same
// reasons as `render-report-completed-email.ts`: focused unit tests,
// clean template-version bumps, and reusability by future non-email
// adapters.
//
// PHI invariant: the contexts are PHI-free by construction — an
// internal/external order number, reason codes, carrier status
// codes, and ISO timestamps. NO patient fields. The channel's
// `assertNoPhiInContext` gate is the structural backstop; the
// renderer HTML-escapes everything anyway.
//
// No deep link: the escalation drain's context (frozen with the V1
// template ids) carries no dashboard URL, so the copy points the
// operator at the ops console emergency bucket by name instead —
// same posture as the SHIPMENT_ESCALATED_V1 SMS body.

/**
 * Stable subject prefix so inbox filters and paging rules key off
 * the bracket prefix. Sibling of `[Pharmax compliance]` on the
 * compliance notice and `[Pharmax]` on the report email.
 */
const SUBJECT_PREFIX = "[Pharmax emergency]";

/** House red badge palette — matches the FAILED/critical badge in
 *  the report and compliance renderers. */
const BADGE_COLORS = { bg: "#fef2f2", fg: "#991b1b", border: "#fecaca" } as const;

export interface OrderSlaBreachEscalatedRenderInput {
  readonly orderExternalNumber: string;
  /** ISO timestamp the stage SLA was due. */
  readonly slaDeadlineAtIso: string;
  /** ISO timestamp the breach was detected. */
  readonly breachedAtIso: string;
}

export interface ShipmentEscalatedRenderInput {
  readonly orderExternalNumber: string;
  /** Escalation reason code, e.g. "DELIVERY_EXCEPTION". */
  readonly escalationReason: string;
  /** Last carrier tracking status, e.g. "RETURNED". */
  readonly lastTrackingStatus: string;
}

export interface RenderedEscalationEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export function renderOrderSlaBreachEscalatedEmail(
  input: OrderSlaBreachEscalatedRenderInput
): RenderedEscalationEmail {
  const breachDelta = formatBreachDelta(input.slaDeadlineAtIso, input.breachedAtIso);
  const detailRows: Array<readonly [label: string, value: string]> = [
    ["Order", input.orderExternalNumber],
    ["SLA deadline", input.slaDeadlineAtIso],
    ["Breached at", input.breachedAtIso],
  ];
  if (breachDelta !== undefined) {
    detailRows.push(["Over deadline by", breachDelta]);
  }
  return renderEscalationEmail({
    badge: "SLA BREACH",
    orderExternalNumber: input.orderExternalNumber,
    headline: `Order ${input.orderExternalNumber} escalated to the emergency bucket`,
    summary: `A stage SLA breached on order ${input.orderExternalNumber} and the order moved to the emergency bucket.`,
    detailRows,
  });
}

export function renderShipmentEscalatedEmail(
  input: ShipmentEscalatedRenderInput
): RenderedEscalationEmail {
  return renderEscalationEmail({
    badge: "SHIPMENT EXCEPTION",
    orderExternalNumber: input.orderExternalNumber,
    headline: `Order ${input.orderExternalNumber} escalated to the emergency bucket`,
    summary: `A shipment exception escalated order ${input.orderExternalNumber} to the emergency bucket.`,
    detailRows: [
      ["Order", input.orderExternalNumber],
      ["Escalation reason", input.escalationReason],
      ["Last tracking status", input.lastTrackingStatus],
    ],
  });
}

interface EscalationEmailParts {
  /** Subject/triage badge, e.g. "SLA BREACH". */
  readonly badge: string;
  readonly orderExternalNumber: string;
  readonly headline: string;
  /** One-sentence plain-language summary above the detail rows. */
  readonly summary: string;
  readonly detailRows: ReadonlyArray<readonly [label: string, value: string]>;
}

const CALL_TO_ACTION = "Open the ops console emergency bucket to claim this order.";

function renderEscalationEmail(parts: EscalationEmailParts): RenderedEscalationEmail {
  const subject = `${SUBJECT_PREFIX} ${parts.badge} · Order ${parts.orderExternalNumber} escalated to the emergency bucket`;

  const text = [
    parts.summary,
    "",
    ...parts.detailRows.map(([label, value]) => `${label}: ${value}`),
    "",
    CALL_TO_ACTION,
  ].join("\n");

  const detailRowsHtml = parts.detailRows
    .map(
      ([label, value]) =>
        `<div><strong>${escapeHtml(label)}:</strong> <code style="font-size:12px">${escapeHtml(value)}</code></div>`
    )
    .join("\n      ");

  const html = `<!DOCTYPE html>
<html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;background:#fafafa;padding:24px;color:#0a0a0a">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:24px">
    <div style="display:inline-block;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:600;background:${BADGE_COLORS.bg};color:${BADGE_COLORS.fg};border:1px solid ${BADGE_COLORS.border}">${escapeHtml(parts.badge)}</div>
    <h1 style="margin:12px 0 4px;font-size:20px">${escapeHtml(parts.headline)}</h1>
    <p style="margin:0;color:#525252;font-size:14px">${escapeHtml(parts.summary)}</p>
    <hr style="border:none;border-top:1px solid #e5e5e5;margin:16px 0" />
    <div style="font-size:14px;line-height:1.6">
      ${detailRowsHtml}
    </div>
    <p style="margin:24px 0 0"><strong>${escapeHtml(CALL_TO_ACTION)}</strong></p>
    <p style="margin:24px 0 0;color:#737373;font-size:12px">Emergency-bucket alert — generated by the Pharmax escalation drain. This message is operator-facing and does not contain PHI.</p>
  </div>
</body></html>`;

  return Object.freeze({ subject, text, html });
}

/**
 * Human-readable "how far past the deadline" delta, computed from
 * the two ISO timestamps the drain already sends (the context has
 * no precomputed duration field). Returns undefined — and the row
 * is omitted — when either timestamp fails to parse (the drain
 * defaults missing payload fields to "") or when the breach is not
 * actually past the deadline; the raw timestamps are always
 * rendered regardless.
 */
function formatBreachDelta(slaDeadlineAtIso: string, breachedAtIso: string): string | undefined {
  const deadlineMs = Date.parse(slaDeadlineAtIso);
  const breachedMs = Date.parse(breachedAtIso);
  if (Number.isNaN(deadlineMs) || Number.isNaN(breachedMs)) {
    return undefined;
  }
  const deltaMs = breachedMs - deadlineMs;
  if (deltaMs < 0) {
    return undefined;
  }
  const totalMinutes = Math.floor(deltaMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) {
    return `${minutes}m`;
  }
  return `${hours}h ${minutes}m`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
