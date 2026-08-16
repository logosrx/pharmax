// Tests for the pure lifecycle selector AND the structural
// invariants that the lifecycle migration ships.
//
// The selector tests pin the CREATE-side rule (see ADR-0017
// `docs/adr/0017-workflow-policy-migration.md`). The
// migration-text tests pin the DDL that enforces the
// activation invariant at the database layer — the partial
// unique index that Prisma's schema language can't express,
// and which a fake-Prisma unit test can't directly assert.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CREATE_READABLE_STATUSES,
  IN_FLIGHT_READABLE_STATUSES,
  OVERLAY_DEACTIVATION_BLOCKED,
  OVERLAY_NOT_ACTIVE,
  OVERLAY_NOT_DRAFT,
  OVERLAY_NOT_FOUND,
  POLICY_VERSION_BREAKING_NARROWING,
  POLICY_VERSION_DUPLICATE,
  POLICY_VERSION_NOT_DRAFT,
  POLICY_VERSION_NOT_INCREMENTAL,
  WORKFLOW_POLICY_NOT_ACTIVE,
  WORKFLOW_POLICY_NOT_FOUND_FOR_CREATE,
  WORKFLOW_POLICY_STATUS_VALUES,
  diffPolicyTransitions,
  isWorkflowPolicyStatus,
  pickPolicyForCreate,
  validateActivateOverlay,
  validateActivatePolicyVersion,
  validateDeactivateOverlay,
  validateRegisterPolicyVersion,
  type ExistingOverlayRow,
  type ExistingPolicyVersionRow,
  type WorkflowPolicyCandidate,
} from "./policy-lifecycle.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const LIFECYCLE_MIGRATION = resolve(
  ROOT,
  "prisma",
  "migrations",
  "20260608000000_workflow_policy_lifecycle",
  "migration.sql"
);

const POLICY_ID_V1 = "11111111-1111-1111-1111-111111111111";
const POLICY_ID_V2 = "22222222-2222-2222-2222-222222222222";

function candidate(over: Partial<WorkflowPolicyCandidate> = {}): WorkflowPolicyCandidate {
  return {
    id: POLICY_ID_V1,
    code: "order.standard",
    version: 1,
    status: "ACTIVE",
    ...over,
  };
}

describe("WorkflowPolicyStatus value registry", () => {
  it("declares the four lifecycle states from ADR-0017", () => {
    expect(WORKFLOW_POLICY_STATUS_VALUES).toEqual(["DRAFT", "ACTIVE", "SUPERSEDED", "ARCHIVED"]);
  });

  it("isWorkflowPolicyStatus accepts every registry value", () => {
    for (const v of WORKFLOW_POLICY_STATUS_VALUES) {
      expect(isWorkflowPolicyStatus(v)).toBe(true);
    }
  });

  it("isWorkflowPolicyStatus rejects unknown values (including the pre-rename RETIRED)", () => {
    expect(isWorkflowPolicyStatus("RETIRED")).toBe(false);
    expect(isWorkflowPolicyStatus("retired")).toBe(false);
    expect(isWorkflowPolicyStatus("")).toBe(false);
  });

  it("create-readable allowlist is exactly [ACTIVE]", () => {
    expect(CREATE_READABLE_STATUSES).toEqual(["ACTIVE"]);
  });

  it("in-flight-readable allowlist is exactly [ACTIVE, SUPERSEDED] (grandfather rule)", () => {
    expect(IN_FLIGHT_READABLE_STATUSES).toEqual(["ACTIVE", "SUPERSEDED"]);
  });
});

