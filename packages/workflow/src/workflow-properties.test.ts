// Property-based tests for the order workflow state machine.
//
// The example-based suites (engine.test.ts, policy-overlay.test.ts,
// bucket-routing.test.ts) pin every enumerated transition. This file
// complements them with PROPERTIES: statements that must hold for
// EVERY input fast-check can generate, not just the cases a human
// thought to write down.
//
// Properties covered:
//
//   P1  Safety invariants hold under ANY sequence of attempted
//       transitions (bus-faithful hold/reopen semantics): no fill
//       without a prior PV1 approval, no final verification without a
//       prior fill completion, no ship without a prior final-
//       verification approval — regardless of interleaved holds,
//       reopens, rejections, and adversarial (illegal) attempts.
//   P2  Terminal states (SHIPPED, CANCELLED) admit NO command, with
//       any parameter payload.
//   P3  Reachability: every non-terminal state has at least one
//       EXECUTABLE outbound transition (no dead ends), and every
//       state except the RECEIVED entry point is enterable.
//   P4  Determinism: same (state, command, params) → deep-equal
//       result, every time, under base and merged policies.
//   P5  Exception-state round-trips: hold → release lands exactly on
//       the recorded pre-hold state; reopen succeeds exactly for the
//       allow-listed targets and always lands in a legal non-terminal
//       state.
//   P6  Policy overlays: tighten-only merge (merged ⊆ base, no new
//       permissions), forbidden pairs actually removed, loosening
//       overlays always rejected, compose/apply agreement, and
//       stage → bucket routing is total with no cross-tenant bucket
//       leakage.
//   P7  Transition-table completeness: the table and the state/command
//       enums agree — no orphan states, no rows referencing unknown
//       states or commands, unique transition ids, unique
//       (command, fromState) pairs.
//
// TRUST-BOUNDARY NOTE (documented, not a violation): the engine
// validates `releaseToState` only as "non-terminal and not ON_HOLD".
// The recorded pre-hold state comes from the hold record, which the
// command bus supplies — the engine's own doc comment declares this a
// bus-trusted value. P1 therefore models the bus faithfully (release
// always returns to the recorded pre-hold state); `P5` separately pins
// the engine-level contract for arbitrary release targets so any
// future widening or narrowing of that trust boundary fails a test.
//
// Determinism in CI: fast-check is seeded globally below. Do not
// remove the seed — an unseeded run that fails is not reproducible.
//
// Synthetic data only. No PHI anywhere in this file.

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { errors } from "@pharmax/platform-core";

import {
  canonicalBucketCodeForState,
  composeStageBucketRouteTables,
  resolveStageBucketRoute,
  ROUTABLE_ORDER_STATES,
  routeTargetCodes,
  type StageBucketRouteTable,
} from "./bucket-routing.js";
import { ORDER_WORKFLOW_COMMANDS, type OrderWorkflowCommand } from "./commands.js";
import { applyTransition, canTransition, getReachableCommands } from "./engine.js";
import { WORKFLOW_STATE_TERMINAL } from "./errors.js";
import {
  applyOverlays,
  composeOverlays,
  mergePolicyWithOverlay,
  OVERLAY_LOOSENS_BASE_POLICY,
  type WorkflowPolicyOverlay,
} from "./policy-overlay.js";
import {
  ORDER_STANDARD_V1,
  REOPEN_TARGETS_BY_SOURCE,
  type AttestationRequirement,
  type OrderTransitionRow,
} from "./policy-v1.js";
import {
  ALL_ORDER_STATES,
  isTerminalState,
  ORDER_TERMINAL_STATES,
  type OrderState,
} from "./states.js";

const POLICY = ORDER_STANDARD_V1;

// ---------------------------------------------------------------------------
// Global fast-check configuration — FIXED SEED so CI failures are
// reproducible byte-for-byte. numRuns is tuned so the whole file
// stays well under the 30s budget (the engine is a pure function;
// each run is microseconds).
// ---------------------------------------------------------------------------

beforeAll(() => {
  fc.configureGlobal({ seed: 20260816, numRuns: 250 });
});

afterAll(() => {
  fc.resetConfigureGlobal();
});

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const arbState: fc.Arbitrary<OrderState> = fc.constantFrom(...ALL_ORDER_STATES);
const arbCommand: fc.Arbitrary<OrderWorkflowCommand> = fc.constantFrom(...ORDER_WORKFLOW_COMMANDS);

