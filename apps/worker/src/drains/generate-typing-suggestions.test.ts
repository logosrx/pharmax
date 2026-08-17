// Outbox handler for the typing-suggestion model stage.
//
// The handler itself is thin — the domain work lives in
// `runTypingSuggestionModelStage` — so these tests cover the part that
// is genuinely this file's job: translating an outbox row into a
// tenancy frame, and deciding which stage outcomes deserve a drainer
// RETRY versus a settled DISPATCHED.
//
// That retry decision is the load-bearing one. Under the drainer's
// contract a throw means retry-with-backoff, and a return means
// DISPATCHED. Retrying a deterministic model failure (unparseable
// output, unconfigured provider) would spend money re-proving it, so
// those settle. `RUN_CONTEXT_MISSING` — "the run row was not visible"
// — can be replica lag, so that one throws.
//
// All data is synthetic. No PHI.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { logger } from "@pharmax/platform-core";
import type * as TypingAssistModule from "@pharmax/typing-assist";
import { getCurrentContext } from "@pharmax/tenancy";

import type { ClaimedOutboxEventRow } from "./row-types.js";

const runModelStageMock = vi.fn();

// Partial mock: the real MODEL_FAILURE_CODES must survive, because the
// handler compares against it and a stubbed constant would make the
// retry assertions vacuous.
vi.mock("@pharmax/typing-assist", async (importOriginal) => {
  const actual = await importOriginal<typeof TypingAssistModule>();
  return { ...actual, runTypingSuggestionModelStage: runModelStageMock };
});

const { createGenerateTypingSuggestionsHandler } = await import("./generate-typing-suggestions.js");
const { MODEL_FAILURE_CODES } = await import("@pharmax/typing-assist");

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const RX_ID = "00000000-0000-4000-8000-00000000000b";
const RUN_ID = "00000000-0000-4000-8000-00000000000c";
const USER_ID = "00000000-0000-4000-8000-000000000009";

function row(payloadOverrides: Record<string, unknown> = {}): ClaimedOutboxEventRow {
  return {
    id: "outbox-1",
    organizationId: ORG_ID,
    eventType: "ai.typing_suggestion_run.requested.v1",
    aggregateType: "TypingSuggestionRun",
    aggregateId: RUN_ID,
    payload: {
      runId: RUN_ID,
      organizationId: ORG_ID,
      orderId: ORDER_ID,
      prescriptionId: RX_ID,
      requestedByUserId: USER_ID,
      policyVersion: 1,
      guardrailVersion: 1,
      occurredAt: "2026-08-16T12:00:00.000Z",
      ...payloadOverrides,
    },
    status: "PENDING",
    attempts: 0,
    lastError: null,
    nextAttemptAt: null,
    dispatchedAt: null,
    traceparent: null,
    createdAt: new Date("2026-08-16T12:00:00.000Z"),
  } as ClaimedOutboxEventRow;
}

const ctx = { logger: logger.noopLogger, receivedAt: new Date("2026-08-16T12:00:01.000Z") };

const stubPort = { provider: "bedrock", complete: vi.fn() };

function handler(modelPort: typeof stubPort | null = stubPort) {
  return createGenerateTypingSuggestionsHandler({ client: {} as never, modelPort });
}

