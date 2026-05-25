// Typed feature (capability flag) registry.
//
// FEATURES are deliberately a PARALLEL universe to PERMISSIONS:
//
//   - A PERMISSION is an action verb the platform recognizes. A user
//     either has it or doesn't, and the answer is a security decision.
//     "Can this pharmacist approve PV1?"
//
//   - A FEATURE is a capability the *tenant* has enabled. Two clinics
//     on identical roles can have different feature surfaces:
//     "Is package-photo capture turned on for THIS clinic?" The
//     answer drives UI affordances, integration availability, and
//     billing exposure — not access control.
//
// Treating them as one registry (EONPRO does) means you can't model
// "feature off → button hidden for ALL users including admins" without
// hand-rolling a second concept. We split it cleanly from day one.
//
// SOC 2 invariant: a feature toggle alone NEVER grants the underlying
// permission. The command bus checks PERMISSIONS for security and
// FEATURES for capability. Both must pass.
//
// Adding / removing / renaming a feature is a release-notes event but
// NOT a SOC 2 audit event — features don't grant access. Still, keep
// the registry frozen and the per-tenant `feature_flag` table seeded
// from it (parity test, mirrors `permissions.test.ts`).

/**
 * Frozen registry of every feature flag recognized by the platform.
 * Values are dotted kebab-case to differentiate from permission codes
 * (which are dotted lowercase). Domain-prefixed for grep-ability.
 */
export const FEATURES = Object.freeze({
  // Workflow surface.
  CUSTOM_BUCKETS: "workflow.custom-buckets",
  EMERGENCY_BUCKETS: "workflow.emergency-buckets",
  REOPEN_FOR_CORRECTION: "workflow.reopen-for-correction",

  // Hardware integrations.
  ZEBRA_LABEL_PRINT: "hardware.zebra-label-print",
  BARCODE_SCAN_VALIDATION: "hardware.barcode-scan-validation",
  WORKSTATION_BINDING: "hardware.workstation-binding",

  // Shipping integrations.
  EASYPOST_OUTBOUND: "shipping.easypost-outbound",
  FEDEX_DIRECT: "shipping.fedex-direct",
  PACKAGE_PHOTOS: "shipping.package-photos",

  // Telehealth / e-prescribe integrations.
  LIFEFILE_INBOUND: "telehealth.lifefile-inbound",
  DOSESPOT_INBOUND: "telehealth.dosespot-inbound",
  CALLBACK_NOTIFICATIONS: "telehealth.callback-notifications",

  // Billing.
  STRIPE_BILLING: "billing.stripe",
  CLINIC_PRICING: "billing.clinic-pricing",
  RUSH_FEES: "billing.rush-fees",
} as const);

export type FeatureCode = (typeof FEATURES)[keyof typeof FEATURES];

export const ALL_FEATURE_CODES: ReadonlyArray<FeatureCode> = Object.freeze(
  Object.values(FEATURES) as ReadonlyArray<FeatureCode>
);

/**
 * Per-feature metadata for the admin UI. Description is human-facing;
 * `category` groups features in the admin console; `defaultEnabled`
 * is the value used when a feature has no per-tenant row yet.
 *
 * `defaultEnabled` policy:
 *   - Workflow features default ON — they're core to the product.
 *   - Hardware features default OFF — they require a paired
 *     workstation that may not exist in the tenant yet.
 *   - Integration features default OFF — they require credentials
 *     and a configuration step that is intentionally explicit.
 *   - Billing features default OFF — turning billing on without an
 *     adapter wired would generate phantom invoices.
 */
export const FEATURE_METADATA: Readonly<
  Record<
    FeatureCode,
    {
      readonly description: string;
      readonly category: string;
      readonly defaultEnabled: boolean;
    }
  >
> = Object.freeze({
  [FEATURES.CUSTOM_BUCKETS]: {
    description: "Allow admins to create custom operational buckets.",
    category: "Workflow",
    defaultEnabled: true,
  },
  [FEATURES.EMERGENCY_BUCKETS]: {
    description: "Move SLA-breached orders into a dedicated emergency bucket.",
    category: "Workflow",
    defaultEnabled: true,
  },
  [FEATURES.REOPEN_FOR_CORRECTION]: {
    description: "Allow reopening completed orders to correct typing or fill data.",
    category: "Workflow",
    defaultEnabled: true,
  },
  [FEATURES.ZEBRA_LABEL_PRINT]: {
    description: "Send vial label ZPL to paired Zebra printers.",
    category: "Hardware",
    defaultEnabled: false,
  },
  [FEATURES.BARCODE_SCAN_VALIDATION]: {
    description: "Validate scans against expected NDC / lot / patient.",
    category: "Hardware",
    defaultEnabled: false,
  },
  [FEATURES.WORKSTATION_BINDING]: {
    description: "Require a paired workstation cert for privileged commands.",
    category: "Hardware",
    defaultEnabled: false,
  },
  [FEATURES.EASYPOST_OUTBOUND]: {
    description: "Generate outbound EasyPost shipments.",
    category: "Shipping",
    defaultEnabled: false,
  },
  [FEATURES.FEDEX_DIRECT]: {
    description: "Generate outbound shipments via FedEx Web Services.",
    category: "Shipping",
    defaultEnabled: false,
  },
  [FEATURES.PACKAGE_PHOTOS]: {
    description: "Capture package photos at shipping release.",
    category: "Shipping",
    defaultEnabled: false,
  },
  [FEATURES.LIFEFILE_INBOUND]: {
    description: "Accept inbound prescription webhooks from Lifefile telehealth.",
    category: "Telehealth",
    defaultEnabled: false,
  },
  [FEATURES.DOSESPOT_INBOUND]: {
    description: "Accept inbound prescription webhooks from DoseSpot.",
    category: "Telehealth",
    defaultEnabled: false,
  },
  [FEATURES.CALLBACK_NOTIFICATIONS]: {
    description: "Send order-status callbacks to upstream telehealth platforms.",
    category: "Telehealth",
    defaultEnabled: false,
  },
  [FEATURES.STRIPE_BILLING]: {
    description: "Use Stripe for invoicing and payment reconciliation.",
    category: "Billing",
    defaultEnabled: false,
  },
  [FEATURES.CLINIC_PRICING]: {
    description: "Apply per-clinic price overrides on invoices.",
    category: "Billing",
    defaultEnabled: false,
  },
  [FEATURES.RUSH_FEES]: {
    description: "Add rush fees for orders flagged urgent.",
    category: "Billing",
    defaultEnabled: false,
  },
});

/**
 * Type guard for untrusted input. NEVER assume an arbitrary string
 * is a valid feature code — the registry is closed.
 */
export function isFeatureCode(value: unknown): value is FeatureCode {
  return typeof value === "string" && (ALL_FEATURE_CODES as ReadonlyArray<string>).includes(value);
}