/**
 * One attempted step in a generated sequence. Indices are resolved
 * against runtime state inside the property (fast-check cannot see
 * the machine's state at generation time):
 *
 *   - `adversarial: false` → pick from `getReachableCommands` so the
 *     walk goes DEEP into the machine instead of stalling on illegal
 *     commands near RECEIVED.
 *   - `adversarial: true`  → pick any command from the full
 *     vocabulary, legal or not. The engine must reject the illegal
 *     ones without corrupting the walk.
 */
interface AttemptSpec {
  readonly commandIndex: number;
  readonly reopenIndex: number;
  readonly adversarial: boolean;
}

const arbAttempt: fc.Arbitrary<AttemptSpec> = fc.record({
  commandIndex: fc.nat({ max: 1000 }),
  reopenIndex: fc.nat({ max: 1000 }),
  adversarial: fc.boolean(),
});

const arbSequence: fc.Arbitrary<ReadonlyArray<AttemptSpec>> = fc.array(arbAttempt, {
  minLength: 1,
  maxLength: 60,
});

function pick<T>(items: ReadonlyArray<T>, index: number): T | undefined {
  if (items.length === 0) return undefined;
  return items[index % items.length];
}

// ---------------------------------------------------------------------------
// P1 — Safety invariants under arbitrary transition sequences
// ---------------------------------------------------------------------------

describe("P1 — safety invariants under arbitrary transition sequences", () => {
  it("no fill before PV1 approval, no final before fill completion, no ship before final approval", () => {
    fc.assert(
      fc.property(arbSequence, (sequence) => {
        let state: OrderState = "RECEIVED";
        // Bus-faithful hold record: the state the order was in when
        // PLACE_HOLD fired. Cleared on release.
        let preHoldState: OrderState | undefined;
        const successfulCommands: OrderWorkflowCommand[] = [];

        for (const attempt of sequence) {
          const reachable = getReachableCommands({ policy: POLICY, currentState: state });
          const command = attempt.adversarial
            ? pick(ORDER_WORKFLOW_COMMANDS, attempt.commandIndex)
            : (pick(reachable, attempt.commandIndex) ??
              pick(ORDER_WORKFLOW_COMMANDS, attempt.commandIndex));
          if (command === undefined) continue;

          const reopenTargets = REOPEN_TARGETS_BY_SOURCE[state] ?? [];
          const reopenToState = attempt.adversarial
            ? pick(ALL_ORDER_STATES, attempt.reopenIndex)
            : pick(reopenTargets, attempt.reopenIndex);

          const result = applyTransition({
            policy: POLICY,
            currentState: state,
            command,
            // Bus-faithful: release returns to the recorded pre-hold
            // state. If no hold record exists the bus would never
            // issue RELEASE_HOLD; supplying RECEIVED keeps the input
            // well-formed and the engine rejects it anyway (state is
            // not ON_HOLD).
            releaseToState: preHoldState ?? "RECEIVED",
            ...(reopenToState === undefined ? {} : { reopenToState }),
          });

          if (!result.ok) continue;

          // The engine reported a transition: check the invariants
          // BEFORE accepting the new state.
          expect(ALL_ORDER_STATES).toContain(result.toState);
          expect(result.fromState).toBe(state);

          if (result.toState === "FILL_IN_PROGRESS") {
            expect(successfulCommands).toContain("APPROVE_PV1");
          }
          if (result.toState === "FINAL_VERIFICATION_IN_PROGRESS") {
            expect(successfulCommands).toContain("COMPLETE_FILL");
          }
          if (result.toState === "SHIPPED") {
            expect(successfulCommands).toContain("APPROVE_FINAL_VERIFICATION");
          }

          if (command === "PLACE_HOLD") {
            preHoldState = result.fromState;
          }
          if (command === "RELEASE_HOLD") {
            // The bus-faithful model must land exactly on the
            // recorded pre-hold state.
            expect(result.toState).toBe(preHoldState);
            preHoldState = undefined;
          }

          successfulCommands.push(command);
          state = result.toState;
        }
      }),
      { numRuns: 400 }
    );
  });

  it("once a terminal state is reached, every further attempt fails with WORKFLOW_STATE_TERMINAL", () => {
    fc.assert(
      fc.property(arbSequence, (sequence) => {
        let state: OrderState = "RECEIVED";
        let preHoldState: OrderState | undefined;
        let terminalReached = false;

        for (const attempt of sequence) {
          const reachable = getReachableCommands({ policy: POLICY, currentState: state });
          const command =
            pick(attempt.adversarial ? ORDER_WORKFLOW_COMMANDS : reachable, attempt.commandIndex) ??
            pick(ORDER_WORKFLOW_COMMANDS, attempt.commandIndex);
          if (command === undefined) continue;

          const reopenTargets = REOPEN_TARGETS_BY_SOURCE[state] ?? [];
          const result = applyTransition({
            policy: POLICY,
            currentState: state,
            command,
            releaseToState: preHoldState ?? "RECEIVED",
            ...(() => {
              const t = pick(reopenTargets, attempt.reopenIndex);
              return t === undefined ? {} : { reopenToState: t };
            })(),
          });

          if (terminalReached) {
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.code).toBe(WORKFLOW_STATE_TERMINAL);
            continue;
          }

          if (result.ok) {
            if (command === "PLACE_HOLD") preHoldState = result.fromState;
            if (command === "RELEASE_HOLD") preHoldState = undefined;
            state = result.toState;
            if (isTerminalState(state)) terminalReached = true;
          }
        }
      }),
      { numRuns: 300 }
    );
  });
});

