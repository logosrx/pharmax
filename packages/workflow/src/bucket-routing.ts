// Per-tenant stage → bucket routing.
//
// `status-bucket-map.ts` answers "which bucket does an order in this
// state belong in?" with ONE global answer per state: RECEIVED lives
// in `INBOX`, `PV1_REJECTED` bounces to `TYPING`. That map is the
// canonical route and stays the default for every organization.
//
// This module adds the second dimension: an organization may REDIRECT
// a state's canonical route to a bucket of its own choosing (a custom
// bucket it created via `CreateBucket`, or another seeded one). The
// redirect lives in the per-tenant workflow policy overlay
// (`policy-overlay.ts`), so it inherits the overlay's versioning and
// supersede-never-mutate lineage — which is what makes a historical
// replay resolve the route that was in force at the time rather than
// today's.
//
// ---------------------------------------------------------------------
// Three properties this module is built to guarantee
// ---------------------------------------------------------------------
//
//   1. FALL BACK, NEVER FAIL CLOSED. A missing, blank, unparseable, or
//      unknown-state override resolves to the canonical code. There is
//      no input to `resolveStageBucketRoute` that makes it return
//      "nowhere" for a state the canonical map can answer. A routing
//      bug must land the order in the bucket it would have reached
//      before this module existed — never drop it out of the workflow.
//
//   2. NARROW, NEVER WIDEN. Only a state that ALREADY has a canonical
//      bucket may be re-routed. A state the canonical map deliberately
//      leaves unrouted (`CANCELLED` is terminal and leaves every queue;
//      `ON_HOLD` has no bucket until `PlaceHold` pins one) cannot
//      acquire one from an overlay. This mirrors the tighten-only rule
//      the transition overlay already enforces: an overlay reshapes
//      what base declares, it does not declare new behavior.
//
//   3. ROUTES ARE CODES, NOT IDS. An override names a bucket `code`,
//      exactly like the canonical map does, and is dereferenced the
//      same way the ~20 stage handlers dereference the canonical code:
//      `findFirst({ where: { organizationId, siteId, code } })`. That
//      is deliberate. A multi-site organization has one `PV1` bucket
//      PER SITE; a route stored as a bucket id would pin every site's
//      orders to one site's queue. Storing the code keeps the override
//      site-relative, keeps it human-readable in the audit row, and
//      keeps it validatable without a join.
//
//      The cost of (3) is that a bucket RENAME or DELETE can strand a
//      route. `DeleteBucket` and `UpdateBucket` in `@pharmax/orgs`
//      carry the matching refusals; see `findOverlaysRoutingToCode`.
//
// ---------------------------------------------------------------------
// EMERGENCY is deliberately NOT routable
// ---------------------------------------------------------------------
//
// `EMERGENCY` never appears in this surface, and that is not an
// oversight. It is not an `OrderState`, so it cannot be a key here.
// More importantly, the escalation path does not read the canonical
// map at all — three independent selectors find the emergency bucket,
// and only one of them is a code:
//
//   - `EscalateOrderForSlaBreach` resolves `code: "EMERGENCY"`.
//   - `emergency-bucket-counts` selects `kind: EMERGENCY` org-wide.
//   - The breach claim query in `apps/worker` joins on a SQL literal
//     `b.code = 'EMERGENCY'` to skip orders ALREADY escalated.
//
// That last one is the dangerous one. It is the anti-double-escalation
// guard: an order sitting in the emergency bucket is excluded from the
// next claim batch. Redirect escalation to `RUSH_REVIEW` and the join
// stops matching, so every breached order is re-claimed and
// re-escalated on every drain tick, forever, against live overdue
// prescriptions. Making the emergency route configurable therefore
// means changing a raw SQL literal, a `kind` selector, and a command
// in lockstep — three places, two of which are not code-based. Until
// those three collapse into one resolver, the emergency route stays
// fixed, and `@pharmax/orgs` additionally refuses an override that
// TARGETS an EMERGENCY-kind bucket (routing a normal stage into the
// emergency queue poisons the same report from the other direction).
//
// This file is pure data + pure functions. No I/O, no Prisma, no
// clock. Safe to import from any package, including pure-engine code.
// PHI: none — routes are configuration.

