// Outbox handler for `ai.typing_suggestion_run.requested.v1` — the
// model stage of a typing-suggestion run.
//
// Why the worker and not the request command: the Bedrock call is
// network I/O with second-scale latency, and RequestTypingSuggestions
// holds the ORDER ROW LOCK for the duration of its tx. Splitting via
// the outbox keeps the lock held for milliseconds and gives the model
// call the drainer's retry/backoff machinery for free.
//
// Division of labor: everything domain-shaped (re-gating against live
// policy/guardrail switches, sig decryption + tripwire, prompt build,
// output parse/filter, persistence) lives in
// `runTypingSuggestionModelStage` (@pharmax/typing-assist). This file
// only adapts the outbox row to that function: tenancy context from
// the row's org + the requesting technician as actor, plus metrics.
//
// Idempotency: the stage function keys on run status — only
// PENDING_MODEL runs do work, so a redelivered event is a recorded
// no-op. Terminal failures are written to the RUN ROW (status FAILED +
// failureCode) by the stage function itself and the handler returns
// normally — retrying a deterministic failure (bad model output,
// unconfigured provider) via drainer backoff would spend money to
// reproduce it. `RUN_CONTEXT_MISSING` is the one exception: it throws,
// because "the run row is not visible yet" can be replica lag and IS
// worth the drainer's retry.
//
// PHI: nothing from the prescription is logged — ids, counts, and
// outcome tags only. The decrypted sig exists inside the stage
// function's scope and goes only to the BAA-covered provider.

import type { PrismaClient } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { getMeter } from "@pharmax/telemetry";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";
import {
  MODEL_FAILURE_CODES,
  runTypingSuggestionModelStage,
  type TypingModelPort,
} from "@pharmax/typing-assist";
import { ulid } from "ulid";

import type { OutboxEventHandler } from "./outbox-handlers.js";

const meter = getMeter("@pharmax/worker.typing-assist");

const modelStageOutcomeCounter = meter.createCounter(
  "pharmax_typing_suggestion_model_stage_total",
  {
    description:
      "Typing-suggestion model-stage executions by outcome (completed / failed / skipped_terminal / skipped_gate_closed).",
  }
);

export interface CreateGenerateTypingSuggestionsHandlerOptions {
  readonly client: PrismaClient;
  /**
   * Null when no Bedrock model is configured in this environment —
   * the stage function marks such runs FAILED("MODEL_NOT_CONFIGURED")
   * so the miss is visible on the run row and in the counter, never
   * a silently-stuck PENDING_MODEL.
   */
  readonly modelPort: TypingModelPort | null;
}

function readString(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function createGenerateTypingSuggestionsHandler(
  options: CreateGenerateTypingSuggestionsHandlerOptions
): OutboxEventHandler {
  return async (row, ctx) => {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const runId = readString(payload, "runId") ?? row.aggregateId;
    const requestedByUserId = readString(payload, "requestedByUserId");

    if (requestedByUserId === null) {
      // Registered-event payloads always carry the requester; a row
      // without one predates the schema or was hand-crafted. Fail the
      // row (retry → DEAD) so it surfaces in the dead-letter dashboard.
      throw new errors.InternalError({
        code: "TYPING_SUGGESTION_EVENT_MALFORMED",
        message: "ai.typing_suggestion_run.requested.v1 payload lacks requestedByUserId.",
        metadata: { outboxId: row.id, runId },
      });
    }

    const tenancy = buildTenancyContext({
      organizationId: row.organizationId,
      actor: { userId: requestedByUserId, correlationId: ulid() },
    });

    const result = await withTenancyContext(tenancy, () =>
      runTypingSuggestionModelStage({
        client: options.client,
        organizationId: row.organizationId,
        runId,
        modelPort: options.modelPort,
        now: () => new Date(),
      })
    );

    modelStageOutcomeCounter.add(1, { outcome: result.outcome.toLowerCase() });

    if (
      result.outcome === "FAILED" &&
      result.failureCode === MODEL_FAILURE_CODES.RUN_CONTEXT_MISSING
    ) {
      // No run row was visible to mark FAILED — possibly replica lag
      // or an out-of-order delivery. Throwing routes the row through
      // the drainer's backoff; if the run truly never existed the row
      // eventually lands DEAD, which is the correct loud outcome.
      throw new errors.InternalError({
        code: MODEL_FAILURE_CODES.RUN_CONTEXT_MISSING,
        message: "Typing-suggestion run (or its prescription) was not visible to the worker.",
        metadata: { outboxId: row.id, runId, organizationId: row.organizationId },
      });
    }

    ctx.logger.info("typing_suggestions.model_stage settled", {
      outboxId: row.id,
      runId,
      organizationId: row.organizationId,
      outcome: result.outcome,
      ...(result.outcome === "COMPLETED"
        ? { suggestionCount: result.suggestionCount, droppedCount: result.droppedCount }
        : {}),
      ...(result.outcome === "FAILED" ? { failureCode: result.failureCode } : {}),
    });
  };
}
