// AI review panel for one prescription on the typing workbench.
//
// This is the human gate made visible. Nothing in the AI path can write
// to a prescription on its own; a proposal becomes an edit only when a
// technician presses Accept here, under their own identity, and the
// command re-verifies every safety property against live rows before
// touching a column.
//
// Three things the panel is deliberate about:
//
//   1. It shows the BEFORE and AFTER value side by side. A proposal
//      rendered as "set daysSupply to 30" asks the technician to trust
//      it; "30 → 90" asks them to check it, which is the job.
//   2. It labels PROVENANCE. A deterministic proposal is arithmetic or
//      a regulation citation and can be trusted like a calculator; a
//      model proposal is a judgement call carrying a confidence. Those
//      warrant different scrutiny, so they do not look alike.
//   3. Dismissal requires a reason from a closed list. The codes are
//      what separate "the model was wrong" from "the model was right
//      and I fixed it another way" — the only signal that makes
//      suggestion quality measurable later.
//
// The accept form carries `expectedOrderVersion` as a hidden field. That
// is not ceremony: it is the version the page READ, so a proposal
// accepted from a stale tab is refused by the command's optimistic-
// concurrency check instead of landing on top of a colleague's edit.
//
// PHI: every field a proposal can target is a structured non-PHI column
// by construction, so nothing here needs decryption or a view audit.

import {
  TYPING_SUGGESTION_DISMISS_REASONS,
  type TypingSuggestionDismissReason,
  type TypingSuggestionField,
} from "@pharmax/typing-assist";

import type {
  TypingWorkbenchRun,
  TypingWorkbenchSuggestion,
} from "../../server/ops/get-typing-workbench.js";
import { Badge } from "../ui/badge.js";
import { Card, CardContent } from "../ui/card.js";
import { Banner } from "../ui/feedback.js";
import { Field, Select } from "../ui/field.js";
import { Icon } from "../ui/icon.js";
import { Section } from "../ui/page.js";
import { ActionForm, SubmitButton } from "./action-form.js";

/**
 * Operator-facing names for the suggestion vocabulary. Keyed by the
 * union rather than `string` so adding a field to the vocabulary fails
 * the build here — a proposal rendered as a raw column name is a
 * proposal a technician cannot evaluate.
 */
const FIELD_LABELS: Record<TypingSuggestionField, string> = {
  quantityAuthorized: "Quantity authorized",
  daysSupply: "Days supply",
  refillsAuthorized: "Refills authorized",
  refillsRemaining: "Refills remaining",
  daw: "DAW code",
  expiresAt: "Expires on",
  earliestFillDate: "Earliest fill date",
  controlledSubstanceSchedule: "DEA schedule",
  sigStructureKind: "Sig structure",
  doseAmount: "Dose amount",
  doseUnit: "Dose unit",
  dosesPerDay: "Doses per day",
  drugStrength: "Drug strength",
  drugForm: "Drug form",
};

const DISMISS_REASON_LABELS: Record<TypingSuggestionDismissReason, string> = {
  SOURCE_DOCUMENT_CONFIRMS_TYPED_VALUE: "Source document confirms what I typed",
  FIXED_MANUALLY_DIFFERENT_VALUE: "Right problem, wrong fix — I corrected it by hand",
  INTENTIONAL_AS_PRESCRIBED: "Intentional as prescribed",
  ESCALATED_FOR_CLARIFICATION: "Escalated for clarification instead",
};

/** Why the model step did not run. Plain language, no internal codes. */
const SKIP_REASON_LABELS: Record<string, string> = {
  POLICY_DISABLED: "AI review is turned off for your organization.",
  PRODUCT_GUARDRAIL_DISABLED: "AI review is turned off for this product.",
  CONTROLLED_SUBSTANCE_NOT_OPTED_IN:
    "Your organization has not opted in to AI review for controlled substances.",
  GATE_CLOSED_AT_EXECUTION:
    "A setting changed between the request and the review, so the model step was skipped.",
};

/** Why the model step failed. Each is actionable by someone. */
const FAILURE_LABELS: Record<string, string> = {
  MODEL_NOT_CONFIGURED: "No AI model is configured in this environment — ask an administrator.",
  MODEL_CALL_FAILED: "The AI model could not be reached. Requesting another review will retry.",
  MODEL_OUTPUT_INVALID: "The AI model returned a response we could not read. Nothing was applied.",
  RUN_CONTEXT_MISSING: "This review could not be matched to the prescription.",
};

function fieldLabel(field: string): string {
  return FIELD_LABELS[field as TypingSuggestionField] ?? field;
}

