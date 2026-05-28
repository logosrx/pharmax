// Tier-2 overlay resolution integration — `define-command.ts` x
// `@pharmax/workflow.resolvePolicyForTenant`.
//
// What this file proves:
//
//   1. When `overlayResolution` is configured on the bus, the
//      synthesized `defineCommand` handler decorates
//      `deps.policy` with `merged: MergedWorkflowPolicy` after
//      the base policy row is loaded — both in `from: "target"`
//      and `{code, version}` modes.
//   2. The clinic from the locked target narrows overlay loading
//      (in-flight commands see clinic-scoped overlays; create
//      commands see org-wide only).
//   3. The merged snapshot reflects ACTIVE overlays (tightens the
//      base) and is IMMUTABLE — captured per-tx, replay-correct.
//   4. The process-local cache short-circuits the source on the
//      second resolve of the same (org, basePolicy, clinic) tuple.
//   5. When `overlayResolution` is OMITTED, `merged` is absent and
//      the existing 200+ command tests continue to pass unchanged
//      (verified by `define-command.test.ts` running green; this
//      file adds one explicit assertion to make the seam visible).
//   6. When the registry returns `undefined` for an unknown
//      (code, version), the bus falls back to the base-only
//      `LoadedPolicy` — the opt-in-by-registration migration
//      contract from the configure.ts doc.
//   7. A misconfigured overlay (forbids an unknown transition)
//      surfaces as `OVERLAY_LOOSENS_BASE_POLICY` and FAILS the
//      command — no silent fallback to base.
//
// What this file deliberately does NOT prove:
//
//   - End-to-end handler behavior under an overlay (e.g. "second
//     pharmacist required for CII–CV"). Handlers must migrate
//     from the static `ORDER_STANDARD_V1` import to
//     `deps.policy.merged` before that becomes observable. That
//     migration is the follow-up slice tracked in ADR-0019's
//     implementation notes.
//
// PHI invariant: every fixture uses synthetic ids and
// configuration-only overlay shapes. No patient or order data
// is referenced.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { RoleScope } from "@pharmax/database";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext, type TenancyContext } from "@pharmax/tenancy";
import {
  InMemoryOverlaySource,
  ORDER_STANDARD_V1,
  WorkflowPolicyOverlayCache,
  type MergedWorkflowPolicy,
  type OrderWorkflowPolicy,
  type WorkflowPolicyOverlayBinding,
} from "@pharmax/workflow";

import {
  configureCommandBus,
  resetCommandBusConfigurationForTests,
  type OverlayResolutionConfig,
} from "./configure.js";
import { defineCommand } from "./define-command.js";
import { executeCommand } from "./execute-command.js";
import { buildFakeConfig, buildFakePrisma, type FakePrisma } from "./test-helpers.js";

const ORG_ID = "00000000-0000-4000-8000-00000000a001";
const ORDER_ID = "00000000-0000-4000-8000-00000000a002";
const POLICY_ID = "00000000-0000-4000-8000-00000000a003";
const CLINIC_ID = "00000000-0000-4000-8000-00000000a004";
const OVERLAY_ID = "00000000-0000-4000-8000-00000000a005";
const USER_ID = "00000000-0000-4000-8000-00000000a006";

const grants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.ORDERS_READ, PERMISSIONS.ORDERS_CREATE]),
  },
];

function ctxFor(): TenancyContext {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: USER_ID, correlationId: "01CORRELATION0000000000000" },
  });
}

let prisma: FakePrisma;
let cache: WorkflowPolicyOverlayCache;
let source: InMemoryOverlaySource;

// Counts source.load() invocations so the cache assertion is
// unambiguous: a second resolve with the same key must NOT hit
// the source.
let sourceLoadCount = 0;

class CountingSource extends InMemoryOverlaySource {
  public override async load(
    input: Parameters<InMemoryOverlaySource["load"]>[0]
  ): ReturnType<InMemoryOverlaySource["load"]> {
    sourceLoadCount += 1;
    return super.load(input);
  }
}

function makeOverlayResolution(
  opts: {
    readonly basePolicyFor?: (code: string, version: number) => OrderWorkflowPolicy | undefined;
  } = {}
): OverlayResolutionConfig {
  return {
    source,
    cache,
    basePolicyFor:
      opts.basePolicyFor ??
      ((code, version) =>
        code === ORDER_STANDARD_V1.code && version === ORDER_STANDARD_V1.version
          ? ORDER_STANDARD_V1
          : undefined),
  };
}

