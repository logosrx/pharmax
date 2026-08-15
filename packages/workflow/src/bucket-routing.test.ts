// Stage → bucket routing contract tests.
//
// The three properties in `bucket-routing.ts`'s header are the whole
// point of this file, and each one is a way a prescription gets lost if
// it breaks:
//
//   1. FALL BACK, NEVER FAIL CLOSED — no input makes a routable state
//      resolve to "nowhere". Tested exhaustively, not by example: the
//      loop over `ROUTABLE_ORDER_STATES` × a junk-value table is the
//      assertion that matters, because the junk arrives from a `Json`
//      column and cannot be constrained by types.
//   2. NARROW, NEVER WIDEN — a state with no canonical bucket cannot
//      acquire one from an overlay.
//   3. Composition is last-wins per state, so a clinic route beats an
//      org-wide one deterministically.

import { describe, expect, it } from "vitest";

import {
  ROUTABLE_ORDER_STATES,
  canonicalBucketCodeForState,
  composeStageBucketRouteTables,
  isRoutableOrderState,
  resolveStageBucketRoute,
  routeTargetCodes,
  statesRoutedTo,
  type StageBucketRouteTable,
} from "./bucket-routing.js";
import { BUCKET_CODE_FOR_EXCEPTION_STATE, BUCKET_CODE_FOR_STATUS } from "./status-bucket-map.js";
import { ALL_ORDER_STATES } from "./states.js";

/**
 * Values a `Json` column can hand back that are not usable bucket
 * codes. Every one must degrade to the canonical route rather than
 * throw or resolve to nothing.
 */
const JUNK_OVERRIDES: ReadonlyArray<unknown> = [
  undefined,
  null,
  "",
  "   ",
  "\t\n",
  42,
  true,
  {},
  [],
];

describe("ROUTABLE_ORDER_STATES", () => {
  it("is exactly the set of states that have a canonical bucket", () => {
    const expected = ALL_ORDER_STATES.filter(
      (state) => canonicalBucketCodeForState(state) !== null
    );
    expect([...ROUTABLE_ORDER_STATES]).toEqual([...expected]);
  });

  it("excludes states the canonical map deliberately leaves unrouted", () => {
    // CANCELLED is terminal and leaves every queue; ON_HOLD has no
    // bucket until PlaceHold pins one. Letting either be routed would
    // be the overlay WIDENING base, which the whole surface forbids.
    expect(ROUTABLE_ORDER_STATES).not.toContain("CANCELLED");
    expect(ROUTABLE_ORDER_STATES).not.toContain("ON_HOLD");
  });

  it("covers every primary state, since each one has a canonical bucket", () => {
    for (const state of Object.keys(BUCKET_CODE_FOR_STATUS)) {
      expect(ROUTABLE_ORDER_STATES).toContain(state);
    }
  });

  it("covers every mapped exception state", () => {
    for (const [state, code] of Object.entries(BUCKET_CODE_FOR_EXCEPTION_STATE)) {
      if (code === undefined) continue;
      expect(ROUTABLE_ORDER_STATES).toContain(state);
    }
  });

  it("is ordered by lifecycle, not hash order", () => {
    const lifecycleIndex = (state: string): number =>
      (ALL_ORDER_STATES as ReadonlyArray<string>).indexOf(state);
    const indices = ROUTABLE_ORDER_STATES.map(lifecycleIndex);
    expect([...indices]).toEqual([...indices].sort((a, b) => a - b));
  });
});

describe("isRoutableOrderState", () => {
  it("accepts a state with a canonical bucket", () => {
    expect(isRoutableOrderState("PV1_REJECTED")).toBe(true);
  });

  it("rejects a real state with no canonical bucket", () => {
    expect(isRoutableOrderState("CANCELLED")).toBe(false);
    expect(isRoutableOrderState("ON_HOLD")).toBe(false);
  });

  it("rejects a string that is not a state at all", () => {
    expect(isRoutableOrderState("NOT_A_STATE")).toBe(false);
    expect(isRoutableOrderState("")).toBe(false);
  });
});

describe("canonicalBucketCodeForState", () => {
  it("reads through to the primary map", () => {
    expect(canonicalBucketCodeForState("RECEIVED")).toBe("INBOX");
    expect(canonicalBucketCodeForState("TYPED_READY_FOR_PV1")).toBe("PV1");
  });

  it("reads through to the exception map", () => {
    expect(canonicalBucketCodeForState("PV1_REJECTED")).toBe("TYPING");
    expect(canonicalBucketCodeForState("FINAL_VERIFICATION_REJECTED")).toBe("FILL");
  });

  it("returns null for a state with no canonical bucket", () => {
    expect(canonicalBucketCodeForState("CANCELLED")).toBeNull();
    expect(canonicalBucketCodeForState("ON_HOLD")).toBeNull();
  });
});

