// Per-tenant workflow policy overlays — Tier 2 of the tenant
// extension surface (see ADR-0019).
//
// Why this file exists:
//
//   The base `OrderWorkflowPolicy` (`policy-v1.ts`) is the SOC-2
//   anchor: every order born under v1 is replayable against v1
//   forever. We MUST NOT mutate that table per-tenant. We also must
//   never enable a transition the base does not allow — that would
//   let a clinic loosen the workflow into an unsafe shape (e.g.
//   "skip PV1", "ship before final verification").
//
//   But real customers DO want to TIGHTEN the base for their own
//   compliance posture: a clinic that handles controlled substances
//   may require a SECOND pharmacist signoff on PV1; another may
//   forbid ReopenForCorrection entirely; another may want to add a
//   $-threshold escalation to a custom bucket.
//
//   This file is the small, declarative seam for that need. It is
//   deliberately NOT wired into the command bus yet (deferred to
//   the follow-up slice). Today it exists so:
//
//     - The shape is testable in isolation.
//     - The merge function's tightening invariant is a unit-test
//       contract anyone can extend.
//     - Future Tier-2 wiring (see ADR-0019) has a clear target.
//
// Security invariant (the load-bearing rule of the entire surface):
//
//     mergePolicyWithOverlay(base, overlay).transitions
//       ⊆ base.transitions   (modulo identity equivalence)
//
//   The overlay can REMOVE transitions and ADD attestation
//   requirements. It CANNOT add a transition, change a transition's
//   destination, or remove an attestation requirement that the base
//   declared. Any overlay that would do so is rejected at merge time
//   with `OVERLAY_LOOSENS_BASE_POLICY`. The merge function is pure
//   (no I/O, no clock, no exceptions outside that one validated
//   throw) so it is safe to call from inside the command-bus tx.
//
// PHI invariant: this file references no patient data. Overlays are
// configuration; the merge result is also configuration.

import { errors } from "@pharmax/platform-core";

import type { OrderWorkflowCommand } from "./commands.js";
import type {
  AttestationRequirement,
  OrderTransitionRow,
  OrderWorkflowPolicy,
} from "./policy-v1.js";
import type { OrderState } from "./states.js";

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

/**
 * Thrown by `mergePolicyWithOverlay` when an overlay attempts to
 * widen the base policy or references a transition the base does
 * not declare. The merge function is fail-closed — a misconfigured
 * overlay halts the merge rather than silently ignoring the
 * misconfiguration, because silent-ignore would leave operators
 * believing the overlay applied when it did not.
 */
export const OVERLAY_LOOSENS_BASE_POLICY = "OVERLAY_LOOSENS_BASE_POLICY" as const;
export type WorkflowPolicyOverlayErrorCode = typeof OVERLAY_LOOSENS_BASE_POLICY;

// ---------------------------------------------------------------------------
// Overlay shape
// ---------------------------------------------------------------------------

/**
 * Per-tenant overlay on a base `OrderWorkflowPolicy`.
 *
 * Shape principles:
 *   - SMALL on purpose. Every field added here is a contract the
 *     command bus and admin UI must support; widening the surface is
 *     a deliberate event, not an accident. v1 ships with the two
 *     fields below; expansion is documented in ADR-0019.
 *   - DECLARATIVE. Each field describes WHAT changes, not HOW. The
 *     merge function decides how to compose the layers.
 *   - TIGHTEN-ONLY. Both fields are constrained to operations that
 *     can never widen the base (subtract from, or augment, never
 *     introduce-new-or-remove-existing).
 */
export interface WorkflowPolicyOverlay {
  /**
   * Per-command list of `fromState`s the tenant disallows. Subtractive:
   * each `(command, state)` listed here is removed from the base
   * transition table in the merge result.
   *
   * Constraint: every `(command, state)` listed MUST exist in the base
   * policy's transition table. Listing a pair the base does not declare
   * is rejected at merge time as `OVERLAY_LOOSENS_BASE_POLICY` — the
   * overlay is implicitly asserting that base allows the transition,
   * which it does not.
   *
   * Use cases:
   *   - Disable rework: `{ REOPEN_FOR_CORRECTION: ["PV1_REJECTED"] }`
   *   - Forbid hold from a specific stage: `{ PLACE_HOLD: ["READY_TO_SHIP"] }`
   */
  readonly forbidTransitionsFromStates?: Readonly<
    Partial<Record<OrderWorkflowCommand, ReadonlyArray<OrderState>>>
  >;