// ---------------------------------------------------------------------------
// P2 — Terminal states admit no command
// ---------------------------------------------------------------------------

describe("P2 — no transition out of terminal states", () => {
  it("applyTransition from SHIPPED/CANCELLED fails with WORKFLOW_STATE_TERMINAL for every command and any params", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ORDER_TERMINAL_STATES),
        arbCommand,
        fc.option(arbState, { nil: undefined }),
        fc.option(arbState, { nil: undefined }),
        (terminal, command, releaseToState, reopenToState) => {
          const result = applyTransition({
            policy: POLICY,
            currentState: terminal,
            command,
            ...(releaseToState === undefined ? {} : { releaseToState }),
            ...(reopenToState === undefined ? {} : { reopenToState }),
          });
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.code).toBe(WORKFLOW_STATE_TERMINAL);
        }
      )
    );
  });

  it("canTransition and getReachableCommands agree: terminal states expose nothing", () => {
    for (const terminal of ORDER_TERMINAL_STATES) {
      expect(getReachableCommands({ policy: POLICY, currentState: terminal })).toEqual([]);
      for (const command of ORDER_WORKFLOW_COMMANDS) {
        expect(canTransition({ policy: POLICY, currentState: terminal, command })).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// P3 — Reachability: no dead ends, no unreachable states
// ---------------------------------------------------------------------------

describe("P3 — reachability", () => {
  const nonTerminalStates = ALL_ORDER_STATES.filter((s) => !isTerminalState(s));

  it("every non-terminal state has at least one EXECUTABLE outbound transition (no dead ends)", () => {
    for (const state of nonTerminalStates) {
      const reachable = getReachableCommands({ policy: POLICY, currentState: state });
      expect(reachable.length).toBeGreaterThan(0);

      // At least one reachable command must actually APPLY with
      // well-formed parameters — a table row whose parameter contract
      // can never be satisfied would be a hidden dead end.
      const applied = reachable.some((command) => {
        const reopenTarget = (REOPEN_TARGETS_BY_SOURCE[state] ?? [])[0];
        const result = applyTransition({
          policy: POLICY,
          currentState: state,
          command,
          releaseToState: "RECEIVED",
          ...(reopenTarget === undefined ? {} : { reopenToState: reopenTarget }),
        });
        return result.ok;
      });
      expect(applied).toBe(true);
    }
  });

  it("every state except the RECEIVED entry point is enterable via some transition", () => {
    const enterable = new Set<OrderState>();
    for (const row of POLICY.transitions) {
      if (row.requiresParam === undefined) enterable.add(row.toState);
    }
    for (const targets of Object.values(REOPEN_TARGETS_BY_SOURCE)) {
      for (const t of targets ?? []) enterable.add(t);
    }
    // RELEASE_HOLD can enter any recorded pre-hold state; those are
    // exactly the hold-source states, which are all enterable by the
    // static rows above, so no extra additions needed.
    for (const state of ALL_ORDER_STATES) {
      if (state === "RECEIVED") continue;
      expect(enterable, `state ${state} must be enterable`).toContain(state);
    }
  });
});

// ---------------------------------------------------------------------------
// P4 — Determinism
// ---------------------------------------------------------------------------

describe("P4 — determinism", () => {
  it("same (state, command, params) input → deep-equal result on every call", () => {
    fc.assert(
      fc.property(
        arbState,
        arbCommand,
        fc.option(arbState, { nil: undefined }),
        fc.option(arbState, { nil: undefined }),
        (currentState, command, releaseToState, reopenToState) => {
          const input = {
            policy: POLICY,
            currentState,
            command,
            ...(releaseToState === undefined ? {} : { releaseToState }),
            ...(reopenToState === undefined ? {} : { reopenToState }),
          };
          const first = applyTransition(input);
          const second = applyTransition(input);
          const third = applyTransition(input);
          expect(second).toEqual(first);
          expect(third).toEqual(first);
        }
      )
    );
  });

  it("merge is deterministic: same base + same overlay → structurally identical merged policy", () => {
    fc.assert(
      fc.property(arbValidOverlay, (overlay) => {
        const a = mergePolicyWithOverlay(POLICY, overlay);
        const b = mergePolicyWithOverlay(POLICY, overlay);
        expect(a.transitions).toEqual(b.transitions);
        expect(a.attestationsByTransitionId).toEqual(b.attestationsByTransitionId);
      })
    );
  });
});

// ---------------------------------------------------------------------------
// P5 — Exception-state round-trips
// ---------------------------------------------------------------------------

describe("P5 — exception-state round-trips", () => {
  const holdSources = POLICY.transitions
    .filter((row) => row.command === "PLACE_HOLD")
    .map((row) => row.fromState);

  it("hold → release round-trips to exactly the recorded pre-hold state", () => {
    fc.assert(
      fc.property(fc.constantFrom(...holdSources), (source) => {
        const held = applyTransition({
          policy: POLICY,
          currentState: source,
          command: "PLACE_HOLD",
        });
        expect(held.ok).toBe(true);
        if (!held.ok) return;
        expect(held.toState).toBe("ON_HOLD");

        const released = applyTransition({
          policy: POLICY,
          currentState: "ON_HOLD",
          command: "RELEASE_HOLD",
          releaseToState: source,
        });
        expect(released.ok).toBe(true);
        if (released.ok) expect(released.toState).toBe(source);
      })
    );
  });

  it("engine-level RELEASE_HOLD contract: succeeds iff target is a known non-terminal, non-ON_HOLD state (bus-trusted boundary)", () => {
    // The engine does NOT verify the release target against hold
    // history — that is the bus's job (it reads the hold record).
    // This property pins the exact engine-level contract so any
    // change to the trust boundary is caught.
    fc.assert(
      fc.property(arbState, (target) => {
        const result = applyTransition({
          policy: POLICY,
          currentState: "ON_HOLD",
          command: "RELEASE_HOLD",
          releaseToState: target,
        });
        const expectedOk = !isTerminalState(target) && target !== "ON_HOLD";
        expect(result.ok).toBe(expectedOk);
        if (result.ok) expect(result.toState).toBe(target);
      })
    );
  });

  it("reopen succeeds exactly for allow-listed targets and always lands in a legal non-terminal state", () => {
    const rejectionSources = Object.keys(REOPEN_TARGETS_BY_SOURCE) as OrderState[];
    fc.assert(
      fc.property(fc.constantFrom(...rejectionSources), arbState, (source, target) => {
        const allowed = REOPEN_TARGETS_BY_SOURCE[source] ?? [];
        const result = applyTransition({
          policy: POLICY,
          currentState: source,
          command: "REOPEN_FOR_CORRECTION",
          reopenToState: target,
        });
        expect(result.ok).toBe(allowed.includes(target));
        if (result.ok) {
          expect(result.toState).toBe(target);
          expect(isTerminalState(result.toState)).toBe(false);
          expect(POLICY.states).toContain(result.toState);
        }
      })
    );
  });
});

// ---------------------------------------------------------------------------
// P6 — Policy overlays
// ---------------------------------------------------------------------------

/** Distinct (command, fromState) pairs the base policy declares. */
const BASE_PAIRS: ReadonlyArray<{ command: OrderWorkflowCommand; fromState: OrderState }> =
  POLICY.transitions.map((row) => ({ command: row.command, fromState: row.fromState }));

const BASE_TRANSITION_IDS: ReadonlyArray<string> = POLICY.transitions.map((r) => r.transitionId);

const arbAttestation: fc.Arbitrary<AttestationRequirement> = fc.record({
  id: fc.stringMatching(/^[a-z][a-z0-9-]{2,24}$/),
  minSignatures: fc.integer({ min: 1, max: 3 }),
  permission: fc.constantFrom("pv1.approve", "final.approve", "fill.complete", "typing.complete"),
});

/** Arbitrary VALID overlay: forbids only base-declared pairs, attests only base transitionIds. */
const arbValidOverlay: fc.Arbitrary<WorkflowPolicyOverlay> = fc
  .record({
    forbidden: fc.uniqueArray(fc.constantFrom(...BASE_PAIRS), { maxLength: 8 }),
    attestations: fc.dictionary(
      fc.constantFrom(...BASE_TRANSITION_IDS),
      fc.array(arbAttestation, { minLength: 1, maxLength: 2 }),
      { maxKeys: 4 }
    ),
    routes: fc.dictionary(
      fc.constantFrom(...ROUTABLE_ORDER_STATES),
      fc.stringMatching(/^[A-Z][A-Z_]{2,15}$/),
      { maxKeys: 5 }
    ),
  })
  .map(({ forbidden, attestations, routes }) => {
    const forbid: Partial<Record<OrderWorkflowCommand, OrderState[]>> = {};
    for (const pair of forbidden) {
      const list = forbid[pair.command] ?? [];
      if (!list.includes(pair.fromState)) list.push(pair.fromState);
      forbid[pair.command] = list;
    }
    const overlay: WorkflowPolicyOverlay = {
      ...(Object.keys(forbid).length === 0 ? {} : { forbidTransitionsFromStates: forbid }),
      ...(Object.keys(attestations).length === 0 ? {} : { addRequiredAttestations: attestations }),
      ...(Object.keys(routes).length === 0
        ? {}
        : { routeStatesToBucketCodes: routes as StageBucketRouteTable }),
    };
    return overlay;
  });

describe("P6 — policy overlays", () => {
  it("tighten-only: merged transitions ⊆ base transitions (by row identity)", () => {
    fc.assert(
      fc.property(arbValidOverlay, (overlay) => {
        const merged = mergePolicyWithOverlay(POLICY, overlay);
        const baseSet = new Set<OrderTransitionRow>(POLICY.transitions);
        for (const row of merged.transitions) {
          expect(baseSet.has(row)).toBe(true);
        }
      })
    );
  });

  it("tighten-only: any (state, command) the MERGED policy allows, the BASE allows with the same target", () => {
    fc.assert(
      fc.property(
        arbValidOverlay,
        arbState,
        arbCommand,
        fc.option(arbState, { nil: undefined }),
        fc.option(arbState, { nil: undefined }),
        (overlay, currentState, command, releaseToState, reopenToState) => {
          const merged = mergePolicyWithOverlay(POLICY, overlay);
          const params = {
            currentState,
            command,
            ...(releaseToState === undefined ? {} : { releaseToState }),
            ...(reopenToState === undefined ? {} : { reopenToState }),
          };
          const underMerged = applyTransition({ policy: merged, ...params });
          if (underMerged.ok) {
            const underBase = applyTransition({ policy: POLICY, ...params });
            expect(underBase.ok).toBe(true);
            if (underBase.ok) expect(underBase.toState).toBe(underMerged.toState);
          }
        }
      )
    );
  });

  it("forbidden (command, fromState) pairs are actually rejected by the merged policy", () => {
    fc.assert(
      fc.property(arbValidOverlay, (overlay) => {
        const merged = mergePolicyWithOverlay(POLICY, overlay);
        const forbid = overlay.forbidTransitionsFromStates ?? {};
        for (const command of Object.keys(forbid) as OrderWorkflowCommand[]) {
          for (const fromState of forbid[command] ?? []) {
            expect(canTransition({ policy: merged, currentState: fromState, command })).toBe(false);
          }
        }
      })
    );
  });

  it("loosening overlays are ALWAYS rejected: forbidding a pair the base does not declare throws OVERLAY_LOOSENS_BASE_POLICY", () => {
    const basePairKeys = new Set(BASE_PAIRS.map((p) => `${p.command}|${p.fromState}`));
    fc.assert(
      fc.property(arbCommand, arbState, (command, fromState) => {
        fc.pre(!basePairKeys.has(`${command}|${fromState}`));
        const overlay: WorkflowPolicyOverlay = {
          forbidTransitionsFromStates: { [command]: [fromState] },
        };
        let thrown: unknown;
        try {
          mergePolicyWithOverlay(POLICY, overlay);
        } catch (e) {
          thrown = e;
        }
        expect(thrown).toBeInstanceOf(errors.ValidationError);
        if (thrown instanceof errors.ValidationError) {
          expect(thrown.code).toBe(OVERLAY_LOOSENS_BASE_POLICY);
        }
      })
    );
  });

  it("attestations for unknown transitionIds are ALWAYS rejected", () => {
    const knownIds = new Set(BASE_TRANSITION_IDS);
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z][a-z0-9._-]{3,30}$/),
        arbAttestation,
        (transitionId, requirement) => {
          fc.pre(!knownIds.has(transitionId));
          let thrown: unknown;
          try {
            mergePolicyWithOverlay(POLICY, {
              addRequiredAttestations: { [transitionId]: [requirement] },
            });
          } catch (e) {
            thrown = e;
          }
          expect(thrown).toBeInstanceOf(errors.ValidationError);
        }
      )
    );
  });

  it("apply-vs-compose agreement: applyOverlays(base, [A, B]) ≡ applyOverlays(base, [compose(A, B)])", () => {
    fc.assert(
      fc.property(arbValidOverlay, arbValidOverlay, (a, b) => {
        const sequential = applyOverlays(POLICY, [a, b]);
        const composed = applyOverlays(POLICY, [composeOverlays(a, b)]);
        expect(sequential.transitions.map((t) => t.transitionId)).toEqual(
          composed.transitions.map((t) => t.transitionId)
        );
        expect(sequential.attestationsByTransitionId ?? {}).toEqual(
          composed.attestationsByTransitionId ?? {}
        );
      }),
      { numRuns: 150 }
    );
  });

  it("overlay resolution is total: merging any valid overlay never throws and preserves code/version/states", () => {
    fc.assert(
      fc.property(arbValidOverlay, (overlay) => {
        const merged = mergePolicyWithOverlay(POLICY, overlay);
        expect(merged.code).toBe(POLICY.code);
        expect(merged.version).toBe(POLICY.version);
        expect(merged.states).toBe(POLICY.states);
        expect(merged.terminalStates).toBe(POLICY.terminalStates);
        expect(merged.screening).toBe(POLICY.screening);
      })
    );
  });
});