describe("resolveStageBucketRoute — property 1: falls back, never fails closed", () => {
  it("returns the canonical code for every routable state when there is no override at all", () => {
    for (const state of ROUTABLE_ORDER_STATES) {
      const resolved = resolveStageBucketRoute(state, undefined);
      expect(resolved).not.toBeNull();
      expect(resolved?.code).toBe(canonicalBucketCodeForState(state));
      expect(resolved?.overridden).toBe(false);
    }
  });

  it("returns the canonical code for every routable state under an empty table", () => {
    for (const state of ROUTABLE_ORDER_STATES) {
      const resolved = resolveStageBucketRoute(state, {});
      expect(resolved?.code).toBe(canonicalBucketCodeForState(state));
      expect(resolved?.overridden).toBe(false);
    }
  });

  // The load-bearing one. Routes are rehydrated from a `Json` column,
  // so no type keeps junk out of this function at runtime.
  it("degrades every junk override to the canonical code, for every routable state", () => {
    for (const state of ROUTABLE_ORDER_STATES) {
      const canonical = canonicalBucketCodeForState(state);
      for (const junk of JUNK_OVERRIDES) {
        const routes = { [state]: junk } as unknown as StageBucketRouteTable;
        const resolved = resolveStageBucketRoute(state, routes);
        expect(resolved, `${state} with junk ${JSON.stringify(junk)}`).not.toBeNull();
        expect(resolved?.code).toBe(canonical);
        expect(resolved?.overridden).toBe(false);
      }
    }
  });

  it("never throws, whatever the table holds", () => {
    for (const junk of JUNK_OVERRIDES) {
      expect(() =>
        resolveStageBucketRoute("PV1_REJECTED", junk as unknown as StageBucketRouteTable)
      ).not.toThrow();
    }
  });

  it("treats an override equal to the canonical code as no override", () => {
    const resolved = resolveStageBucketRoute("PV1_REJECTED", { PV1_REJECTED: "TYPING" });
    expect(resolved?.code).toBe("TYPING");
    expect(resolved?.overridden).toBe(false);
  });

  it("trims surrounding whitespace off a usable override", () => {
    const resolved = resolveStageBucketRoute("PV1_REJECTED", {
      PV1_REJECTED: "  TYPING_REWORK  ",
    });
    expect(resolved?.code).toBe("TYPING_REWORK");
    expect(resolved?.overridden).toBe(true);
  });
});

describe("resolveStageBucketRoute — property 2: narrows, never widens", () => {
  it("returns null for an unroutable state even when the table names one", () => {
    // A state with no canonical bucket must not acquire one. Returning
    // null preserves today's meaning: leave the order where it is.
    expect(
      resolveStageBucketRoute("CANCELLED", {
        CANCELLED: "ARCHIVE",
      } as unknown as StageBucketRouteTable)
    ).toBeNull();
    expect(
      resolveStageBucketRoute("ON_HOLD", {
        ON_HOLD: "HOLD_QUEUE",
      } as unknown as StageBucketRouteTable)
    ).toBeNull();
  });

  it("returns null for a string that is not a state", () => {
    expect(resolveStageBucketRoute("NOT_A_STATE", { PV1_REJECTED: "X" })).toBeNull();
  });
});

describe("resolveStageBucketRoute — applying an override", () => {
  it("redirects a stage to a custom bucket and reports it as overridden", () => {
    const resolved = resolveStageBucketRoute("PV1_REJECTED", {
      PV1_REJECTED: "TYPING_REWORK",
    });
    expect(resolved).toEqual({
      code: "TYPING_REWORK",
      canonicalCode: "TYPING",
      overridden: true,
    });
  });

  it("leaves untouched states on their canonical code", () => {
    const routes: StageBucketRouteTable = { PV1_REJECTED: "TYPING_REWORK" };
    const other = resolveStageBucketRoute("RECEIVED", routes);
    expect(other?.code).toBe("INBOX");
    expect(other?.overridden).toBe(false);
  });

  it("always reports the canonical code alongside the override, so callers can fall back", () => {
    const resolved = resolveStageBucketRoute("FILL_IN_PROGRESS", {
      FILL_IN_PROGRESS: "COMPOUNDING",
    });
    expect(resolved?.canonicalCode).toBe("FILL");
  });
});

