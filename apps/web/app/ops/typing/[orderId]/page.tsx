// /ops/typing/[orderId] — pharmacy tech TYPING workbench.
//
// Typing was the only workflow stage with no per-order surface: the
// queue could claim and complete an order, but a typist had nowhere to
// review what they had transcribed. This page is that surface, and its
// centre of gravity is the AI review loop — request a review, then
// accept or dismiss each field-level proposal.
//
// Permission gates: page (typing.start), review actions
// (ai.typing_suggestions.use). Only the assignee can act, matching the
// command-bus assignee guards; everyone else gets a read-only view
// rather than buttons that fail on submit.
//
// PHI: this workbench is non-PHI, the same split the fill workbench
// uses — /ops/orders/[id] is the PHI read and carries the ViewPatient
// audit that showing patient identity and the sig requires. That split
// is a good fit here rather than a compromise: every field a suggestion
// can target is a structured non-PHI column by construction, so the
// whole review surface stays outside the PHI-audit path.

import Link from "next/link";

import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../src/server/auth/resolve-tenancy.js";
import {
  getTypingWorkbench,
  type TypingWorkbenchDraft,
} from "../../../../src/server/ops/get-typing-workbench.js";
import { ActionForm, SubmitButton } from "../../../../src/components/ops/action-form.js";
import { QueueFlash } from "../../../../src/components/ops/flash.js";
import { TypingSuggestionPanel } from "../../../../src/components/ops/typing-suggestion-panel.js";
import { Badge } from "../../../../src/components/ui/badge.js";
import { Card, CardContent, CardHeader, CardTitle } from "../../../../src/components/ui/card.js";
import { DataList } from "../../../../src/components/ui/data.js";
import { Banner, EmptyState, PermissionDenied } from "../../../../src/components/ui/feedback.js";
import { buttonClass } from "../../../../src/components/ui/button.js";
import { Icon } from "../../../../src/components/ui/icon.js";
import { PageHeader, Section } from "../../../../src/components/ui/page.js";
import { statusMeta } from "../../../../src/components/ui/workflow.js";

const TYPING_WORKBENCH_FLASH: Readonly<Record<string, string>> = {
  review_requested: "Transcription review requested.",
  suggestion_accepted: "Applied to the prescription.",
  suggestion_dismissed: "Dismissed — your reason was recorded.",
  completed: "Typing review complete — order moved to PV1.",
};

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dash(value: string | number | null): string {
  return value === null || value === "" ? "—" : String(value);
}

/**
 * The draft as a technician reads it. Deliberately the SAME field set a
 * suggestion can target, so a proposal always points at something
 * visible on this page — a proposal about a field the page does not show
 * is a proposal nobody can check.
 */
function draftItems(draft: TypingWorkbenchDraft) {
  const dose =
    draft.doseAmount === null && draft.doseUnit === null
      ? "—"
      : `${dash(draft.doseAmount)} ${draft.doseUnit ?? ""}`.trim();

  return [
    {
      label: "Quantity",
      value: <span className="font-mono tabular-nums">{draft.quantityAuthorized}</span>,
    },
    { label: "Days supply", value: <span className="tabular-nums">{draft.daysSupply}</span> },
    {
      label: "Refills",
      value: (
        <span className="tabular-nums">
          {draft.refillsRemaining} left of {draft.refillsAuthorized}
        </span>
      ),
    },
    { label: "DAW", value: <span className="tabular-nums">{draft.daw}</span> },
    { label: "Written", value: isoDate(draft.originalDateWritten) },
    { label: "Expires", value: isoDate(draft.expiresAt) },
    {
      label: "Earliest fill",
      value: draft.earliestFillDate === null ? "—" : isoDate(draft.earliestFillDate),
    },
    { label: "DEA schedule", value: draft.controlledSubstanceSchedule },
    { label: "Sig structure", value: dash(draft.sigStructureKind) },
    { label: "Dose", value: dose },
    { label: "Doses per day", value: dash(draft.dosesPerDay) },
  ];
}

