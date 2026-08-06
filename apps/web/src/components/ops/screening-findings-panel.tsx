// ScreeningFindingsPanel — what the PV1 clinical screen found, and the
// only surface from which a pharmacist can record a judgement on it.
//
// WHY THIS LIVES ON THE ORDER DETAIL PAGE. A finding is a claim about
// a prescription ("no drug knowledge is available for 00000-0000-01"),
// and it is actionable only beside the prescription it is about — the
// drug, the strength, the sig, the patient's other therapy. The PV1
// queue row carries none of that by design: it is a non-PHI scanning
// surface. Putting the acknowledge control there would let a
// pharmacist record a professional judgement about a prescription they
// never opened, which is the exact failure the command was built to
// make impossible on the API side.
//
// NO BULK ACKNOWLEDGE, AND THE THREE BLOCKS DO NOT SHARE A CONTROL.
// An acknowledgement is evidence with a name and a timestamp on it. A
// control that settles several findings at once produces that evidence
// for findings nobody read, and the record cannot tell the difference
// afterwards. The count is not the problem worth solving here: today
// every order raises three MODERATE gaps because no knowledge source
// is licensed and neither allergy capture nor a structured sig exists,
// and the fix for that is to ship those capabilities, not to make
// clicking past them faster. What this panel can do is refuse to let
// the habit generalize — the platform-capability gaps sit in their own
// block, at the bottom, in neutral tone, behind a button that names
// what it records. The reflex a pharmacist builds there is attached to
// that block's wording and position, not to the red card at the top.
//
// A HARD_STOP RENDERS NO CONTROL AT ALL — not a disabled button.
// There is no override path (`AcknowledgePV1ScreeningFinding` refuses
// to record one), and a greyed control still reads as "there is a way
// through here if I insist".
//
// PHI: none. Findings are PHI-free by construction; see the header of
// `get-order-screening.ts`.

import type { ReactNode } from "react";

import type {
  OrderScreening,
  OrderScreeningFindingView,
  ScreeningFindingGroup,
} from "../../server/ops/get-order-screening.js";
import { Badge, type Tone } from "../ui/badge.js";
import { Card, CardContent, CardHeader } from "../ui/card.js";
import { Banner, EmptyState } from "../ui/feedback.js";
import { Section } from "../ui/page.js";
import { ActionForm, SubmitButton } from "./action-form.js";

/**
 * Why the acknowledge control is or is not available to this viewer.
 *
 * Resolved by the page, not here: whether the order is still in review
 * and whether the operator holds `pv1.approve` are both facts about
 * the session, and the panel's job is to explain the consequence. The
 * command re-checks both — this only decides what to render.
 */
export type AcknowledgeGate =
  | { readonly kind: "OPEN" }
  | { readonly kind: "NO_PERMISSION" }
  | { readonly kind: "REVIEW_CLOSED" };

interface GroupPresentation {
  readonly title: string;
  readonly blurb: string;
  readonly acknowledgeLabel: string;
  /** Paint the card in its severity tone, or state the grade quietly. */
  readonly accentBySeverity: boolean;
}

const GROUPS: Readonly<Record<ScreeningFindingGroup, GroupPresentation>> = Object.freeze({
  CLINICAL: {
    title: "Findings on this prescription",
    blurb:
      "Raised against this prescription and the patient's active profile. These are what the screen exists to surface.",
    acknowledgeLabel: "Acknowledge finding",
    accentBySeverity: true,
  },
  PRESCRIPTION_COVERAGE: {
    title: "Checks that could not run for this prescription",
    blurb:
      "The screen reached these drugs and got no answer, so that axis was not checked for this order. Look the drug up before you settle it.",
    acknowledgeLabel: "Acknowledge unchecked drug",
    accentBySeverity: false,
  },
  ORGANIZATION_COVERAGE: {
    title: "Checks limited by this pharmacy's own reference data",
    blurb:
      "A compounded preparation's formula has ingredient rows that are not coded, so those rows were not machine-screened — read them in the ingredient list on the prescription line above. Coding the formula (a formulary task, not a per-order one) closes this for every future order.",
    acknowledgeLabel: "Acknowledge coverage limit",
    accentBySeverity: false,
  },
  PLATFORM_CAPABILITY: {
    title: "Checks Pharmax cannot perform yet",
    blurb:
      "These fire on every order and will keep firing until the capability ships — acknowledging one says you know the check did not run, and nothing about this patient. Treat the axis as unscreened.",
    acknowledgeLabel: "Acknowledge unavailable check",
    accentBySeverity: false,
  },
});