import { BUCKET_CODE_FOR_EXCEPTION_STATE, BUCKET_CODE_FOR_STATUS } from "./status-bucket-map.js";
import { ALL_ORDER_STATES, type OrderState } from "./states.js";

/**
 * A per-tenant redirect table: workflow state → bucket code.
 *
 * Partial on purpose. A state absent from the table uses its
 * canonical code, so an organization declares only the stages it
 * actually wants moved. The empty table is the identity route.
 */
export type StageBucketRouteTable = Readonly<Partial<Record<OrderState, string>>>;

/**
 * States whose canonical route an overlay may redirect.
 *
 * DERIVED from the canonical maps rather than hand-listed, for the
 * same reason `RESERVED_BUCKET_CODES` is derived: a future state that
 * gains a canonical bucket becomes routable on the commit that adds
 * it, and a state that loses one stops being routable on the same
 * commit. A hand-maintained copy would drift, and the failure mode of
 * that drift is an override accepted for a state nothing dereferences.
 *
 * Ordered by `ALL_ORDER_STATES` so the admin UI and error messages
 * list states in lifecycle order rather than hash order.
 */
export const ROUTABLE_ORDER_STATES: ReadonlyArray<OrderState> = Object.freeze(
  ALL_ORDER_STATES.filter((state) => canonicalBucketCodeForState(state) !== null)
);

const ROUTABLE_STATE_SET: ReadonlySet<string> = new Set<string>(ROUTABLE_ORDER_STATES);

/**
 * True when `value` is a state that has a canonical bucket and may
 * therefore carry an override. False for unknown strings and for
 * states the canonical map leaves unrouted (`ON_HOLD`, `CANCELLED`).
 */
export function isRoutableOrderState(value: string): value is OrderState {
  return ROUTABLE_STATE_SET.has(value);
}

/**
 * The canonical (platform default) bucket code for a state, or `null`
 * when the state has no canonical bucket.
 *
 * Thin wrapper over the two canonical tables. Exists so callers reason
 * about "canonical vs. overridden" in one vocabulary instead of
 * reaching into whichever of the two maps happens to hold the state.
 */
export function canonicalBucketCodeForState(state: OrderState): string | null {
  if (Object.prototype.hasOwnProperty.call(BUCKET_CODE_FOR_STATUS, state)) {
    return BUCKET_CODE_FOR_STATUS[state as keyof typeof BUCKET_CODE_FOR_STATUS];
  }
  return (
    BUCKET_CODE_FOR_EXCEPTION_STATE[state as keyof typeof BUCKET_CODE_FOR_EXCEPTION_STATE] ?? null
  );
}

/** Outcome of resolving one state against a tenant's route table. */
export interface ResolvedStageBucketRoute {
  /**
   * The bucket code to resolve against `(organizationId, siteId)`.
   * Equals `canonicalCode` whenever no usable override applied.
   */
  readonly code: string;
  /** The platform default, always populated. The fallback target. */
  readonly canonicalCode: string;
  /** True only when a usable override redirected this state. */
  readonly overridden: boolean;
}

/**
 * Resolve the bucket code for `state` under a tenant's route table.
 *
 * Returns `null` ONLY when the state has no canonical bucket at all
 * (`CANCELLED`, `ON_HOLD`, an unknown string). That is the same signal
 * `bucketCodeForStatus` gives today and carries the same meaning:
 * "leave the order in the bucket it already occupies". An override can
 * never turn a `null` into a route — see property (2) in the header.
 *
 * Every other input resolves to a code. Specifically, the override is
 * IGNORED (and the canonical code returned) when it is:
 *
 *   - absent for this state,
 *   - not a string, or an empty / whitespace-only string,
 *   - equal to the canonical code (a no-op redirect).
 *
 * The `unknown`-tolerant value check is not paranoia about TypeScript.
 * The table is rehydrated from `overlayJson`, a `Json` column: a row
 * written by an older or newer build, or hand-patched during an
 * incident, can hold anything. Tolerating junk by falling back is the
 * whole point of property (1).
 *
 * Pure and total. Never throws.
 */