describe("pickPolicyForCreate — no requestedVersion (pick current ACTIVE)", () => {
  it("returns the single ACTIVE candidate when there is exactly one", () => {
    const v1 = candidate({ id: POLICY_ID_V1, version: 1, status: "ACTIVE" });
    const result = pickPolicyForCreate({ candidates: [v1], code: "order.standard" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.policy.id).toBe(POLICY_ID_V1);
  });

  it("picks the ACTIVE row when SUPERSEDED siblings exist (post-activation steady state)", () => {
    const v1 = candidate({ id: POLICY_ID_V1, version: 1, status: "SUPERSEDED" });
    const v2 = candidate({ id: POLICY_ID_V2, version: 2, status: "ACTIVE" });
    const result = pickPolicyForCreate({ candidates: [v1, v2], code: "order.standard" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.policy.id).toBe(POLICY_ID_V2);
      expect(result.policy.version).toBe(2);
    }
  });

  it("returns NOT_ACTIVE when only SUPERSEDED candidates match (no replacement activated)", () => {
    const v1 = candidate({ version: 1, status: "SUPERSEDED" });
    const result = pickPolicyForCreate({ candidates: [v1], code: "order.standard" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(WORKFLOW_POLICY_NOT_ACTIVE);
  });

  it("returns NOT_ACTIVE when only DRAFT candidates match (never activated)", () => {
    const v1 = candidate({ version: 1, status: "DRAFT" });
    const result = pickPolicyForCreate({ candidates: [v1], code: "order.standard" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(WORKFLOW_POLICY_NOT_ACTIVE);
  });

  it("returns NOT_ACTIVE when only ARCHIVED candidates match (fully decommissioned)", () => {
    const v1 = candidate({ version: 1, status: "ARCHIVED" });
    const result = pickPolicyForCreate({ candidates: [v1], code: "order.standard" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(WORKFLOW_POLICY_NOT_ACTIVE);
  });

  it("returns NOT_FOUND_FOR_CREATE when no candidate matches the code at all", () => {
    const other = candidate({ code: "order.compounded" });
    const result = pickPolicyForCreate({ candidates: [other], code: "order.standard" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(WORKFLOW_POLICY_NOT_FOUND_FOR_CREATE);
  });

  it("returns NOT_FOUND_FOR_CREATE when candidates list is empty", () => {
    const result = pickPolicyForCreate({ candidates: [], code: "order.standard" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(WORKFLOW_POLICY_NOT_FOUND_FOR_CREATE);
  });

  it("ignores candidates with a different code (tenant may have multiple policy families)", () => {
    const standardActive = candidate({
      id: POLICY_ID_V1,
      code: "order.standard",
      version: 1,
      status: "ACTIVE",
    });
    const compoundedActive = candidate({
      id: POLICY_ID_V2,
      code: "order.compounded",
      version: 1,
      status: "ACTIVE",
    });
    const result = pickPolicyForCreate({
      candidates: [compoundedActive, standardActive],
      code: "order.standard",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.policy.code).toBe("order.standard");
  });
});

describe("pickPolicyForCreate — with requestedVersion (pinned)", () => {
  it("returns the pinned candidate when it is ACTIVE", () => {
    const v1 = candidate({ version: 1, status: "ACTIVE" });
    const v2 = candidate({ id: POLICY_ID_V2, version: 2, status: "DRAFT" });
    const result = pickPolicyForCreate({
      candidates: [v1, v2],
      code: "order.standard",
      requestedVersion: 1,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.policy.version).toBe(1);
  });

  it("returns NOT_ACTIVE when the pinned candidate is SUPERSEDED (the load-bearing rule)", () => {
    const v1 = candidate({ version: 1, status: "SUPERSEDED" });
    const v2 = candidate({ id: POLICY_ID_V2, version: 2, status: "ACTIVE" });
    const result = pickPolicyForCreate({
      candidates: [v1, v2],
      code: "order.standard",
      requestedVersion: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(WORKFLOW_POLICY_NOT_ACTIVE);
  });

  it("returns NOT_ACTIVE when the pinned candidate is DRAFT", () => {
    const v2 = candidate({ id: POLICY_ID_V2, version: 2, status: "DRAFT" });
    const result = pickPolicyForCreate({
      candidates: [v2],
      code: "order.standard",
      requestedVersion: 2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(WORKFLOW_POLICY_NOT_ACTIVE);
  });

  it("returns NOT_ACTIVE when the pinned candidate is ARCHIVED", () => {
    const v1 = candidate({ version: 1, status: "ARCHIVED" });
    const result = pickPolicyForCreate({
      candidates: [v1],
      code: "order.standard",
      requestedVersion: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(WORKFLOW_POLICY_NOT_ACTIVE);
  });

  it("returns NOT_FOUND_FOR_CREATE when no row matches the pinned version", () => {
    const v1 = candidate({ version: 1, status: "ACTIVE" });
    const result = pickPolicyForCreate({
      candidates: [v1],
      code: "order.standard",
      requestedVersion: 99,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(WORKFLOW_POLICY_NOT_FOUND_FOR_CREATE);
  });

  it("respects the code filter when pinning version (different-code same-version is not a match)", () => {
    const otherCode = candidate({ code: "order.compounded", version: 1, status: "ACTIVE" });
    const result = pickPolicyForCreate({
      candidates: [otherCode],
      code: "order.standard",
      requestedVersion: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(WORKFLOW_POLICY_NOT_FOUND_FOR_CREATE);
  });
});

describe("pickPolicyForCreate — determinism", () => {
  it("returns the same result for the same inputs across calls (no mutation, no state)", () => {
    const candidates = [
      candidate({ id: POLICY_ID_V1, version: 1, status: "SUPERSEDED" }),
      candidate({ id: POLICY_ID_V2, version: 2, status: "ACTIVE" }),
    ];
    const a = pickPolicyForCreate({ candidates, code: "order.standard" });
    const b = pickPolicyForCreate({ candidates, code: "order.standard" });
    expect(a).toEqual(b);
    expect(a.ok).toBe(true);
  });

  it("does not mutate the candidates array", () => {
    const candidates = [
      candidate({ id: POLICY_ID_V2, version: 2, status: "ACTIVE" }),
      candidate({ id: POLICY_ID_V1, version: 1, status: "SUPERSEDED" }),
    ];
    const snapshot = [...candidates];
    pickPolicyForCreate({ candidates, code: "order.standard" });
    expect(candidates).toEqual(snapshot);
  });
});

// ===============================================================
// Lifecycle command validators (register / activate / overlay)
// ===============================================================

function versionRow(over: Partial<ExistingPolicyVersionRow> = {}): ExistingPolicyVersionRow {
  return {
    id: POLICY_ID_V1,
    code: "order.standard",
    version: 1,
    status: "ACTIVE",
    transitionIds: ["t.start-typing", "t.complete-typing"],
    ...over,
  };
}

describe("validateRegisterPolicyVersion", () => {
  it("accepts v1 as the first version of a new code", () => {
    const result = validateRegisterPolicyVersion(
      { code: "order.standard", version: 1, transitionIds: ["t.start-typing"] },
      []
    );
    expect(result).toEqual({ ok: true });
  });

  it("rejects a first version other than v1 (no starting at v2, v0, or negative)", () => {
    for (const version of [0, 2, 7, -1]) {
      const result = validateRegisterPolicyVersion(
        { code: "order.standard", version, transitionIds: [] },
        []
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe(POLICY_VERSION_NOT_INCREMENTAL);
    }
  });

  it("accepts exactly max(existing) + 1", () => {
    const existing = [versionRow({ version: 1, status: "SUPERSEDED" }), versionRow({ version: 2 })];
    const result = validateRegisterPolicyVersion(
      { code: "order.standard", version: 3, transitionIds: [] },
      existing
    );
    expect(result).toEqual({ ok: true });
  });

  it("rejects skipping a version number (audit story: 'what was v3?')", () => {
    const existing = [versionRow({ version: 1 }), versionRow({ version: 2 })];
    const result = validateRegisterPolicyVersion(
      { code: "order.standard", version: 4, transitionIds: [] },
      existing
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(POLICY_VERSION_NOT_INCREMENTAL);
      expect(result.reason).toContain("must be 3");
    }
  });

  it("rejects registering below the current max (no back-filling old versions)", () => {
    const existing = [versionRow({ version: 1 }), versionRow({ version: 3 })];
    const result = validateRegisterPolicyVersion(
      { code: "order.standard", version: 2, transitionIds: [] },
      existing
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(POLICY_VERSION_NOT_INCREMENTAL);
  });

  it("computes max(version) independently of candidate ordering", () => {
    // Rows arrive in whatever order the query returned them; the
    // successor rule must not depend on it.
    const existing = [versionRow({ version: 3 }), versionRow({ version: 1, status: "SUPERSEDED" })];
    const ok = validateRegisterPolicyVersion(
      { code: "order.standard", version: 4, transitionIds: [] },
      existing
    );
    expect(ok).toEqual({ ok: true });
    const stale = validateRegisterPolicyVersion(
      { code: "order.standard", version: 2, transitionIds: [] },
      existing
    );
    expect(stale.ok).toBe(false);
  });

  it("computes the successor from max(version), so a historical gap does not lower the bar", () => {
    // Rows v1 and v3 (v2 hard-deleted at some point): next must be 4.
    const existing = [versionRow({ version: 1 }), versionRow({ version: 3 })];
    const result = validateRegisterPolicyVersion(
      { code: "order.standard", version: 4, transitionIds: [] },
      existing
    );
    expect(result).toEqual({ ok: true });
  });

  it("rejects a duplicate version regardless of the existing row's status", () => {
    for (const status of WORKFLOW_POLICY_STATUS_VALUES) {
      const result = validateRegisterPolicyVersion(
        { code: "order.standard", version: 1, transitionIds: [] },
        [versionRow({ version: 1, status })]
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe(POLICY_VERSION_DUPLICATE);
    }
  });

  it("reports DUPLICATE (not NOT_INCREMENTAL) when the version collides below max", () => {
    const existing = [versionRow({ version: 1 }), versionRow({ version: 2 })];
    const result = validateRegisterPolicyVersion(
      { code: "order.standard", version: 1, transitionIds: [] },
      existing
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(POLICY_VERSION_DUPLICATE);
  });

  it("scopes both checks to the code — another family's versions are invisible", () => {
    const existing = [versionRow({ code: "order.compounded", version: 5 })];
    const result = validateRegisterPolicyVersion(
      { code: "order.standard", version: 1, transitionIds: [] },
      existing
    );
    expect(result).toEqual({ ok: true });
  });

  it("does not gate on transition narrowing at registration time (that is activation's job)", () => {
    const existing = [
      versionRow({ version: 1, status: "ACTIVE", transitionIds: ["t.a", "t.b", "t.c"] }),
    ];
    const result = validateRegisterPolicyVersion(
      { code: "order.standard", version: 2, transitionIds: ["t.a"] },
      existing
    );
    expect(result).toEqual({ ok: true });
  });
});

describe("diffPolicyTransitions", () => {
  it("returns empty when the next version keeps every prior transition", () => {
    expect(diffPolicyTransitions(["t.a", "t.b"], ["t.a", "t.b", "t.c"])).toEqual([]);
  });

  it("returns empty for identical sets", () => {
    expect(diffPolicyTransitions(["t.a"], ["t.a"])).toEqual([]);
  });

  it("lists removed transitions in prior-declaration order", () => {
    expect(diffPolicyTransitions(["t.a", "t.b", "t.c"], ["t.b"])).toEqual(["t.a", "t.c"]);
  });

  it("returns everything when the next version declares nothing", () => {
    expect(diffPolicyTransitions(["t.a", "t.b"], [])).toEqual(["t.a", "t.b"]);
  });

  it("returns empty when the prior version declared nothing", () => {
    expect(diffPolicyTransitions([], ["t.a"])).toEqual([]);
  });
});

describe("validateActivatePolicyVersion", () => {
  it("rejects when the target (code, version) row does not exist", () => {
    const result = validateActivatePolicyVersion(
      { code: "order.standard", version: 9 },
      [versionRow({ version: 1, status: "DRAFT" })],
      []
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(WORKFLOW_POLICY_NOT_FOUND_FOR_CREATE);
  });

  it("rejects activating a row that is not DRAFT (ACTIVE / SUPERSEDED / ARCHIVED)", () => {
    for (const status of ["ACTIVE", "SUPERSEDED", "ARCHIVED"] as const) {
      const result = validateActivatePolicyVersion(
        { code: "order.standard", version: 1 },
        [versionRow({ version: 1, status })],
        []
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(POLICY_VERSION_NOT_DRAFT);
        expect(result.reason).toContain(status);
      }
    }
  });

  it("accepts a DRAFT when no prior ACTIVE exists (first activation of the family)", () => {
    const result = validateActivatePolicyVersion(
      { code: "order.standard", version: 1 },
      [versionRow({ version: 1, status: "DRAFT" })],
      []
    );
    expect(result).toEqual({ ok: true });
  });

  it("accepts a DRAFT that is a strict superset of the prior ACTIVE", () => {
    const candidates = [
      versionRow({ version: 1, status: "ACTIVE", transitionIds: ["t.a", "t.b"] }),
      versionRow({
        id: POLICY_ID_V2,
        version: 2,
        status: "DRAFT",
        transitionIds: ["t.a", "t.b", "t.c"],
      }),
    ];
    const result = validateActivatePolicyVersion(
      { code: "order.standard", version: 2 },
      candidates,
      ["t.a", "t.b"]
    );
    expect(result).toEqual({ ok: true });
  });

  it("accepts a narrowing DRAFT when no in-flight order uses the removed transitions", () => {
    const candidates = [
      versionRow({ version: 1, status: "ACTIVE", transitionIds: ["t.a", "t.b"] }),
      versionRow({ id: POLICY_ID_V2, version: 2, status: "DRAFT", transitionIds: ["t.a"] }),
    ];
    const result = validateActivatePolicyVersion(
      { code: "order.standard", version: 2 },
      candidates,
      ["t.a"]
    );
    expect(result).toEqual({ ok: true });
  });

  it("rejects a narrowing DRAFT when in-flight orders still use a removed transition", () => {
    const candidates = [
      versionRow({ version: 1, status: "ACTIVE", transitionIds: ["t.a", "t.b", "t.c"] }),
      versionRow({ id: POLICY_ID_V2, version: 2, status: "DRAFT", transitionIds: ["t.a"] }),
    ];
    const result = validateActivatePolicyVersion(
      { code: "order.standard", version: 2 },
      candidates,
      ["t.b", "t.c"]
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(POLICY_VERSION_BREAKING_NARROWING);
      expect(result.reason).toContain("t.b");
      expect(result.reason).toContain("t.c");
    }
  });

  it("only blocks on the intersection — removed-but-unused transitions do not gate", () => {
    const candidates = [
      versionRow({ version: 1, status: "ACTIVE", transitionIds: ["t.a", "t.b", "t.c"] }),
      versionRow({ id: POLICY_ID_V2, version: 2, status: "DRAFT", transitionIds: ["t.a", "t.b"] }),
    ];
    // t.c is removed but nothing in flight ever used it; t.b is in
    // flight but survives.
    const result = validateActivatePolicyVersion(
      { code: "order.standard", version: 2 },
      candidates,
      ["t.b"]
    );
    expect(result).toEqual({ ok: true });
  });

  it("ignores an ACTIVE row of a different code when computing narrowing", () => {
    const candidates = [
      versionRow({
        code: "order.compounded",
        version: 1,
        status: "ACTIVE",
        transitionIds: ["t.x"],
      }),
      versionRow({ id: POLICY_ID_V2, version: 1, status: "DRAFT", transitionIds: ["t.a"] }),
    ];
    const result = validateActivatePolicyVersion(
      { code: "order.standard", version: 1 },
      candidates,
      ["t.x"]
    );
    expect(result).toEqual({ ok: true });
  });
});

const OVERLAY_ID = "33333333-3333-3333-3333-333333333333";
const BASE_POLICY_ID = POLICY_ID_V1;

function overlayRow(over: Partial<ExistingOverlayRow> = {}): ExistingOverlayRow {
  return {
    id: OVERLAY_ID,
    basePolicyId: BASE_POLICY_ID,
    version: 1,
    status: "DRAFT",
    affectedTransitionIds: ["t.final-verify"],
    ...over,
  };
}

describe("validateActivateOverlay", () => {
  it("rejects an unknown overlay id", () => {
    const result = validateActivateOverlay({ overlayId: OVERLAY_ID }, []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(OVERLAY_NOT_FOUND);
  });

  it("accepts a DRAFT overlay", () => {
    const result = validateActivateOverlay({ overlayId: OVERLAY_ID }, [
      overlayRow({ status: "DRAFT" }),
    ]);
    expect(result).toEqual({ ok: true });
  });

  it("rejects activating an overlay that is not DRAFT (incl. already-ACTIVE)", () => {
    for (const status of ["ACTIVE", "SUPERSEDED", "ARCHIVED"] as const) {
      const result = validateActivateOverlay({ overlayId: OVERLAY_ID }, [overlayRow({ status })]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(OVERLAY_NOT_DRAFT);
        expect(result.reason).toContain(status);
      }
    }
  });
});

describe("validateDeactivateOverlay", () => {
  it("rejects an unknown overlay id", () => {
    const result = validateDeactivateOverlay({ overlayId: OVERLAY_ID }, [], []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(OVERLAY_NOT_FOUND);
  });

  it("rejects deactivating an overlay that is not ACTIVE (DRAFT / SUPERSEDED / ARCHIVED)", () => {
    for (const status of ["DRAFT", "SUPERSEDED", "ARCHIVED"] as const) {
      const result = validateDeactivateOverlay(
        { overlayId: OVERLAY_ID },
        [overlayRow({ status })],
        []
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(OVERLAY_NOT_ACTIVE);
        expect(result.reason).toContain(status);
      }
    }
  });

  it("accepts deactivating the only ACTIVE overlay when nothing is in flight", () => {
    // Overlays are optional tightening — there is no "must keep one
    // active" rule, unlike base policies.
    const result = validateDeactivateOverlay(
      { overlayId: OVERLAY_ID },
      [overlayRow({ status: "ACTIVE" })],
      []
    );
    expect(result).toEqual({ ok: true });
  });

  it("blocks deactivation while in-flight orders hold attestations on affected transitions", () => {
    const result = validateDeactivateOverlay(
      { overlayId: OVERLAY_ID },
      [overlayRow({ status: "ACTIVE", affectedTransitionIds: ["t.final-verify", "t.ship"] })],
      ["t.ship"]
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(OVERLAY_DEACTIVATION_BLOCKED);
      expect(result.reason).toContain("t.ship");
    }
  });

  it("does not block on in-flight attestations for transitions the overlay never touched", () => {
    const result = validateDeactivateOverlay(
      { overlayId: OVERLAY_ID },
      [overlayRow({ status: "ACTIVE", affectedTransitionIds: ["t.final-verify"] })],
      ["t.some-other-overlays-transition"]
    );
    expect(result).toEqual({ ok: true });
  });

  it("resolves the target by id among multiple overlays", () => {
    const other = overlayRow({ id: "44444444-4444-4444-4444-444444444444", status: "DRAFT" });
    const target = overlayRow({ status: "ACTIVE" });
    const result = validateDeactivateOverlay({ overlayId: OVERLAY_ID }, [other, target], []);
    expect(result).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------
// Activation invariant — DB-layer DDL is the source of truth.
//
// The partial unique index `workflow_policy_active_unique` is the
// only thing that makes the "at most one ACTIVE per (org, code)"
// promise true under concurrent writers. A fake-Prisma unit test
// can't enforce it; an integration test (separate harness, real
// Postgres) would catch a missing index by attempting a duplicate
// insert and asserting 23505. Inside `pnpm verify` (which does
// NOT run the integration suite by default), the next-best signal
// is to assert that the migration SQL contains the DDL — proving
// the schema delta ships with the constraint.
// ---------------------------------------------------------------
describe("activation invariant — migration DDL", () => {
  const sql = readFileSync(LIFECYCLE_MIGRATION, "utf8");

  it("declares the partial unique index on (organizationId, code) WHERE status = 'ACTIVE'", () => {
    // The full DDL with comments / whitespace is brittle; grep the
    // load-bearing pieces. If a refactor renames the index or
    // changes the predicate, this test surfaces the regression
    // with a clear failure rather than letting two ACTIVE rows
    // sneak into production.
    expect(sql).toMatch(/CREATE\s+UNIQUE\s+INDEX\s+"workflow_policy_active_unique"/i);
    expect(sql).toMatch(/ON\s+"workflow_policy"\s*\(\s*"organizationId"\s*,\s*"code"\s*\)/i);
    expect(sql).toMatch(/WHERE\s+"status"\s*=\s*'ACTIVE'/i);
  });

  it("renames RETIRED to SUPERSEDED (in-place lifecycle reconciliation)", () => {
    expect(sql).toMatch(
      /ALTER\s+TYPE\s+"WorkflowPolicyStatus"\s+RENAME\s+VALUE\s+'RETIRED'\s+TO\s+'SUPERSEDED'/i
    );
  });

  it("adds the ARCHIVED value", () => {
    expect(sql).toMatch(/ALTER\s+TYPE\s+"WorkflowPolicyStatus"\s+ADD\s+VALUE\s+'ARCHIVED'/i);
  });

  it("pins the `retiredAt` column semantics with a COMMENT", () => {
    expect(sql).toMatch(/COMMENT\s+ON\s+COLUMN\s+"workflow_policy"\."retiredAt"/i);
  });
});