  /**
   * Per-transition list of attestation requirements to add. Additive:
   * the merge result carries these in `attestationsByTransitionId` for
   * the named transition. Base v1 declares no attestations, so this is
   * always purely additive.
   *
   * Constraint: every key MUST be a `transitionId` declared in the base
   * policy. Listing an unknown id is rejected at merge time as
   * `OVERLAY_LOOSENS_BASE_POLICY` — the overlay is asserting that base
   * declares a transition it does not.
   *
   * Use cases:
   *   - Second-pharmacist controlled-substance PV1:
   *       { "wf.v1.approve_pv1": [{ id: "second-pharmacist", minSignatures: 2,
   *           permission: "pv1.approve",
   *           description: "Second PV1 signoff for CII–CV." }] }
   */
  readonly addRequiredAttestations?: Readonly<
    Record<string, ReadonlyArray<AttestationRequirement>>
  >;
}

// ---------------------------------------------------------------------------
// Merge function
// ---------------------------------------------------------------------------

/**
 * Compose a base `OrderWorkflowPolicy` with a per-tenant overlay,
 * returning a new (frozen) policy that is at most as permissive as
 * the base.
 *
 * Pure: no I/O, no clock, no entropy. Deterministic same-input →
 * same-output bytes (modulo `Object.freeze` identity).
 *
 * Failure mode: throws `ValidationError(OVERLAY_LOOSENS_BASE_POLICY)`
 * if the overlay attempts to widen the base, or references a
 * transition the base does not declare. The bus must catch this
 * BEFORE the workflow tx opens — a malformed overlay is a 400-class
 * failure (the admin's overlay row is invalid against the active
 * policy version), not a 5xx.
 *
 * Step ordering:
 *   1. Validate `forbidTransitionsFromStates` keys/values reference
 *      base-declared transitions.
 *   2. Validate `addRequiredAttestations` keys reference base-declared
 *      transitionIds.
 *   3. Filter base transitions, removing any `(command, fromState)` in
 *      the forbid set.
 *   4. Build attestations map by transitionId.
 *   5. Postcondition assert: merged transition set is a subset of base.
 *      (Defensive — catches future merge bugs that introduce a row
 *       not present in base.)
 *   6. Return a new frozen policy with the filtered transitions and
 *      the attestations map.
 *
 * Identity case: an empty overlay returns a policy structurally
 * equivalent to base (transitions are the same array reference,
 * `attestationsByTransitionId` is undefined).
 */