export function resolveStageBucketRoute(
  state: string,
  routes: StageBucketRouteTable | undefined
): ResolvedStageBucketRoute | null {
  if (!isRoutableOrderState(state)) return null;

  const canonicalCode = canonicalBucketCodeForState(state);
  // Unreachable while ROUTABLE_ORDER_STATES is derived from the maps,
  // but this is the fallback path — it must not depend on that.
  if (canonicalCode === null) return null;

  const raw: unknown = routes?.[state];
  if (typeof raw !== "string") {
    return { code: canonicalCode, canonicalCode, overridden: false };
  }
  const override = raw.trim();
  if (override.length === 0 || override === canonicalCode) {
    return { code: canonicalCode, canonicalCode, overridden: false };
  }
  return { code: override, canonicalCode, overridden: true };
}

/**
 * Fold several route tables into one, later tables winning per state.
 *
 * Routing composes LAST-WINS rather than by union, which is the one
 * place this surface differs from `forbidTransitionsFromStates`. A
 * forbid list is a set — two overlays forbidding different states both
 * apply, and the union is unambiguous. A route is a FUNCTION: a state
 * has exactly one destination, so two overlays naming different
 * buckets for `PV1_IN_PROGRESS` is a genuine conflict with no
 * union-like answer.
 *
 * Last-wins resolves it by overlay priority, and the priority order is
 * already fixed by ADR-0019: org-wide (100) applies before clinic
 * (200). So the clinic's route beats the organization's, which is the
 * specific-beats-general precedence an operator expects and the same
 * direction every other per-clinic setting resolves in.
 *
 * Entries that are not usable strings are dropped rather than allowed
 * to shadow an earlier table's valid entry — a junk value in a
 * high-priority overlay must not erase a good value in a low-priority
 * one.
 *
 * Pure. Returns a frozen table. Empty input → empty table.
 */
export function composeStageBucketRouteTables(
  ...tables: ReadonlyArray<StageBucketRouteTable | undefined>
): StageBucketRouteTable {
  const out: Partial<Record<OrderState, string>> = {};
  for (const table of tables) {
    if (table === undefined) continue;
    for (const key of Object.keys(table)) {
      if (!isRoutableOrderState(key)) continue;
      const raw: unknown = table[key];
      if (typeof raw !== "string") continue;
      const code = raw.trim();
      if (code.length === 0) continue;
      out[key] = code;
    }
  }
  return Object.freeze(out);
}

/**
 * Every distinct bucket code a route table points at.
 *
 * Used by the write-time validator in `@pharmax/orgs` (to check each
 * target exists in the organization) and by the delete/rename guards
 * (to answer "would removing this code strand a route?"). Sorted so
 * error metadata and test snapshots are deterministic.
 */
export function routeTargetCodes(routes: StageBucketRouteTable | undefined): ReadonlyArray<string> {
  if (routes === undefined) return Object.freeze([]);
  const codes = new Set<string>();
  for (const key of Object.keys(routes)) {
    if (!isRoutableOrderState(key)) continue;
    const raw: unknown = routes[key];
    if (typeof raw !== "string") continue;
    const code = raw.trim();
    if (code.length > 0) codes.add(code);
  }
  return Object.freeze([...codes].sort());
}

/**
 * The states in `routes` that point at `code`.
 *
 * The delete/rename guards need to name the affected stages in their
 * refusal message, because "this bucket is referenced by a routing
 * override" is not actionable but "PV1_IN_PROGRESS routes here" is.
 * Emitted in lifecycle order (the `ROUTABLE_ORDER_STATES` order) so the
 * message reads down the workflow and is deterministic across runs.
 */
export function statesRoutedTo(
  routes: StageBucketRouteTable | undefined,
  code: string
): ReadonlyArray<OrderState> {
  if (routes === undefined) return Object.freeze([]);
  const states: OrderState[] = [];
  for (const state of ROUTABLE_ORDER_STATES) {
    const raw: unknown = routes[state];
    if (typeof raw !== "string") continue;
    if (raw.trim() === code) states.push(state);
  }
  return Object.freeze(states);
}