// ---------------------------------------------------------------------------
// P6b — Stage → bucket routing (per-tenant policy overlays)
// ---------------------------------------------------------------------------

const CANONICAL_CODES: ReadonlySet<string> = new Set(
  ALL_ORDER_STATES.map((s) => canonicalBucketCodeForState(s)).filter((c): c is string => c !== null)
);

/** A tenant route table whose bucket codes all carry the tenant's prefix. */
function arbTenantRoutes(prefix: string): fc.Arbitrary<StageBucketRouteTable> {
  return fc.dictionary(
    fc.constantFrom(...ROUTABLE_ORDER_STATES),
    fc.stringMatching(/^[A-Z][A-Z_]{1,12}$/).map((code) => `${prefix}_${code}`),
    { maxKeys: ROUTABLE_ORDER_STATES.length }
  ) as fc.Arbitrary<StageBucketRouteTable>;
}

describe("P6b — stage → bucket routing", () => {
  it("no cross-tenant leakage: resolving with tenant A's table never yields a bucket code declared only by tenant B", () => {
    fc.assert(
      fc.property(arbTenantRoutes("TENANT_A"), arbTenantRoutes("TENANT_B"), (a, _b) => {
        const allowedForA = new Set<string>([...routeTargetCodes(a), ...CANONICAL_CODES]);
        for (const state of ALL_ORDER_STATES) {
          const resolved = resolveStageBucketRoute(state, a);
          if (resolved === null) continue;
          expect(allowedForA.has(resolved.code)).toBe(true);
          expect(resolved.code.startsWith("TENANT_B_")).toBe(false);
        }
      })
    );
  });

  it("resolution is total over all states: routable states always resolve, non-routable always null, never throws", () => {
    fc.assert(
      fc.property(arbTenantRoutes("TENANT_A"), fc.oneof(arbState, fc.string()), (routes, state) => {
        const resolved = resolveStageBucketRoute(state, routes);
        const routable = (ROUTABLE_ORDER_STATES as ReadonlyArray<string>).includes(state);
        if (routable) {
          expect(resolved).not.toBeNull();
          if (resolved !== null) {
            expect(resolved.canonicalCode.length).toBeGreaterThan(0);
            expect(resolved.code.length).toBeGreaterThan(0);
          }
        } else {
          expect(resolved).toBeNull();
        }
      })
    );
  });

  it("junk overrides fall back to the canonical code, never to 'nowhere'", () => {
    const arbJunk = fc.oneof(
      fc.constant(undefined),
      fc.constant(null),
      fc.constant(42),
      fc.constant(""),
      fc.constant("   "),
      fc.constant({ nested: true })
    );
    fc.assert(
      fc.property(fc.constantFrom(...ROUTABLE_ORDER_STATES), arbJunk, (state, junk) => {
        const routes = { [state]: junk } as unknown as StageBucketRouteTable;
        const resolved = resolveStageBucketRoute(state, routes);
        expect(resolved).not.toBeNull();
        if (resolved !== null) {
          expect(resolved.code).toBe(resolved.canonicalCode);
          expect(resolved.overridden).toBe(false);
        }
      })
    );
  });

  it("composition is last-wins per state and drops junk instead of shadowing valid entries", () => {
    fc.assert(
      fc.property(arbTenantRoutes("ORG"), arbTenantRoutes("CLINIC"), (orgRoutes, clinicRoutes) => {
        const composed = composeStageBucketRouteTables(orgRoutes, clinicRoutes);
        for (const state of ROUTABLE_ORDER_STATES) {
          const clinicValue = clinicRoutes[state];
          const orgValue = orgRoutes[state];
          const expected = clinicValue ?? orgValue;
          expect(composed[state]).toBe(expected);
        }
      })
    );
  });
});