export function mergePolicyWithOverlay(
  base: OrderWorkflowPolicy,
  overlay: WorkflowPolicyOverlay
): OrderWorkflowPolicy {
  const forbid = overlay.forbidTransitionsFromStates;
  const addAttestations = overlay.addRequiredAttestations;

  const forbidEmpty = forbid === undefined || isEmptyObject(forbid);
  const attestationsEmpty = addAttestations === undefined || isEmptyObject(addAttestations);

  // Identity: empty overlay → return base unchanged. Same `transitions`
  // array reference so callers comparing by identity see no change.
  if (forbidEmpty && attestationsEmpty) {
    return base;
  }

  // Index base transitions by (command, fromState) and by transitionId
  // for cheap lookups during validation.
  const baseTransitionsByPair = new Map<string, OrderTransitionRow>();
  const baseTransitionIds = new Set<string>();
  for (const t of base.transitions) {
    baseTransitionsByPair.set(pairKey(t.command, t.fromState), t);
    baseTransitionIds.add(t.transitionId);
  }

  // Step 1 — validate forbid set. Every (command, state) listed must
  // exist in base. Otherwise the overlay is asserting a transition
  // base does not declare → reject as loosening.
  const forbidPairs = new Set<string>();
  if (forbid !== undefined) {
    for (const command of Object.keys(forbid) as OrderWorkflowCommand[]) {
      const states = forbid[command];
      if (states === undefined) continue;
      for (const state of states) {
        const key = pairKey(command, state);
        if (!baseTransitionsByPair.has(key)) {
          throw new errors.ValidationError({
            code: OVERLAY_LOOSENS_BASE_POLICY,
            message:
              `Overlay forbids (command=${command}, fromState=${state}) but the base policy ` +
              `${base.code} v${base.version} does not declare that transition. ` +
              `An overlay can only TIGHTEN base; referencing an unknown transition is a misconfiguration.`,
            metadata: {
              policyCode: base.code,
              policyVersion: base.version,
              command,
              fromState: state,
            },
          });
        }
        forbidPairs.add(key);
      }
    }
  }

  // Step 2 — validate attestations keys. Every transitionId must exist
  // in base.
  if (addAttestations !== undefined) {
    for (const transitionId of Object.keys(addAttestations)) {
      if (!baseTransitionIds.has(transitionId)) {
        throw new errors.ValidationError({
          code: OVERLAY_LOOSENS_BASE_POLICY,
          message:
            `Overlay adds attestations for transitionId=${transitionId} but the base policy ` +
            `${base.code} v${base.version} does not declare that transition. ` +
            `An overlay cannot add policy semantics for a transition the base does not have.`,
          metadata: {
            policyCode: base.code,
            policyVersion: base.version,
            transitionId,
          },
        });
      }
      // Defensive: forbid `minSignatures < 1` — a 0-signature requirement
      // is meaningless and almost certainly a config error.
      const requirements = addAttestations[transitionId] ?? [];
      for (const req of requirements) {
        if (req.minSignatures < 1) {
          throw new errors.ValidationError({
            code: OVERLAY_LOOSENS_BASE_POLICY,
            message:
              `Overlay attestation '${req.id}' on transitionId=${transitionId} declares ` +
              `minSignatures=${req.minSignatures}; must be >= 1.`,
            metadata: {
              policyCode: base.code,
              policyVersion: base.version,
              transitionId,
              attestationId: req.id,
              minSignatures: req.minSignatures,
            },
          });
        }
      }
    }
  }

  // Step 3 — filter base transitions, removing (command, fromState)
  // pairs in the forbid set. Preserves base order so transitionId
  // ordering is stable across merges.
  const filteredTransitions: OrderTransitionRow[] = [];
  for (const t of base.transitions) {
    if (forbidPairs.has(pairKey(t.command, t.fromState))) {
      continue;
    }
    filteredTransitions.push(t);
  }

  // Step 4 — build attestation map. Only retain entries whose
  // transition survived filtering (forbidding a transition wipes any
  // attestations declared for it).
  //
  // We START from any attestations the BASE already carries and
  // CONCAT the overlay's additions per transitionId. This is what
  // makes sequential merges associative:
  //   merge(merge(base, A), B) === merge(base, compose(A, B))
  // for any A, B. Without the concat, B's merge would replace A's
  // attestations, breaking the composition law that
  // `composeOverlays` relies on.
  let attestationsByTransitionId:
    | Readonly<Record<string, ReadonlyArray<AttestationRequirement>>>
    | undefined;
  const survivingTransitionIds = new Set(filteredTransitions.map((t) => t.transitionId));
  const map: Record<string, ReadonlyArray<AttestationRequirement>> = {};
  if (base.attestationsByTransitionId !== undefined) {
    for (const transitionId of Object.keys(base.attestationsByTransitionId)) {
      if (!survivingTransitionIds.has(transitionId)) continue;
      const baseReqs = base.attestationsByTransitionId[transitionId] ?? [];
      if (baseReqs.length === 0) continue;
      map[transitionId] = [...baseReqs];
    }
  }
  if (addAttestations !== undefined) {
    for (const transitionId of Object.keys(addAttestations)) {
      if (!survivingTransitionIds.has(transitionId)) continue;
      const requirements = addAttestations[transitionId] ?? [];
      if (requirements.length === 0) continue;
      const existing = map[transitionId] ?? [];
      map[transitionId] = [...existing, ...requirements];
    }
  }
  if (Object.keys(map).length > 0) {
    const frozen: Record<string, ReadonlyArray<AttestationRequirement>> = {};
    for (const k of Object.keys(map)) {
      frozen[k] = Object.freeze([...(map[k] ?? [])]);
    }
    attestationsByTransitionId = Object.freeze(frozen);
  }

  // Step 5 — postcondition assert. Every merged transition must be
  // present in base by reference (we filter, never construct). This
  // catches future merge-function bugs that would synthesize a row
  // not in base. Cheap (Set lookups), high security value.
  const baseTransitionSet = new Set(base.transitions);
  for (const t of filteredTransitions) {
    if (!baseTransitionSet.has(t)) {
      throw new errors.InternalError({
        code: OVERLAY_LOOSENS_BASE_POLICY,
        message:
          `Internal: merge produced a transition (id=${t.transitionId}) not present in base. ` +
          `This is a merge-function bug.`,
        metadata: {
          policyCode: base.code,
          policyVersion: base.version,
          transitionId: t.transitionId,
        },
      });
    }
  }

  // Step 6 — frozen result.
  const merged: OrderWorkflowPolicy = Object.freeze({
    code: base.code,
    version: base.version,
    states: base.states,
    terminalStates: base.terminalStates,
    transitions: Object.freeze(filteredTransitions),
    ...(attestationsByTransitionId === undefined ? {} : { attestationsByTransitionId }),
  });
  return merged;
}

