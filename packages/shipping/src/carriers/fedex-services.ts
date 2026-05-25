// FedEx service-type and packaging-type catalogs.
//
// Sourced from FedEx's REST API docs and validated against the
// EONPRO reference implementation. Each row carries enough metadata
// to drive a clinic-side dropdown (label, transit estimate, One
// Rate eligibility) without a follow-up API call. Adding a new
// FedEx service is a single row here plus a status-code update if
// the service introduces new derived statuses.

export type FedExServiceCategory = "ground" | "express" | "overnight";

export interface FedExServiceType {
  /** FedEx API code (used directly as `serviceType` on ship calls). */
  readonly code: string;
  /** Human label for admin UI. */
  readonly label: string;
  readonly category: FedExServiceCategory;
  readonly estimatedDays: string;
  readonly oneRateEligible: boolean;
}

export const FEDEX_SERVICE_TYPES: ReadonlyArray<FedExServiceType> = Object.freeze([
  {
    code: "FEDEX_GROUND",
    label: "FedEx Ground",
    category: "ground",
    estimatedDays: "1-5 business days",
    oneRateEligible: false,
  },
  {
    code: "GROUND_HOME_DELIVERY",
    label: "FedEx Home Delivery",
    category: "ground",
    estimatedDays: "1-7 business days",
    oneRateEligible: false,
  },
  {
    code: "FEDEX_EXPRESS_SAVER",
    label: "FedEx Express Saver",
    category: "express",
    estimatedDays: "3 business days",
    oneRateEligible: true,
  },
  {
    code: "FEDEX_2_DAY",
    label: "FedEx 2Day",
    category: "express",
    estimatedDays: "2 business days",
    oneRateEligible: true,
  },
  {
    code: "FEDEX_2_DAY_AM",
    label: "FedEx 2Day A.M.",
    category: "express",
    estimatedDays: "2 business days (AM)",
    oneRateEligible: true,
  },
  {
    code: "STANDARD_OVERNIGHT",
    label: "FedEx Standard Overnight",
    category: "overnight",
    estimatedDays: "Next business day",
    oneRateEligible: true,
  },
  {
    code: "PRIORITY_OVERNIGHT",
    label: "FedEx Priority Overnight",
    category: "overnight",
    estimatedDays: "Next business day (by 10:30 AM)",
    oneRateEligible: true,
  },
  {
    code: "FIRST_OVERNIGHT",
    label: "FedEx First Overnight",
    category: "overnight",
    estimatedDays: "Next business day (by 8 AM)",
    oneRateEligible: true,
  },
  {
    code: "INTERNATIONAL_PRIORITY",
    label: "FedEx International Priority",
    category: "express",
    estimatedDays: "1-3 business days",
    oneRateEligible: false,
  },
  {
    code: "INTERNATIONAL_ECONOMY",
    label: "FedEx International Economy",
    category: "express",
    estimatedDays: "2-5 business days",
    oneRateEligible: false,
  },
]);

export type FedExServiceCode = (typeof FEDEX_SERVICE_TYPES)[number]["code"];

export interface FedExPackagingType {
  readonly code: string;
  readonly label: string;
  readonly oneRateEligible: boolean;
  readonly oneRateMaxLbs: number | null;
}

export const FEDEX_PACKAGING_TYPES: ReadonlyArray<FedExPackagingType> = Object.freeze([
  { code: "YOUR_PACKAGING", label: "Your Packaging", oneRateEligible: false, oneRateMaxLbs: null },
  { code: "FEDEX_ENVELOPE", label: "FedEx Envelope", oneRateEligible: true, oneRateMaxLbs: 10 },
  { code: "FEDEX_PAK", label: "FedEx Pak", oneRateEligible: true, oneRateMaxLbs: 50 },
  { code: "FEDEX_BOX", label: "FedEx Box", oneRateEligible: true, oneRateMaxLbs: 50 },
  { code: "FEDEX_SMALL_BOX", label: "FedEx Small Box", oneRateEligible: true, oneRateMaxLbs: 50 },
  { code: "FEDEX_MEDIUM_BOX", label: "FedEx Medium Box", oneRateEligible: true, oneRateMaxLbs: 50 },
  { code: "FEDEX_LARGE_BOX", label: "FedEx Large Box", oneRateEligible: true, oneRateMaxLbs: 50 },
  {
    code: "FEDEX_EXTRA_LARGE_BOX",
    label: "FedEx Extra Large Box",
    oneRateEligible: true,
    oneRateMaxLbs: 50,
  },
  { code: "FEDEX_TUBE", label: "FedEx Tube", oneRateEligible: true, oneRateMaxLbs: 50 },
]);

export type FedExPackagingCode = (typeof FEDEX_PACKAGING_TYPES)[number]["code"];

export function findFedExService(code: string): FedExServiceType | undefined {
  return FEDEX_SERVICE_TYPES.find((s) => s.code === code);
}

export function findFedExPackaging(code: string): FedExPackagingType | undefined {
  return FEDEX_PACKAGING_TYPES.find((p) => p.code === code);
}