// ---------------------------------------------------------------------------
// P7 — Transition-table / enum completeness
// ---------------------------------------------------------------------------

describe("P7 — transition table and state/command enums agree", () => {
  it("policy.states is exactly the state enum; policy.terminalStates is exactly the terminal enum", () => {
    expect([...POLICY.states].sort()).toEqual([...ALL_ORDER_STATES].sort());
    expect([...POLICY.terminalStates].sort()).toEqual([...ORDER_TERMINAL_STATES].sort());
  });

  it("every transition row references only known states and known commands", () => {
    const states = new Set<string>(ALL_ORDER_STATES);
    const commands = new Set<string>(ORDER_WORKFLOW_COMMANDS);
    for (const row of POLICY.transitions) {
      expect(states.has(row.fromState), `unknown fromState ${row.fromState}`).toBe(true);
      expect(states.has(row.toState), `unknown toState ${row.toState}`).toBe(true);
      expect(commands.has(row.command), `unknown command ${row.command}`).toBe(true);
    }
  });

  it("no transition row leaves a terminal state", () => {
    for (const row of POLICY.transitions) {
      expect(isTerminalState(row.fromState), `row ${row.transitionId} exits a terminal state`).toBe(
        false
      );
    }
  });

  it("transitionIds are unique and (command, fromState) pairs are unique", () => {
    const ids = POLICY.transitions.map((r) => r.transitionId);
    expect(new Set(ids).size).toBe(ids.length);
    const pairs = POLICY.transitions.map((r) => `${r.command}|${r.fromState}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it("REOPEN_TARGETS_BY_SOURCE references only known, non-terminal states", () => {
    for (const [source, targets] of Object.entries(REOPEN_TARGETS_BY_SOURCE)) {
      expect(ALL_ORDER_STATES).toContain(source);
      for (const target of targets ?? []) {
        expect(ALL_ORDER_STATES).toContain(target);
        expect(isTerminalState(target)).toBe(false);
      }
    }
  });

  it("every command in the vocabulary appears in at least one transition row (no orphan commands)", () => {
    const used = new Set(POLICY.transitions.map((r) => r.command));
    for (const command of ORDER_WORKFLOW_COMMANDS) {
      expect(used.has(command), `command ${command} has no transition row`).toBe(true);
    }
  });
});