// ---------------------------------------------------------------------------
// Multi-overlay composition (Tier 2 wiring)
// ---------------------------------------------------------------------------

/**
 * One per-tenant overlay row, as the resolver returns it. Carries
 * the metadata the bus needs to stamp on `command_log` /
 * `audit_log` / `event_outbox` so an incident reviewer can answer
 * "which overlay shaped this command?" without joining back to a
 * mutable admin table.
 *
 * `priority` drives ordering at apply time:
 *   - Lower number = applied earlier (outermost).
 *   - Same number = stable insertion order.
 *
 * The standard resolver order (per ADR 0019) is:
 *   priority 100 — org-wide overlay
 *   priority 200 — clinic overlay
 * Implementations choose the values; the engine treats `priority`
 * as opaque ordering.
 */
export interface WorkflowPolicyOverlayBinding {
  /** Stable id of the overlay row (UUID). */
  readonly id: string;
  /**
   * Monotonically-increasing version. Every commit of a new
   * overlay row INCREMENTS this number; activations never re-use
   * a version because the audit chain cites it.
   */
  readonly version: number;
  /** Apply order; lower = outer. */
  readonly priority: number;
  /** Human-friendly label for diagnostics; non-PHI. */
  readonly label?: string;
  /** Clinic this overlay is scoped to; absent = org-wide. */
  readonly clinicId?: string;
  /** The actual declarative overlay shape. */
  readonly overlay: WorkflowPolicyOverlay;
}

/**
 * Snapshot returned by the per-tenant resolver. The bus passes
 * this through to handlers via the `loadPolicy` step; the merged
 * policy is what `applyTransition` evaluates against.
 *
 * The snapshot is IMMUTABLE — once captured, it is replay-correct
 * for the lifetime of the command, even if a sibling worker
 * activates a new overlay while the command is in flight. That is
 * the load-bearing snapshot semantic from ADR 0019: in-flight
 * commands NEVER observe a mid-flight overlay activation.
 */
export interface MergedWorkflowPolicy {
  /** Base policy row id (FK into `workflow_policy`). */
  readonly basePolicyId: string;
  /** Base policy version stamped on the order. */
  readonly basePolicyVersion: number;
  /** The pristine base policy as fetched from `workflow_policy`. */
  readonly basePolicy: OrderWorkflowPolicy;
  /**
   * Bindings consumed by this snapshot, in apply order. Empty
   * when no overlays are active for the tenant. Cited verbatim on
   * `command_log.overlayBindings` by the bus.
   */
  readonly overlays: ReadonlyArray<WorkflowPolicyOverlayBinding>;
  /**
   * Result of `applyOverlays(basePolicy, overlays)`. Same shape as
   * `OrderWorkflowPolicy` so existing engine helpers
   * (`applyTransition`, `canTransition`, `getReachableCommands`)
   * accept it unchanged.
   */
  readonly merged: OrderWorkflowPolicy;
}

/**
 * Compose N overlays into one. The composition rule:
 *
 *   - `forbidTransitionsFromStates`: per-command set union over
 *     every input overlay. Set semantics: duplicates collapse;
 *     subset relationships preserved.
 *   - `addRequiredAttestations`: per-transitionId concatenation.
 *     Order follows the input array; same-id requirements are
 *     concatenated (the merge is fail-closed against duplicates
 *     only when activation policy mandates uniqueness — which is
 *     out of scope here, so we let bookkeeping at the caller drop
 *     duplicates if needed).
 *
 * Pure: no I/O, no clock, no exceptions.
 *
 * Composition law (proven by tests in policy-overlay.test.ts):
 *   apply(base, [A, B]) === apply(base, [compose(A, B)])
 *   compose(A, compose(B, C)) === compose(compose(A, B), C)
 *
 * Empty input → empty overlay (the identity element of the
 * monoid). One overlay → returned unchanged.
 */
