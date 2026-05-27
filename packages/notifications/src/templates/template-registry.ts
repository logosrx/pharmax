// Notification template registry.
//
// Every notification the platform can emit is named here ONCE,
// against a frozen registry. Channels accept only registered ids;
// a typo in a call site is a type error, not a silent send-to-nothing.
//
// The template ids mirror the existing event vocabulary in the
// codebase — every notification fires in response to a domain event
// that's already named (e.g. `billing.invoice.payment_failed.v1` in
// `@pharmax/billing`, `order.held.v1` in `@pharmax/orders`,
// `order.escalated_to_emergency.v1` in `@pharmax/shipping`). Pulling
// from the existing vocabulary keeps "what triggers" and "what gets
// sent" in lock-step.
//
// **PHI safety** lives in this file's `phiAllowed` flag plus the
// `PHI_SENTINEL_KEYS` blocklist below. The channel layer (see
// `../ports/notification-channel.ts`) rejects any `context` payload
// whose top-level keys match a sentinel UNLESS the template is
// flagged `phiAllowed: true` AND the channel itself is configured
// as PHI-capable. Both gates must pass. The default for every
// template is `phiAllowed: false` — adding a new template defaults
// to safe; adding PHI capability is an explicit, reviewed change.
//
// Templates are versioned in their id (`_V1`). A breaking change
// to the rendered shape (a new required variable, a moved/removed
// substitution slot) is a new template id (e.g. `_V2`) so old
// queued sends in flight continue to render against the old shape.

/**
 * The complete set of notification templates Pharmax can send. Add
 * a new entry here ONLY after the corresponding event type exists
 * in the domain package that triggers it.
 *
 * Naming convention: `<DOMAIN>_<EVENT>_<VERSION>` in SCREAMING_SNAKE.
 */
export const NOTIFICATION_TEMPLATES = {
  // ---- Billing ----------------------------------------------------------
  /** Stripe charge failed on a finalized invoice. Triggers from
   *  `billing.invoice.payment_failed.v1`. */
  INVOICE_PAYMENT_FAILED_V1: {
    id: "INVOICE_PAYMENT_FAILED_V1",
    channelKinds: ["email", "in-app"] as const,
    phiAllowed: false,
    requiredContextKeys: ["invoiceNumber", "amountDueCents", "clinicName"] as const,
    description:
      "Billing operator alert when Stripe reports a failed charge on a finalized invoice.",
  },
  /** Invoice finalized for collection — sent to clinic billing
   *  contact. Triggers from `billing.invoice.finalized.v1`. */
  INVOICE_FINALIZED_V1: {
    id: "INVOICE_FINALIZED_V1",
    channelKinds: ["email"] as const,
    phiAllowed: false,
    requiredContextKeys: ["invoiceNumber", "totalCents", "dueDate", "hostedInvoiceUrl"] as const,
    description: "Clinic billing contact receives the finalized invoice with a hosted Stripe URL.",
  },
  /** Refund issued against an invoice. Triggers from
   *  `billing.invoice.refunded.v1`. */
  INVOICE_REFUND_ISSUED_V1: {
    id: "INVOICE_REFUND_ISSUED_V1",
    channelKinds: ["email", "in-app"] as const,
    phiAllowed: false,
    requiredContextKeys: ["invoiceNumber", "refundCents", "refundReason"] as const,
    description: "Clinic billing contact receives a refund confirmation.",
  },
  /** Invoice marked uncollectible (write-off). Triggers from
   *  `billing.invoice.uncollectible.v1`. */
  INVOICE_UNCOLLECTIBLE_V1: {
    id: "INVOICE_UNCOLLECTIBLE_V1",
    channelKinds: ["in-app"] as const,
    phiAllowed: false,
    requiredContextKeys: ["invoiceNumber", "amountDueCents"] as const,
    description: "Internal alert when an invoice is written off as uncollectible.",
  },

  // ---- Orders / Workflow -----------------------------------------------
  /** Hold has been in place beyond the configured SLA — reminder to
   *  the team that owns the order. Triggers from a periodic
   *  hold-expiry scan (cron drain) against `order.held.v1` rows
   *  whose `releasedAt IS NULL` and `heldAt < now - threshold`. */
  ORDER_HOLD_EXPIRY_REMINDER_V1: {
    id: "ORDER_HOLD_EXPIRY_REMINDER_V1",
    channelKinds: ["in-app", "email"] as const,
    phiAllowed: false,
    requiredContextKeys: ["orderExternalNumber", "holdReason", "heldAt", "heldByUserName"] as const,
    description:
      "Team-level reminder that a held order has exceeded its expected resolution window.",
  },
  /** PV1 rejected — typing team needs to fix and resubmit. Triggers
   *  from `order.pv1.rejected.v1`. */
  ORDER_PV1_REJECTED_V1: {
    id: "ORDER_PV1_REJECTED_V1",
    channelKinds: ["in-app"] as const,
    phiAllowed: false,
    requiredContextKeys: ["orderExternalNumber", "rejectionReason"] as const,
    description: "Typing team notification when a pharmacist rejects a PV1 review.",
  },
  /** Final verification rejected — fill team needs to rework.
   *  Triggers from `order.final.rejected.v1`. */
  ORDER_FINAL_REJECTED_V1: {
    id: "ORDER_FINAL_REJECTED_V1",
    channelKinds: ["in-app"] as const,
    phiAllowed: false,
    requiredContextKeys: ["orderExternalNumber", "rejectionReason"] as const,
    description: "Fill team notification when a pharmacist rejects a final verification.",
  },

  // ---- Shipping --------------------------------------------------------
  /** Order moved into the emergency bucket. Triggers from
   *  `order.escalated_to_emergency.v1`. */
  SHIPMENT_ESCALATED_V1: {
    id: "SHIPMENT_ESCALATED_V1",
    channelKinds: ["in-app", "email"] as const,
    phiAllowed: false,
    requiredContextKeys: ["orderExternalNumber", "escalationReason", "lastTrackingStatus"] as const,
    description: "Operations lead alert when an order escalates to the emergency bucket.",
  },
  /** Escalation acknowledged by an operator. Triggers from
   *  `order.escalation_acknowledged.v1`. */
  SHIPMENT_ESCALATION_ACKNOWLEDGED_V1: {
    id: "SHIPMENT_ESCALATION_ACKNOWLEDGED_V1",
    channelKinds: ["in-app"] as const,
    phiAllowed: false,
    requiredContextKeys: ["orderExternalNumber", "acknowledgedByUserName"] as const,
    description: "Audit-style notice that an emergency-bucket order has been claimed.",
  },
  /** Escalation resolved. Triggers from
   *  `order.escalation_resolved.v1`. */
  SHIPMENT_ESCALATION_RESOLVED_V1: {
    id: "SHIPMENT_ESCALATION_RESOLVED_V1",
    channelKinds: ["in-app"] as const,
    phiAllowed: false,
    requiredContextKeys: [
      "orderExternalNumber",
      "resolutionDisposition",
      "resolvedByUserName",
    ] as const,
    description: "Audit-style notice that an emergency-bucket order has been resolved.",
  },
} as const;

