// Render a `PORTAL_ORDER_SHIPPED_V1` notification context into the
// subject + plain-text + HTML payload the email adapter needs
// (ADR-0033, slice 3).
//
// PHI invariant: the context is PHI-free by construction — the
// order's external number, the prescriber's OWN rx numbers, an
// optional carrier tracking number, and an ISO timestamp. NO patient
// fields; the prescriber correlates rx numbers to patients from
// their own records. `assertNoPhiInContext` at the channel boundary
// is the structural backstop.

export interface PortalOrderShippedRenderInput {
  readonly orderExternalNumber: string;
  /** The prescriber's own rx numbers on this order (comma-joined upstream). */
  readonly rxNumbers: string;
  readonly shippedAtIso: string;
  /** Carrier tracking number, when assigned before confirmation. */
  readonly trackingNumber?: string;
}

export interface RenderedPortalOrderShippedEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export function renderPortalOrderShippedEmail(
  input: PortalOrderShippedRenderInput
): RenderedPortalOrderShippedEmail {
  const subject = `[Pharmax] Order ${input.orderExternalNumber} has shipped`;
  const shippedDate = input.shippedAtIso.slice(0, 10);
  const trackingLine =
    input.trackingNumber === undefined
      ? "Tracking will be available once the carrier scans the package."
      : `Tracking number: ${input.trackingNumber}`;

  const text = [
    `Order ${input.orderExternalNumber} shipped on ${shippedDate}.`,
    ``,
    `Prescriptions on this order: ${input.rxNumbers}`,
    trackingLine,
    ``,
    `Sign in to the provider portal to see order details.`,
  ].join("\n");

  const html = [
    `<h2 style="margin:0 0 12px">Order ${escapeHtml(input.orderExternalNumber)} has shipped</h2>`,
    `<p>Shipped on <strong>${escapeHtml(shippedDate)}</strong>.</p>`,
    `<p>Prescriptions on this order: <strong>${escapeHtml(input.rxNumbers)}</strong></p>`,
    `<p>${escapeHtml(trackingLine)}</p>`,
    `<p>Sign in to the provider portal to see order details.</p>`,
  ].join("\n");

  return { subject, text, html };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