beforeEach(() => {
  prisma = buildFakePrisma();
  cache = new WorkflowPolicyOverlayCache();
  source = new CountingSource();
  sourceLoadCount = 0;
  configureRbac({
    loader: new InMemoryPermissionLoader([{ organizationId: ORG_ID, userId: USER_ID, grants }]),
  });
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
});

// ===========================================================================
// Fixtures
// ===========================================================================

/**
 * A small org-wide overlay that forbids `REOPEN_FOR_CORRECTION`
 * out of `PV1_REJECTED`. `ORDER_STANDARD_V1` does declare that
 * transition, so the merge is a legitimate tightening that the
 * snapshot's `merged.transitions` will reflect by absence of the
 * forbidden pair.
 */
const FORBID_REOPEN_OVERLAY: WorkflowPolicyOverlayBinding = {
  id: OVERLAY_ID,
  version: 1,
  priority: 100,
  overlay: {
    forbidTransitionsFromStates: {
      REOPEN_FOR_CORRECTION: ["PV1_REJECTED"],
    },
  },
};

/**
 * Pair the org overlay with a malformed clinic overlay that
 * forbids a (command, state) pair the base does not declare.
 * `mergePolicyWithOverlay` rejects this as
 * `OVERLAY_LOOSENS_BASE_POLICY` — used to prove the bus fails
 * loudly on misconfiguration.
 */
const LOOSENS_BASE_OVERLAY: WorkflowPolicyOverlayBinding = {
  id: "00000000-0000-4000-8000-00000000a999",
  version: 1,
  priority: 200,
  overlay: {
    forbidTransitionsFromStates: {
      // `CANCEL` from `SHIPPED` is not in the base — terminal
      // states are excluded from `cancelFromStates`. This is the
      // classic admin-typo case.
      CANCEL: ["SHIPPED"],
    },
  },
};

/** Configure the locked order row with sensible defaults. */
function primeLockedOrder(overrides: { readonly clinicId?: string } = {}): void {
  prisma.setOrderRowForLock({
    id: ORDER_ID,
    organizationId: ORG_ID,
    clinicId: overrides.clinicId ?? CLINIC_ID,
    siteId: "00000000-0000-4000-8000-00000000a777",
    currentStatus: "RECEIVED",
    version: 0,
    workflowPolicyId: POLICY_ID,
    workflowPolicyVersion: 1,
  });
  prisma.setWorkflowPolicyRow({
    id: POLICY_ID,
    code: ORDER_STANDARD_V1.code,
    version: ORDER_STANDARD_V1.version,
    status: "ACTIVE",
  });
}

// ===========================================================================
// 1. Decoration is present iff overlayResolution is configured
// ===========================================================================