describe("composeStageBucketRouteTables — property 3: last wins per state", () => {
  it("returns an empty table for no inputs", () => {
    expect(composeStageBucketRouteTables()).toEqual({});
  });

  it("ignores undefined tables", () => {
    expect(composeStageBucketRouteTables(undefined, undefined)).toEqual({});
  });

  it("merges disjoint tables", () => {
    const composed = composeStageBucketRouteTables(
      { PV1_REJECTED: "TYPING_REWORK" },
      { FILL_IN_PROGRESS: "COMPOUNDING" }
    );
    expect(composed).toEqual({
      PV1_REJECTED: "TYPING_REWORK",
      FILL_IN_PROGRESS: "COMPOUNDING",
    });
  });

  it("lets the later table win a contested state", () => {
    // Priority order is org-wide (100) then clinic (200), so the
    // clinic's route is the later argument and must win.
    const composed = composeStageBucketRouteTables(
      { PV1_REJECTED: "ORG_REWORK" },
      { PV1_REJECTED: "CLINIC_REWORK" }
    );
    expect(composed["PV1_REJECTED"]).toBe("CLINIC_REWORK");
  });

  it("does not let a junk value in a later table erase a good value in an earlier one", () => {
    const composed = composeStageBucketRouteTables({ PV1_REJECTED: "ORG_REWORK" }, {
      PV1_REJECTED: "",
    } as unknown as StageBucketRouteTable);
    expect(composed["PV1_REJECTED"]).toBe("ORG_REWORK");
  });

  it("drops entries for unroutable states", () => {
    const composed = composeStageBucketRouteTables({
      CANCELLED: "ARCHIVE",
      PV1_REJECTED: "TYPING_REWORK",
    } as unknown as StageBucketRouteTable);
    expect(composed).toEqual({ PV1_REJECTED: "TYPING_REWORK" });
  });

  it("is associative, so binding order is the only thing that matters", () => {
    const a: StageBucketRouteTable = { PV1_REJECTED: "A", RECEIVED: "A_INBOX" };
    const b: StageBucketRouteTable = { PV1_REJECTED: "B" };
    const c: StageBucketRouteTable = { FILL_IN_PROGRESS: "C" };
    const left = composeStageBucketRouteTables(composeStageBucketRouteTables(a, b), c);
    const right = composeStageBucketRouteTables(a, composeStageBucketRouteTables(b, c));
    expect(left).toEqual(right);
  });

  it("returns a frozen table", () => {
    expect(Object.isFrozen(composeStageBucketRouteTables({ PV1_REJECTED: "X" }))).toBe(true);
  });
});

describe("routeTargetCodes", () => {
  it("is empty for no table", () => {
    expect(routeTargetCodes(undefined)).toEqual([]);
  });

  it("deduplicates and sorts", () => {
    expect(
      routeTargetCodes({
        PV1_REJECTED: "REWORK",
        FINAL_VERIFICATION_REJECTED: "REWORK",
        RECEIVED: "ALPHA",
      })
    ).toEqual(["ALPHA", "REWORK"]);
  });

  it("skips junk and unroutable keys", () => {
    expect(
      routeTargetCodes({
        PV1_REJECTED: "REWORK",
        CANCELLED: "ARCHIVE",
        RECEIVED: "   ",
        FILL_IN_PROGRESS: 7,
      } as unknown as StageBucketRouteTable)
    ).toEqual(["REWORK"]);
  });
});

describe("statesRoutedTo", () => {
  it("is empty for no table", () => {
    expect(statesRoutedTo(undefined, "REWORK")).toEqual([]);
  });

  it("names every state pointed at the code, in lifecycle order", () => {
    expect(
      statesRoutedTo(
        { FINAL_VERIFICATION_REJECTED: "REWORK", PV1_REJECTED: "REWORK", RECEIVED: "INBOX" },
        "REWORK"
      )
    ).toEqual(["PV1_REJECTED", "FINAL_VERIFICATION_REJECTED"]);
  });

  it("matches on the trimmed code", () => {
    expect(statesRoutedTo({ PV1_REJECTED: "  REWORK " }, "REWORK")).toEqual(["PV1_REJECTED"]);
  });

  it("does not match a different code", () => {
    expect(statesRoutedTo({ PV1_REJECTED: "REWORK" }, "OTHER")).toEqual([]);
  });
});