export function composeOverlays(
  ...overlays: ReadonlyArray<WorkflowPolicyOverlay>
): WorkflowPolicyOverlay {
  if (overlays.length === 0) return Object.freeze({});
  if (overlays.length === 1) return overlays[0]!;

  const forbidUnion: Partial<Record<OrderWorkflowCommand, OrderState[]>> = {};
  const attestationsConcat: Record<string, AttestationRequirement[]> = {};

  for (const overlay of overlays) {
    if (overlay.forbidTransitionsFromStates !== undefined) {
      for (const command of Object.keys(
        overlay.forbidTransitionsFromStates
      ) as OrderWorkflowCommand[]) {
        const states = overlay.forbidTransitionsFromStates[command];
        if (states === undefined) continue;
        const existing = forbidUnion[command] ?? [];
        const seen = new Set(existing);
        for (const s of states) {
          if (!seen.has(s)) {
            existing.push(s);
            seen.add(s);
          }
        }
        forbidUnion[command] = existing;
      }
    }
    if (overlay.addRequiredAttestations !== undefined) {
      for (const transitionId of Object.keys(overlay.addRequiredAttestations)) {
        const reqs = overlay.addRequiredAttestations[transitionId] ?? [];
        if (reqs.length === 0) continue;
        const existing = attestationsConcat[transitionId] ?? [];
        existing.push(...reqs);
        attestationsConcat[transitionId] = existing;
      }
    }
  }

  const out: {
    forbidTransitionsFromStates?: Readonly<
      Partial<Record<OrderWorkflowCommand, ReadonlyArray<OrderState>>>
    >;
    addRequiredAttestations?: Readonly<Record<string, ReadonlyArray<AttestationRequirement>>>;
  } = {};

  if (Object.keys(forbidUnion).length > 0) {
    const frozen: Partial<Record<OrderWorkflowCommand, ReadonlyArray<OrderState>>> = {};
    for (const c of Object.keys(forbidUnion) as OrderWorkflowCommand[]) {
      frozen[c] = Object.freeze([...(forbidUnion[c] ?? [])]);
    }
    out.forbidTransitionsFromStates = Object.freeze(frozen);
  }
  if (Object.keys(attestationsConcat).length > 0) {
    const frozen: Record<string, ReadonlyArray<AttestationRequirement>> = {};
    for (const t of Object.keys(attestationsConcat)) {
      frozen[t] = Object.freeze([...(attestationsConcat[t] ?? [])]);
    }
    out.addRequiredAttestations = Object.freeze(frozen);
  }
  return Object.freeze(out);
}

/**
 * Apply an ordered list of overlays to a base policy, returning
 * the merged `OrderWorkflowPolicy`.
 *
 * Implementation detail: composes the overlays first via
 * `composeOverlays`, then runs `mergePolicyWithOverlay` ONCE. This
 * guarantees the associativity law holds by construction: there
 * is no observable difference between applying overlays one at a
 * time vs. composing first.
 *
 * Determinism: same inputs (including overlay order) → same
 * output bytes. The merge function is pure; composition is pure.
 *
 * Failure mode: any overlay that would loosen the base throws
 * `ValidationError(OVERLAY_LOOSENS_BASE_POLICY)`. The merge is
 * still all-or-nothing: a malformed overlay halts the apply and
 * the bus treats it as a 400-class failure (admin's overlay row
 * is invalid against the active base; re-author it).
 */
export function applyOverlays(
  base: OrderWorkflowPolicy,
  overlays: ReadonlyArray<WorkflowPolicyOverlay>
): OrderWorkflowPolicy {
  if (overlays.length === 0) return base;
  const composed = composeOverlays(...overlays);
  return mergePolicyWithOverlay(base, composed);
}

/**
 * Build a `MergedWorkflowPolicy` snapshot from a base + bindings.
 * Bindings are sorted by `priority` (ascending; stable for ties)
 * before composition so the resolver can pass them in any order.
 *
 * The returned object is frozen. Callers MAY rely on object
 * identity equality across calls with the same inputs as a
 * convenience (the inner `merged` policy will be the SAME object
 * if the merge was a no-op).
 */
export function buildMergedPolicy(input: {
  readonly basePolicy: OrderWorkflowPolicy;
  readonly basePolicyId: string;
  readonly basePolicyVersion: number;
  readonly bindings: ReadonlyArray<WorkflowPolicyOverlayBinding>;
}): MergedWorkflowPolicy {
  // Stable sort by priority. Array.prototype.sort is stable in
  // modern engines; we rely on that here for deterministic apply
  // order across same-priority bindings.
  const ordered = [...input.bindings].sort((a, b) => a.priority - b.priority);
  const merged = applyOverlays(
    input.basePolicy,
    ordered.map((b) => b.overlay)
  );
  return Object.freeze({
    basePolicyId: input.basePolicyId,
    basePolicyVersion: input.basePolicyVersion,
    basePolicy: input.basePolicy,
    overlays: Object.freeze(ordered),
    merged,
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function pairKey(command: OrderWorkflowCommand, state: OrderState): string {
  return `${command}|${state}`;
}

function isEmptyObject(o: Readonly<Record<string, unknown>>): boolean {
  for (const k in o) {
    if (Object.prototype.hasOwnProperty.call(o, k)) return false;
  }
  return true;
}