/** Frozen union of every registered template id. */
export type NotificationTemplateId = keyof typeof NOTIFICATION_TEMPLATES;

/** The static definition of a template — frozen at registry construction. */
export interface NotificationTemplateDefinition {
  readonly id: NotificationTemplateId;
  readonly channelKinds: ReadonlyArray<NotificationRecipientKind>;
  readonly phiAllowed: boolean;
  readonly requiredContextKeys: ReadonlyArray<string>;
  readonly description: string;
}

/** Channel kinds the registry understands. Mirrored on
 *  `NotificationRecipient.kind` in the port. */
export type NotificationRecipientKind = "email" | "sms" | "in-app";

/**
 * Top-level context keys that are presumptively PHI. The channel
 * rejects a `context` payload that contains any of these (case-
 * insensitive) UNLESS the template's `phiAllowed` flag is true and
 * the channel is PHI-capable.
 *
 * The list is deliberately tight: we want to catch obvious cases
 * ("firstName", "lastName", "dob", "ssn", "mrn") without trying to
 * be a full DLP system. Operators who legitimately need to embed a
 * patient identifier in a notification must add a PHI-flagged
 * template; the registry's `phiAllowed: true` flag is the audit
 * trail that the decision was made on purpose.
 *
 * Pattern semantics: a context key matches if its lowercased name
 * equals an entry exactly, or starts with one of the configured
 * prefixes (`dob*`, `ssn*`, `phone*`, `email*`). The check runs at
 * the channel boundary; see `assertNoPhiInContext()`.
 */
export const PHI_SENTINEL_EXACT_KEYS: ReadonlyArray<string> = Object.freeze([
  "firstname",
  "lastname",
  "dateofbirth",
  "mrn",
  "patientname",
  "patientfirstname",
  "patientlastname",
]);

export const PHI_SENTINEL_PREFIX_KEYS: ReadonlyArray<string> = Object.freeze([
  "dob",
  "ssn",
  "phone",
  "email",
]);

/**
 * Returns the template definition for a given id. Throws nothing —
 * the type system guarantees the id is in the registry. Callers
 * that have an untrusted string should narrow via `isNotificationTemplateId`
 * first.
 */
export function getTemplate(id: NotificationTemplateId): NotificationTemplateDefinition {
  return NOTIFICATION_TEMPLATES[id];
}

/** Type-narrow an untrusted string to a registered template id. */
export function isNotificationTemplateId(value: unknown): value is NotificationTemplateId {
  return typeof value === "string" && value in NOTIFICATION_TEMPLATES;
}

/** Enumerate every registered template id — useful for tests, docs,
 *  and a future admin "available notifications" surface. */
export function listTemplateIds(): ReadonlyArray<NotificationTemplateId> {
  return Object.freeze(Object.keys(NOTIFICATION_TEMPLATES) as NotificationTemplateId[]);
}