function ValueDelta({ from, to }: { readonly from: string; readonly to: string }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2 font-mono text-sm">
      <span className="rounded bg-surface-2 px-1.5 py-0.5 text-muted line-through">{from}</span>
      <Icon name="arrowRight" size={14} className="text-subtle" />
      <span className="rounded bg-brand/15 px-1.5 py-0.5 font-semibold text-tone-brand">{to}</span>
    </span>
  );
}

function SourceBadge({ suggestion }: { readonly suggestion: TypingWorkbenchSuggestion }) {
  if (suggestion.source === "DETERMINISTIC") {
    return (
      <Badge tone="cyan" icon="check">
        Rule
      </Badge>
    );
  }
  return (
    <Badge tone="violet" icon="verify">
      AI
      {suggestion.confidencePercent !== null ? ` · ${suggestion.confidencePercent}%` : ""}
    </Badge>
  );
}

function RunStatusLine({ run }: { readonly run: TypingWorkbenchRun }) {
  const findings =
    run.deterministicFindingCount === 1
      ? "1 rule finding"
      : `${run.deterministicFindingCount} rule findings`;

  return (
    <div className="space-y-2">
      <p className="text-xs text-subtle">
        Reviewed {run.createdAt.toISOString().replace("T", " ").slice(0, 16)} UTC · {findings}
        {run.provider !== null ? ` · ${run.provider}` : ""}
        {run.modelId !== null ? ` · ${run.modelId}` : ""}
      </p>

      {run.status === "PENDING_MODEL" ? (
        <Banner tone="info" title="AI review in progress">
          The rule findings below are ready now. The AI step runs in the background — reload in a
          moment to see anything it adds.
        </Banner>
      ) : null}

      {run.status === "MODEL_SKIPPED" ? (
        <Banner tone="neutral" title="Rule checks only — the AI step did not run">
          {(run.modelSkipReasonCode !== null
            ? SKIP_REASON_LABELS[run.modelSkipReasonCode]
            : undefined) ?? "The AI step was not attempted for this review."}
        </Banner>
      ) : null}

      {run.status === "FAILED" ? (
        <Banner tone="warning" title="The AI step didn't finish">
          {(run.failureCode !== null ? FAILURE_LABELS[run.failureCode] : undefined) ??
            "The AI step failed. The rule findings below are unaffected."}
        </Banner>
      ) : null}

      {run.sigOmittedByPhiTripwire ? (
        <Banner tone="warning" title="Directions were withheld from the AI step">
          The sig looked like it contained identifying information, so it was not sent. The AI
          reviewed the structured fields only — check the dose fields by hand.
        </Banner>
      ) : null}
    </div>
  );
}

