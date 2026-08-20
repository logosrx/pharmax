// Canonical US state and territory codes.
//
// WHY THIS EXISTS. Before it, five files each carried their own
// `/^[A-Z]{2}$/` and nothing knew which two-letter combinations were
// real. That is adequate for storing an address — a typo shows up as a
// wrong label — but not for ship-to-state licensure, where the set of
// codes IS the enforcement rule. `XX` entered into a site's authorized
// states would be accepted, match no order, and quietly do nothing;
// the failure is safe but invisible, which is the worst kind of
// configuration error to debug.
//
// Lives in platform-core because both `@pharmax/orgs` (which records
// the authorized set) and `@pharmax/providers` (which records state
// licences) need it, and those are sibling domain packages that may
// not depend on each other.
//
// TERRITORIES ARE INCLUDED. Puerto Rico, Guam, the US Virgin Islands,
// American Samoa and the Northern Mariana Islands all have boards of
// pharmacy and a pharmacy can hold a non-resident licence for them.
// DC likewise. Excluding them would refuse a lawful shipment.
//
// Military codes (AA, AE, AP) are deliberately ABSENT. They are APO
// and FPO postal designations rather than licensing jurisdictions,
// there is no board of pharmacy to hold a licence from, and shipping a
// prescription to one raises questions this constant should not appear
// to answer.

/** The 50 states. */
export const US_STATE_CODES = Object.freeze([
  "AL",
  "AK",
  "AZ",
  "AR",
  "CA",
  "CO",
  "CT",
  "DE",
  "FL",
  "GA",
  "HI",
  "ID",
  "IL",
  "IN",
  "IA",
  "KS",
  "KY",
  "LA",
  "ME",
  "MD",
  "MA",
  "MI",
  "MN",
  "MS",
  "MO",
  "MT",
  "NE",
  "NV",
  "NH",
  "NJ",
  "NM",
  "NY",
  "NC",
  "ND",
  "OH",
  "OK",
  "OR",
  "PA",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UT",
  "VT",
  "VA",
  "WA",
  "WV",
  "WI",
  "WY",
] as const);

/** DC and the five territories with their own boards of pharmacy. */
export const US_TERRITORY_CODES = Object.freeze(["DC", "PR", "VI", "GU", "AS", "MP"] as const);

/**
 * Every jurisdiction a pharmacy can hold a licence to dispense into.
 * This is the set ship-to-state licensure validates against.
 */
export const US_JURISDICTION_CODES: ReadonlyArray<string> = Object.freeze([
  ...US_STATE_CODES,
  ...US_TERRITORY_CODES,
]);

const JURISDICTION_SET: ReadonlySet<string> = new Set(US_JURISDICTION_CODES);

/**
 * True when `value` is a licensable US jurisdiction code, already
 * uppercase. Use `normalizeJurisdictionCode` first if the input came
 * from a form.
 */
export function isUsJurisdictionCode(value: string): boolean {
  return JURISDICTION_SET.has(value);
}

/**
 * Trim and uppercase, returning null when the result is not a
 * recognized jurisdiction. Callers store the returned value so that
 * `ca`, ` CA ` and `CA` converge on one code rather than three.
 */
export function normalizeJurisdictionCode(value: string): string | null {
  const normalized = value.trim().toUpperCase();
  return JURISDICTION_SET.has(normalized) ? normalized : null;
}