/** Display order: the prescription first, the platform last. */
const GROUP_ORDER: ReadonlyArray<ScreeningFindingGroup> = Object.freeze([
  "CLINICAL",
  "PRESCRIPTION_COVERAGE",
  "ORGANIZATION_COVERAGE",
  "PLATFORM_CAPABILITY",
]);

function severityTone(severity: string): Tone {
  switch (severity) {
    case "CONTRAINDICATED":
    case "MAJOR":
      return "danger";
    case "MODERATE":
      return "warning";
    case "MINOR":
      return "neutral";
    default:
      return "neutral";
  }
}

function dispositionLabel(disposition: string): string {
  switch (disposition) {
    case "HARD_STOP":
      return "No override";
    case "REQUIRES_ACKNOWLEDGEMENT":
      return "Needs acknowledgement";
    case "INFORMATIONAL":
      return "Informational";
    default:
      return disposition;
  }
}

function formatDateTime(value: Date): string {
  return value.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function GateNote({ gate }: { readonly gate: AcknowledgeGate }): ReactNode {
  switch (gate.kind) {
    case "OPEN":
      return null;
    case "NO_PERMISSION":
      return (
        <Banner tone="info" title="Read-only — acknowledging needs the approving grant">
          Recording a judgement is the same authority as signing the approval it opens, so it takes{" "}
          <code>pv1.approve</code>. Ask your admin, or hand the review to a pharmacist who holds it.
        </Banner>
      );
    case "REVIEW_CLOSED":
      return (
        <Banner tone="neutral" title="Read-only — this order is not in PV1 review">
          A judgement only means something while a review is open, so acknowledgements are recorded
          only while the order sits in PV1. This is the record of what the screen said.
        </Banner>
      );
    default: {
      const exhaustive: never = gate;
      return exhaustive;
    }
  }
}

function FindingCard({
  finding,
  orderId,
  presentation,
  gate,
}: {
  readonly finding: OrderScreeningFindingView;
  readonly orderId: string;
  readonly presentation: GroupPresentation;
  readonly gate: AcknowledgeGate;
}) {
  const tone = severityTone(finding.severity);
  const isHardStop = finding.disposition === "HARD_STOP";

  return (
    <Card accent={presentation.accentBySeverity ? tone : undefined}>
      <CardHeader>
        <div className="min-w-0 space-y-1">
          <div className="font-mono text-sm font-semibold text-fg">{finding.code}</div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={presentation.accentBySeverity ? tone : "neutral"}>
              {finding.severity}
            </Badge>
            <Badge tone="neutral">{finding.certainty}</Badge>
            <Badge tone={isHardStop ? "danger" : "neutral"}>
              {dispositionLabel(finding.disposition)}
            </Badge>
          </div>
        </div>
        <div className="shrink-0">
          {finding.acknowledgedByViewer ? (
            <Badge tone="success" icon="check">
              Acknowledged by you
            </Badge>
          ) : finding.patientScopeCoverage?.kind === "COVERED" ? (
            <Badge tone="success" icon="check">
              Acknowledged for this patient by you
            </Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-fg">{finding.reason}</p>

        {/* Patient-scoped coverage is stated, never silent. A safety
            prompt that quietly stops appearing reads as "screened
            clean"; this line is the difference between suppression
            and a visible, dated judgement. */}
        {finding.patientScopeCoverage?.kind === "COVERED" ? (
          <p className="text-xs text-subtle">
            You acknowledged this for this patient on{" "}
            <span className="text-muted">
              {formatDateTime(finding.patientScopeCoverage.acknowledgedAt)}
            </span>
            . It covers every order for this patient — signed by you, not by colleagues — until the
            patient&apos;s record changes, at which point it will ask again.
          </p>
        ) : null}

        {finding.patientScopeCoverage?.kind === "SUPERSEDED" ? (
          <p className="text-xs font-medium text-tone-warning-strong">
            You acknowledged this for this patient on{" "}
            {formatDateTime(finding.patientScopeCoverage.lastAcknowledgedAt)}, but the
            patient&apos;s record has changed since — data was added or retracted. The situation in
            front of you is not the one you judged, so it needs a fresh acknowledgement.
          </p>
        ) : null}

        {finding.triggers.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-subtle">
            <span>Triggered by</span>
            {finding.triggers.map((trigger) => (
              <code
                key={trigger.code}
                className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-2xs text-muted"
              >
                {trigger.code}
              </code>
            ))}
          </div>
        ) : null}

        {finding.citation !== null ? (
          <p className="text-xs text-subtle">
            Source <span className="text-muted">{finding.citation}</span>
          </p>
        ) : null}

        {/* A hard stop gets a sentence and no control. The absence IS
            the design — see the module header. */}
        {isHardStop ? (
          <p className="text-sm font-medium text-tone-danger-strong">
            No override path. This prescription cannot pass PV1 as written — reject it and contact
            the prescriber.
          </p>
        ) : null}

        {finding.acknowledgeable && gate.kind === "OPEN" ? (
          <ActionForm action={`/api/ops/orders/${orderId}/acknowledge-pv1-screening-finding`}>
            {/* The fingerprint is the finding's identity. The command
                refuses any value that was not persisted for this
                order, so a stale panel fails loudly instead of
                settling something the pharmacist never saw. */}
            <input type="hidden" name="fingerprint" value={finding.fingerprint} />
            <SubmitButton
              variant={presentation.accentBySeverity ? "primary" : "secondary"}
              size="sm"
            >
              {presentation.acknowledgeLabel}
            </SubmitButton>
          </ActionForm>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function ScreeningFindingsPanel({
  orderId,
  screening,
  gate,
}: {
  readonly orderId: string;
  readonly screening: OrderScreening | null;
  readonly gate: AcknowledgeGate;
}) {
  if (screening === null) {
    return (
      <Section title="Clinical screening">
        <EmptyState
          icon="verify"
          title="Not screened yet"
          description="A clinical screen runs when a pharmacist claims this order for PV1, and again when they approve it."
        />
      </Section>
    );
  }

  const grouped = GROUP_ORDER.map((group) => ({
    group,
    presentation: GROUPS[group],
    findings: screening.findings.filter((finding) => finding.group === group),
  })).filter((block) => block.findings.length > 0);

  return (
    <Section
      title="Clinical screening"
      count={screening.findings.length}
      aside={<>Screened {formatDateTime(screening.screenedAt)}</>}
    >
      {screening.hardStopCount > 0 ? (
        <Banner tone="danger" title="Approval is not available for this order">
          Clinical screening returned {screening.hardStopCount} finding
          {screening.hardStopCount === 1 ? "" : "s"} with no override path. There is no
          acknowledgement that opens this — the route forward is Reject, and a call to the
          prescriber.
        </Banner>
      ) : screening.outstandingCount > 0 ? (
        <Banner tone="warning" title="Approval will be refused until you acknowledge these">
          {screening.outstandingCount} finding{screening.outstandingCount === 1 ? "" : "s"} still
          need your judgement. Acknowledgements are per-pharmacist: a colleague acknowledging the
          same finding does not satisfy your approval, and yours does not satisfy theirs.
        </Banner>
      ) : (
        <Banner tone="success" title="Nothing outstanding for you on this screen">
          Approval screens the order again at the moment you sign it, so a change to the patient's
          profile between now and then can raise something new.
        </Banner>
      )}

      <GateNote gate={gate} />

      {grouped.map((block) => (
        <div key={block.group} className="space-y-2">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-fg">{block.presentation.title}</h3>
            <p className="max-w-3xl text-xs text-muted">{block.presentation.blurb}</p>
          </div>
          <div className="space-y-3">
            {block.findings.map((finding) => (
              <FindingCard
                key={finding.findingId}
                finding={finding}
                orderId={orderId}
                presentation={block.presentation}
                gate={gate}
              />
            ))}
          </div>
        </div>
      ))}
    </Section>
  );
}