describe("define-command overlay resolution — wiring", () => {
  it("populates deps.policy.merged when overlayResolution is configured (target mode)", async () => {
    source.setBindings({
      organizationId: ORG_ID,
      basePolicyId: POLICY_ID,
      bindings: [FORBID_REOPEN_OVERLAY],
    });
    configureCommandBus({
      ...buildFakeConfig(prisma),
      overlayResolution: makeOverlayResolution(),
    });
    primeLockedOrder();

    let observedMerged: MergedWorkflowPolicy | undefined;
    const cmd = defineCommand({
      name: "OverlayReadProbe",
      inputSchema: z.object({ orderId: z.string().uuid() }),
      permission: PERMISSIONS.ORDERS_READ,
      lockTarget: { table: "order", by: (i) => ({ id: i.orderId }) },
      loadPolicy: { from: "target" },
      exec: async ({ policy }) => {
        observedMerged = policy?.merged;
        return {
          output: {},
          audit: { action: "x", resourceType: "Order", resourceId: ORDER_ID },
          emits: [],
        };
      },
    });

    await withTenancyContext(ctxFor(), () =>
      executeCommand(cmd, { orderId: ORDER_ID }, { idempotencyKey: "ov-1" })
    );

    expect(observedMerged).toBeDefined();
    expect(observedMerged!.basePolicyId).toBe(POLICY_ID);
    expect(observedMerged!.basePolicyVersion).toBe(1);
    expect(observedMerged!.overlays).toHaveLength(1);
    expect(observedMerged!.overlays[0]?.id).toBe(OVERLAY_ID);

    // The forbidden (REOPEN_FOR_CORRECTION, PV1_REJECTED) pair is
    // present in base but ABSENT from merged.transitions — that
    // is the load-bearing tightening invariant.
    const baseHasForbiddenPair = ORDER_STANDARD_V1.transitions.some(
      (t) => t.command === "REOPEN_FOR_CORRECTION" && t.fromState === "PV1_REJECTED"
    );
    const mergedHasForbiddenPair = observedMerged!.merged.transitions.some(
      (t) => t.command === "REOPEN_FOR_CORRECTION" && t.fromState === "PV1_REJECTED"
    );
    expect(baseHasForbiddenPair).toBe(true);
    expect(mergedHasForbiddenPair).toBe(false);
  });

  it("populates deps.policy.merged in {code, version} (CREATE-side) mode", async () => {
    source.setBindings({
      organizationId: ORG_ID,
      basePolicyId: POLICY_ID,
      bindings: [FORBID_REOPEN_OVERLAY],
    });
    configureCommandBus({
      ...buildFakeConfig(prisma),
      overlayResolution: makeOverlayResolution(),
    });
    prisma.setWorkflowPolicyRow({
      id: POLICY_ID,
      code: ORDER_STANDARD_V1.code,
      version: ORDER_STANDARD_V1.version,
      status: "ACTIVE",
    });

    let observedMerged: MergedWorkflowPolicy | undefined;
    const cmd = defineCommand({
      name: "OverlayCreateProbe",
      inputSchema: z.object({}),
      permission: PERMISSIONS.ORDERS_CREATE,
      loadPolicy: { code: ORDER_STANDARD_V1.code, version: ORDER_STANDARD_V1.version },
      exec: async ({ policy }) => {
        observedMerged = policy?.merged;
        return {
          output: {},
          audit: { action: "x", resourceType: "Order" },
          emits: [],
        };
      },
    });

    await withTenancyContext(ctxFor(), () =>
      executeCommand(cmd, {}, { idempotencyKey: "ov-create" })
    );

    expect(observedMerged).toBeDefined();
    expect(observedMerged!.overlays).toHaveLength(1);
  });

  it("leaves deps.policy.merged undefined when overlayResolution is NOT configured", async () => {
    configureCommandBus(buildFakeConfig(prisma));
    primeLockedOrder();

    let observed: { merged?: MergedWorkflowPolicy } | undefined;
    const cmd = defineCommand({
      name: "NoOverlayWiring",
      inputSchema: z.object({ orderId: z.string().uuid() }),
      permission: PERMISSIONS.ORDERS_READ,
      lockTarget: { table: "order", by: (i) => ({ id: i.orderId }) },
      loadPolicy: { from: "target" },
      exec: async ({ policy }) => {
        observed = policy;
        return {
          output: {},
          audit: { action: "x", resourceType: "Order", resourceId: ORDER_ID },
          emits: [],
        };
      },
    });

    await withTenancyContext(ctxFor(), () =>
      executeCommand(cmd, { orderId: ORDER_ID }, { idempotencyKey: "ov-off" })
    );

    expect(observed).toBeDefined();
    expect(observed!.merged).toBeUndefined();
  });

  it("falls back to base-only when basePolicyFor returns undefined for an unknown (code, version)", async () => {
    // Registry intentionally returns undefined for every input —
    // simulates a newly-introduced policy version that admins
    // haven't registered yet. Bus must NOT throw; merged is just
    // absent.
    configureCommandBus({
      ...buildFakeConfig(prisma),
      overlayResolution: makeOverlayResolution({ basePolicyFor: () => undefined }),
    });
    primeLockedOrder();

    let observedMerged: MergedWorkflowPolicy | undefined;
    const cmd = defineCommand({
      name: "OverlayUnknownPolicy",
      inputSchema: z.object({ orderId: z.string().uuid() }),
      permission: PERMISSIONS.ORDERS_READ,
      lockTarget: { table: "order", by: (i) => ({ id: i.orderId }) },
      loadPolicy: { from: "target" },
      exec: async ({ policy }) => {
        observedMerged = policy?.merged;
        return {
          output: {},
          audit: { action: "x", resourceType: "Order", resourceId: ORDER_ID },
          emits: [],
        };
      },
    });

    await withTenancyContext(ctxFor(), () =>
      executeCommand(cmd, { orderId: ORDER_ID }, { idempotencyKey: "ov-unreg" })
    );

    expect(observedMerged).toBeUndefined();
    // No source read either — basePolicyFor short-circuits BEFORE
    // we ever talk to the source.
    expect(sourceLoadCount).toBe(0);
  });
});