export default async function TypingWorkbenchPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly orderId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ orderId }, sp] = await Promise.all([params, searchParams]);
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.TYPING_START)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Intake" title="Typing workbench" />
        <PermissionDenied grant="typing.start" role="Pharmacy Technician" />
      </div>
    );
  }

  const canUseAssist = hasOperatorPermission(permissions, PERMISSIONS.AI_TYPING_SUGGESTIONS_USE);
  const canComplete = hasOperatorPermission(permissions, PERMISSIONS.TYPING_COMPLETE);

  const workbench = await getTypingWorkbench({
    organizationId: session.tenancy.organizationId,
    orderId,
  });

  if (workbench === null) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Intake" title="Order not found" />
        <EmptyState
          icon="typing"
          title="This order doesn't exist in your organization"
          action={
            <Link href="/ops/typing" className={buttonClass({ variant: "secondary", size: "sm" })}>
              Back to typing queue
            </Link>
          }
        />
      </div>
    );
  }

  const isMine = workbench.currentAssigneeUserId === session.operator.userId;
  const inProgress = workbench.currentStatus === "TYPING_IN_PROGRESS";
  const actionable = inProgress && isMine;
  const sm = statusMeta(workbench.currentStatus);
  const openCount = workbench.lines.reduce((n, l) => n + l.openSuggestions.length, 0);

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/ops/typing"
          className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-fg"
        >
          <Icon name="arrowLeft" size={15} />
          Back to typing queue
        </Link>
        <Link
          href={`/ops/orders/${workbench.orderId}`}
          className="inline-flex items-center gap-1.5 text-sm text-brand transition-colors hover:underline"
        >
          Order detail (patient + sig)
          <Icon name="arrowRight" size={15} />
        </Link>
      </div>

      <PageHeader
        eyebrow={
          <span className="normal-case tracking-normal text-subtle">
            v{workbench.version}
            {workbench.currentAssigneeUserId !== null ? (
              <>
                {" "}
                · assignee <code>{workbench.currentAssigneeUserId}</code>
              </>
            ) : null}
          </span>
        }
        title={
          <span className="font-mono">{workbench.externalOrderNumber ?? workbench.orderId}</span>
        }
        description="Check the transcription against the source document. Rule findings are arithmetic and regulation; AI proposals are judgement calls — both need your approval before anything changes."
        actions={
          <Badge tone={sm.tone} dot>
            {sm.label}
          </Badge>
        }
      />

      <QueueFlash params={sp} messages={TYPING_WORKBENCH_FLASH} />

      {!inProgress ? (
        <Banner tone="warning" title="Review actions inactive">
          This order is not in TYPING_IN_PROGRESS. Status <code>{workbench.currentStatus}</code>.
          Proposals can only be applied while typing is in progress.
        </Banner>
      ) : null}
      {inProgress && !isMine ? (
        <Banner tone="warning" title="Read-only — you're not the assignee">
          {workbench.currentAssigneeUserId === null
            ? "Claim this order from the typing queue to act on it."
            : "The assignee owns this transcription. Claim it from the queue only if they have handed it off."}
        </Banner>
      ) : null}

      {workbench.lines.length === 0 ? (
        <EmptyState
          icon="typing"
          title="This order has no prescription lines"
          description="Nothing to review. An order with no lines cannot be typed — check intake."
        />
      ) : null}

      {workbench.lines.map((line) => (
        <Card key={line.orderLineId}>
          <CardHeader>
            <div className="min-w-0">
              <CardTitle className="text-base">
                {line.drugName}
                {line.drugStrength !== null ? ` ${line.drugStrength}` : ""}
                {line.drugForm !== null ? ` (${line.drugForm})` : ""}
              </CardTitle>
              <div className="mt-0.5 font-mono text-xs text-subtle">
                Rx {line.rxNumber} · NDC {line.drugNdc}
              </div>
            </div>
            {line.openSuggestions.length > 0 ? (
              <Badge tone="brand">{line.openSuggestions.length} to review</Badge>
            ) : null}
          </CardHeader>
          <CardContent className="space-y-5">
            <Section title="Typed values">
              <DataList columns={4} items={draftItems(line.draft)} />
            </Section>

            <TypingSuggestionPanel
              orderId={workbench.orderId}
              prescriptionId={line.prescriptionId}
              expectedOrderVersion={workbench.version}
              run={line.latestRun}
              openSuggestions={line.openSuggestions}
              resolvedSuggestions={line.resolvedSuggestions}
              canUseAssist={canUseAssist}
              actionable={actionable}
              typingAssistEnabled={workbench.typingAssistEnabled}
            />
          </CardContent>
        </Card>
      ))}

      {actionable && canComplete ? (
        <Section title="Finish">
          <Card>
            <CardContent className="space-y-3">
              {openCount > 0 ? (
                <Banner
                  tone="warning"
                  title={`${openCount} proposal${openCount === 1 ? "" : "s"} still open`}
                >
                  Completing typing leaves them undecided. They stay on the record but the
                  pharmacist sees the values as typed — decide them first if any is a real
                  correction.
                </Banner>
              ) : null}
              <ActionForm action={`/api/ops/orders/${workbench.orderId}/complete-typing-review`}>
                <SubmitButton variant="go" icon="arrowRight">
                  Complete review · to PV1
                </SubmitButton>
              </ActionForm>
            </CardContent>
          </Card>
        </Section>
      ) : null}
    </div>
  );
}
