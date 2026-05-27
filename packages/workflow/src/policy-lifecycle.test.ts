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
  WORKFLOW_POLICY_NOT_ACTIVE,
  WORKFLOW_POLICY_NOT_FOUND_FOR_CREATE,
  WORKFLOW_POLICY_STATUS_VALUES,
  isWorkflowPolicyStatus,
  pickPolicyForCreate,
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