beforeEach(() => {
  runModelStageMock.mockReset();
  runModelStageMock.mockResolvedValue({
    outcome: "COMPLETED",
    suggestionCount: 2,
    droppedCount: 1,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------
// Tenancy translation
// ---------------------------------------------------------------------

describe("generate-typing-suggestions — tenancy", () => {
  it("runs the stage in the row's org with the REQUESTER as actor", async () => {
    // The actor matters beyond bookkeeping: the stage reads
    // tenant-scoped rows through the tenancy-enforced client, and the
    // technician who asked for the review is the identity the run
    // belongs to.
    let seenOrg: string | null = null;
    let seenActor: string | null = null;
    runModelStageMock.mockImplementation(async () => {
      const current = getCurrentContext();
      seenOrg = current?.organizationId ?? null;
      seenActor = current?.actor.userId ?? null;
      return { outcome: "COMPLETED", suggestionCount: 0, droppedCount: 0 };
    });

    await handler()(row(), ctx);

    expect(seenOrg).toBe(ORG_ID);
    expect(seenActor).toBe(USER_ID);
  });

  it("passes the run id and the model port through to the stage", async () => {
    await handler()(row(), ctx);

    expect(runModelStageMock).toHaveBeenCalledTimes(1);
    expect(runModelStageMock.mock.calls[0]?.[0]).toMatchObject({
      organizationId: ORG_ID,
      runId: RUN_ID,
      modelPort: stubPort,
    });
  });

  it("passes a null port through rather than skipping the stage", async () => {
    // A null port must still SETTLE the run (the stage marks it
    // FAILED/MODEL_NOT_CONFIGURED). Short-circuiting here would leave
    // it PENDING_MODEL forever with nothing recorded.
    runModelStageMock.mockResolvedValue({
      outcome: "FAILED",
      failureCode: MODEL_FAILURE_CODES.MODEL_NOT_CONFIGURED,
    });

    await handler(null)(row(), ctx);

    expect(runModelStageMock.mock.calls[0]?.[0]).toMatchObject({ modelPort: null });
  });

  it("falls back to the row's aggregateId when the payload omits runId", async () => {
    await handler()(row({ runId: undefined }), ctx);

    expect(runModelStageMock.mock.calls[0]?.[0]).toMatchObject({ runId: RUN_ID });
  });
});

// ---------------------------------------------------------------------
// Retry decisions
// ---------------------------------------------------------------------

describe("generate-typing-suggestions — settles without retry", () => {
  for (const outcome of [
    { outcome: "COMPLETED", suggestionCount: 3, droppedCount: 0 },
    { outcome: "SKIPPED_TERMINAL", status: "COMPLETED" },
    { outcome: "SKIPPED_GATE_CLOSED" },
    { outcome: "FAILED", failureCode: MODEL_FAILURE_CODES.MODEL_NOT_CONFIGURED },
    { outcome: "FAILED", failureCode: MODEL_FAILURE_CODES.MODEL_CALL_FAILED },
    { outcome: "FAILED", failureCode: MODEL_FAILURE_CODES.MODEL_OUTPUT_INVALID },
  ]) {
    it(`returns normally for ${outcome.outcome}${
      "failureCode" in outcome ? `/${outcome.failureCode}` : ""
    }`, async () => {
      runModelStageMock.mockResolvedValue(outcome);

      await expect(handler()(row(), ctx)).resolves.toBeUndefined();
    });
  }
});

describe("generate-typing-suggestions — retries", () => {
  it("throws on RUN_CONTEXT_MISSING so the drainer backs off and retries", async () => {
    // The one failure that can be transient: the run row (or its
    // prescription) was not visible to this worker yet.
    runModelStageMock.mockResolvedValue({
      outcome: "FAILED",
      failureCode: MODEL_FAILURE_CODES.RUN_CONTEXT_MISSING,
    });

    await expect(handler()(row(), ctx)).rejects.toMatchObject({
      code: MODEL_FAILURE_CODES.RUN_CONTEXT_MISSING,
    });
  });

  it("throws when the payload carries no requester, without calling the stage", async () => {
    // No actor means no tenancy frame we could honestly construct.
    await expect(handler()(row({ requestedByUserId: undefined }), ctx)).rejects.toMatchObject({
      code: "TYPING_SUGGESTION_EVENT_MALFORMED",
    });

    expect(runModelStageMock).not.toHaveBeenCalled();
  });

  it("propagates a stage throw", async () => {
    runModelStageMock.mockRejectedValue(new Error("connection reset"));

    await expect(handler()(row(), ctx)).rejects.toThrow("connection reset");
  });
});

// ---------------------------------------------------------------------
// PHI
// ---------------------------------------------------------------------

describe("generate-typing-suggestions — logging", () => {
  it("logs ids, counts, and the outcome only", async () => {
    const info = vi.fn();
    await handler()(row(), { ...ctx, logger: { ...logger.noopLogger, info } });

    expect(info).toHaveBeenCalledTimes(1);
    const [, fields] = info.mock.calls[0] as [string, Record<string, unknown>];
    expect(fields).toEqual({
      outboxId: "outbox-1",
      runId: RUN_ID,
      organizationId: ORG_ID,
      outcome: "COMPLETED",
      suggestionCount: 2,
      droppedCount: 1,
    });
  });

  it("logs the failure code on a settled failure", async () => {
    runModelStageMock.mockResolvedValue({
      outcome: "FAILED",
      failureCode: MODEL_FAILURE_CODES.MODEL_OUTPUT_INVALID,
    });
    const info = vi.fn();

    await handler()(row(), { ...ctx, logger: { ...logger.noopLogger, info } });

    const [, fields] = info.mock.calls[0] as [string, Record<string, unknown>];
    expect(fields).toMatchObject({ failureCode: MODEL_FAILURE_CODES.MODEL_OUTPUT_INVALID });
    expect(fields).not.toHaveProperty("suggestionCount");
  });
});