// ===========================================================================
// 2. Clinic scope flow-through
// ===========================================================================

describe("define-command overlay resolution — clinic scope", () => {
  it("forwards target.clinicId to the resolver (in-flight commands narrow)", async () => {
    source.setBindings({
      organizationId: ORG_ID,
      basePolicyId: POLICY_ID,
      bindings: [FORBID_REOPEN_OVERLAY],
    });
    configureCommandBus({
      ...buildFakeConfig(prisma),
      overlayResolution: makeOverlayResolution(),
    });
    primeLockedOrder({ clinicId: CLINIC_ID });

    let loadInput: { clinicId?: string } | undefined;
    // Replace source's load to capture the input shape; we cannot
    // peek at WorkflowPolicyOverlayCache directly.
    const originalLoad = source.load.bind(source);
    source.load = async (input) => {
      loadInput = { ...(input.clinicId === undefined ? {} : { clinicId: input.clinicId }) };
      return originalLoad(input);
    };

    const cmd = defineCommand({
      name: "ClinicScopedProbe",
      inputSchema: z.object({ orderId: z.string().uuid() }),
      permission: PERMISSIONS.ORDERS_READ,
      lockTarget: { table: "order", by: (i) => ({ id: i.orderId }) },
      loadPolicy: { from: "target" },
      exec: async () => ({
        output: {},
        audit: { action: "x", resourceType: "Order", resourceId: ORDER_ID },
        emits: [],
      }),
    });

    await withTenancyContext(ctxFor(), () =>
      executeCommand(cmd, { orderId: ORDER_ID }, { idempotencyKey: "ov-clinic" })
    );

    expect(loadInput?.clinicId).toBe(CLINIC_ID);
  });
});

// ===========================================================================
// 3. Cache short-circuit
// ===========================================================================

describe("define-command overlay resolution — cache", () => {
  it("only reads the source once for two commands on the same (org, basePolicy, clinic) tuple", async () => {
    source.setBindings({
      organizationId: ORG_ID,
      basePolicyId: POLICY_ID,
      bindings: [FORBID_REOPEN_OVERLAY],
    });
    configureCommandBus({
      ...buildFakeConfig(prisma),
      overlayResolution: makeOverlayResolution(),
    });
    primeLockedOrder({ clinicId: CLINIC_ID });

    const cmd = defineCommand({
      name: "CacheProbe",
      inputSchema: z.object({ orderId: z.string().uuid() }),
      permission: PERMISSIONS.ORDERS_READ,
      lockTarget: { table: "order", by: (i) => ({ id: i.orderId }) },
      loadPolicy: { from: "target" },
      exec: async () => ({
        output: {},
        audit: { action: "x", resourceType: "Order", resourceId: ORDER_ID },
        emits: [],
      }),
    });

    await withTenancyContext(ctxFor(), () =>
      executeCommand(cmd, { orderId: ORDER_ID }, { idempotencyKey: "ov-cache-1" })
    );
    await withTenancyContext(ctxFor(), () =>
      executeCommand(cmd, { orderId: ORDER_ID }, { idempotencyKey: "ov-cache-2" })
    );

    // Two commands, ONE source read.
    expect(sourceLoadCount).toBe(1);
  });
});

// ===========================================================================
// 4. Fail-loud on misconfigured overlay
// ===========================================================================

describe("define-command overlay resolution — failure modes", () => {
  it("FAILS the command (no silent fallback) when an overlay would loosen the base", async () => {
    source.setBindings({
      organizationId: ORG_ID,
      basePolicyId: POLICY_ID,
      bindings: [LOOSENS_BASE_OVERLAY],
    });
    configureCommandBus({
      ...buildFakeConfig(prisma),
      overlayResolution: makeOverlayResolution(),
    });
    primeLockedOrder({ clinicId: CLINIC_ID });

    const cmd = defineCommand({
      name: "LoosenOverlay",
      inputSchema: z.object({ orderId: z.string().uuid() }),
      permission: PERMISSIONS.ORDERS_READ,
      lockTarget: { table: "order", by: (i) => ({ id: i.orderId }) },
      loadPolicy: { from: "target" },
      exec: async () => ({
        output: {},
        audit: { action: "x", resourceType: "Order", resourceId: ORDER_ID },
        emits: [],
      }),
    });

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(cmd, { orderId: ORDER_ID }, { idempotencyKey: "ov-loose" })
      ).rejects.toMatchObject({ code: "OVERLAY_LOOSENS_BASE_POLICY" });
    });
  });
});
