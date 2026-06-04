// SLA breach evaluator tick tests.
//
// Approach: mock the cross-tenant claim + per-org actor lookup, and
// patch the bus's executeCommand. We assert the dispatcher enters
// the right tenancy/actor, keys idempotency on (order, deadline),
// and maps command outcomes to tick counters.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as CommandBus from "@pharmax/command-bus";

interface EscalateResult {
  orderId: string;
  bucketId: string;
  alreadyEscalated: boolean;
  previousBucketId: string | null;
  version: number;
}

const executeCommandMock = vi.hoisted(() =>
  vi.fn(
    async (_cmd: unknown, _input: unknown, _options?: unknown): Promise<EscalateResult> => ({
      orderId: "ord-1",
      bucketId: "emergency-bucket",
      alreadyEscalated: false,
      previousBucketId: "fill-bucket",
      version: 4,
    })
  )
);

// Partial mock: keep the real `defineCommand` (needed when
// `@pharmax/orders` loads EscalateOrderForSlaBreach at import time)
// and only swap `executeCommand` for our spy.
vi.mock("@pharmax/command-bus", async (importOriginal) => {
  const actual = await importOriginal<typeof CommandBus>();
  return { ...actual, executeCommand: executeCommandMock };
});

vi.mock("./claim-breached-orders.js", () => ({
  claimBreachedOrders: vi.fn(),
}));

import { logger } from "@pharmax/platform-core";

import { claimBreachedOrders } from "./claim-breached-orders.js";
import { createSlaBreachEvaluator } from "./sla-breach-evaluator.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const SERVICE_USER_ID = "00000000-0000-4000-8000-000000000099";
const DEADLINE = new Date("2026-05-25T12:00:00.000Z");

const DUE_ROW = Object.freeze({
  id: ORDER_ID,
  organizationId: ORG_ID,
  currentStatus: "FILL_IN_PROGRESS",
  slaDeadlineAt: DEADLINE,
});

function buildPrismaFake(input: { orgSlug?: string | null; actorUserId?: string | null } = {}) {
  return {
    organization: {
      findUnique: vi.fn(async () =>
        input.orgSlug === null ? null : { slug: input.orgSlug ?? "acme" }
      ),
    },
    user: {
      findFirst: vi.fn(async () =>
        input.actorUserId === null ? null : { id: input.actorUserId ?? SERVICE_USER_ID }
      ),
    },
  };
}

beforeEach(() => {
  executeCommandMock.mockClear();
  vi.mocked(claimBreachedOrders).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SlaBreachEvaluator tick — happy path", () => {
  it("dispatches EscalateOrderForSlaBreach per breached order, keyed on (order, deadline)", async () => {
    vi.mocked(claimBreachedOrders).mockResolvedValue([DUE_ROW]);
    const fake = buildPrismaFake();
    const evaluator = createSlaBreachEvaluator(
      { client: fake as never, logger: logger.noopLogger },
      { batchSize: 50 }
    );

    const result = await evaluator.tick();
    expect(result).toEqual({
      claimed: 1,
      escalated: 1,
      alreadyEscalated: 0,
      failed: 0,
      skipped: 0,
    });

    expect(executeCommandMock).toHaveBeenCalledTimes(1);
    const callArgs = executeCommandMock.mock.calls[0]!;
    const cmdInput = callArgs[1] as { orderId: string; slaDeadlineAt: string };
    expect(cmdInput.orderId).toBe(ORDER_ID);
    expect(cmdInput.slaDeadlineAt).toBe(DEADLINE.toISOString());
    const cmdOpts = callArgs[2] as { idempotencyKey: string };
    expect(cmdOpts.idempotencyKey).toBe(`sla-escalate:${ORDER_ID}:${DEADLINE.getTime()}`);

    // Resolved the per-org machine identity.
    expect(fake.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: ORG_ID,
          email: "shipping-webhook@acme.test",
        }),
      })
    );
  });
});

describe("SlaBreachEvaluator tick — already escalated (race guard)", () => {
  it("counts alreadyEscalated when the command no-ops", async () => {
    vi.mocked(claimBreachedOrders).mockResolvedValue([DUE_ROW]);
    executeCommandMock.mockResolvedValueOnce({
      orderId: ORDER_ID,
      bucketId: "emergency-bucket",
      alreadyEscalated: true,
      previousBucketId: null,
      version: 9,
    });
    const fake = buildPrismaFake();
    const evaluator = createSlaBreachEvaluator(
      { client: fake as never, logger: logger.noopLogger },
      { batchSize: 50 }
    );

    const result = await evaluator.tick();
    expect(result).toEqual({
      claimed: 1,
      escalated: 0,
      alreadyEscalated: 1,
      failed: 0,
      skipped: 0,
    });
  });
});

describe("SlaBreachEvaluator tick — graceful skip when service user missing", () => {
  it("marks SKIPPED and does NOT dispatch", async () => {
    vi.mocked(claimBreachedOrders).mockResolvedValue([DUE_ROW]);
    const fake = buildPrismaFake({ actorUserId: null });
    const evaluator = createSlaBreachEvaluator(
      { client: fake as never, logger: logger.noopLogger },
      { batchSize: 50 }
    );

    const result = await evaluator.tick();
    expect(result).toEqual({
      claimed: 1,
      escalated: 0,
      alreadyEscalated: 0,
      failed: 0,
      skipped: 1,
    });
    expect(executeCommandMock).not.toHaveBeenCalled();
  });
});

describe("SlaBreachEvaluator tick — failure isolation", () => {
  it("marks FAILED and continues processing subsequent orders", async () => {
    const row2 = { ...DUE_ROW, id: "ord-2" };
    vi.mocked(claimBreachedOrders).mockResolvedValue([DUE_ROW, row2]);
    executeCommandMock.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    const fake = buildPrismaFake();
    const evaluator = createSlaBreachEvaluator(
      { client: fake as never, logger: logger.noopLogger },
      { batchSize: 50 }
    );

    const result = await evaluator.tick();
    expect(result).toEqual({
      claimed: 2,
      escalated: 1,
      alreadyEscalated: 0,
      failed: 1,
      skipped: 0,
    });
  });
});

describe("SlaBreachEvaluator tick — empty batch", () => {
  it("returns zeros when nothing is breached", async () => {
    vi.mocked(claimBreachedOrders).mockResolvedValue([]);
    const fake = buildPrismaFake();
    const evaluator = createSlaBreachEvaluator(
      { client: fake as never, logger: logger.noopLogger },
      { batchSize: 50 }
    );
    const result = await evaluator.tick();
    expect(result).toEqual({
      claimed: 0,
      escalated: 0,
      alreadyEscalated: 0,
      failed: 0,
      skipped: 0,
    });
    expect(executeCommandMock).not.toHaveBeenCalled();
  });
});