function SuggestionCard({
  suggestion,
  orderId,
  expectedOrderVersion,
  actionable,
}: {
  readonly suggestion: TypingWorkbenchSuggestion;
  readonly orderId: string;
  readonly expectedOrderVersion: number;
  readonly actionable: boolean;
}) {
  const base = `/api/ops/orders/${orderId}/typing-suggestions/${suggestion.suggestionId}`;

  return (
    <Card accent={suggestion.source === "MODEL" ? "violet" : "cyan"}>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-fg">{fieldLabel(suggestion.field)}</span>
              <SourceBadge suggestion={suggestion} />
            </div>
            <ValueDelta from={suggestion.currentValue} to={suggestion.suggestedValue} />
          </div>
        </div>

        <p className="text-sm text-muted">{suggestion.rationale}</p>

        {actionable ? (
          <div className="flex flex-wrap items-end gap-3 border-t border-line pt-3">
            <ActionForm
              action={`${base}/accept`}
              confirm={`Apply ${fieldLabel(suggestion.field)} = ${suggestion.suggestedValue}?`}
            >
              {/* The version this page read. A stale tab CAS-conflicts
                  rather than overwriting whatever moved since. */}
              <input type="hidden" name="expectedOrderVersion" value={expectedOrderVersion} />
              <SubmitButton variant="go" size="sm" icon="check">
                Accept
              </SubmitButton>
            </ActionForm>

            <ActionForm action={`${base}/dismiss`} className="flex flex-wrap items-end gap-2">
              <Field label="Dismiss because">
                <Select
                  name="dismissReasonCode"
                  defaultValue={TYPING_SUGGESTION_DISMISS_REASONS[0]}
                >
                  {TYPING_SUGGESTION_DISMISS_REASONS.map((reason) => (
                    <option key={reason} value={reason}>
                      {DISMISS_REASON_LABELS[reason]}
                    </option>
                  ))}
                </Select>
              </Field>
              <SubmitButton variant="secondary" size="sm" icon="x">
                Dismiss
              </SubmitButton>
            </ActionForm>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ResolvedRow({ suggestion }: { readonly suggestion: TypingWorkbenchSuggestion }) {
  const tone =
    suggestion.status === "ACCEPTED"
      ? "success"
      : suggestion.status === "DISMISSED"
        ? "neutral"
        : "warning";
  const label =
    suggestion.status === "SUPERSEDED" ? "Replaced by a newer review" : suggestion.status;

  return (
    <li className="flex flex-wrap items-center gap-2 py-1.5 text-xs text-muted">
      <Badge tone={tone}>{label}</Badge>
      <span className="text-fg">{fieldLabel(suggestion.field)}</span>
      <span className="font-mono text-subtle">
        {suggestion.currentValue} → {suggestion.suggestedValue}
      </span>
      {suggestion.dismissReasonCode !== null ? (
        <span className="text-subtle">
          ·{" "}
          {DISMISS_REASON_LABELS[suggestion.dismissReasonCode as TypingSuggestionDismissReason] ??
            suggestion.dismissReasonCode}
        </span>
      ) : null}
    </li>
  );
}

export function TypingSuggestionPanel({
  orderId,
  prescriptionId,
  expectedOrderVersion,
  run,
  openSuggestions,
  resolvedSuggestions,
  canUseAssist,
  actionable,
  typingAssistEnabled,
}: {
  readonly orderId: string;
  readonly prescriptionId: string;
  readonly expectedOrderVersion: number;
  readonly run: TypingWorkbenchRun | null;
  readonly openSuggestions: ReadonlyArray<TypingWorkbenchSuggestion>;
  readonly resolvedSuggestions: ReadonlyArray<TypingWorkbenchSuggestion>;
  /** `ai.typing_suggestions.use` — without it the panel is read-only. */
  readonly canUseAssist: boolean;
  /** Order is TYPING_IN_PROGRESS and this operator is the assignee. */
  readonly actionable: boolean;
  readonly typingAssistEnabled: boolean;
}) {
  const canAct = canUseAssist && actionable;

  return (
    <Section
      title="Transcription review"
      count={openSuggestions.length > 0 ? openSuggestions.length : undefined}
      aside={
        canAct ? (
          <ActionForm action={`/api/ops/orders/${orderId}/request-typing-suggestions`}>
            <input type="hidden" name="prescriptionId" value={prescriptionId} />
            <SubmitButton variant="secondary" size="sm" icon="verify">
              {run === null ? "Review this prescription" : "Review again"}
            </SubmitButton>
          </ActionForm>
        ) : null
      }
    >
      {!canUseAssist ? (
        <Banner tone="neutral" title="You can't run a transcription review">
          Ask your administrator for the <code>ai.typing_suggestions.use</code> grant.
        </Banner>
      ) : null}

      {canUseAssist && !typingAssistEnabled ? (
        <Banner tone="neutral" title="AI review is off for your organization">
          Rule checks still run and can still be applied. An organization administrator can enable
          the AI step in the AI assist policy.
        </Banner>
      ) : null}

      {run !== null ? <RunStatusLine run={run} /> : null}

      {openSuggestions.length > 0 ? (
        <div className="space-y-3">
          {openSuggestions.map((s) => (
            <SuggestionCard
              key={s.suggestionId}
              suggestion={s}
              orderId={orderId}
              expectedOrderVersion={expectedOrderVersion}
              actionable={canAct}
            />
          ))}
        </div>
      ) : run !== null ? (
        <Banner tone="success" title="Nothing flagged on this prescription">
          The rule checks found no problems
          {run.status === "COMPLETED" ? " and the AI step proposed no changes" : ""}. This is the
          common and expected result — it is not a sign the review failed to run.
        </Banner>
      ) : (
        <p className="text-sm text-subtle">
          No review has run for this prescription yet.
          {canAct ? " Use “Review this prescription” above." : ""}
        </p>
      )}

      {resolvedSuggestions.length > 0 ? (
        <details className="rounded-lg border border-line bg-surface/50 px-4 py-3">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-caps text-muted">
            Already decided ({resolvedSuggestions.length})
          </summary>
          <ul className="mt-2 divide-y divide-line">
            {resolvedSuggestions.map((s) => (
              <ResolvedRow key={s.suggestionId} suggestion={s} />
            ))}
          </ul>
        </details>
      ) : null}
    </Section>
  );
}
