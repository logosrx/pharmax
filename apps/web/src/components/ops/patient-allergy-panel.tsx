// PatientAllergyPanel — the patient's allergy profile, and the answer to
// the question a list alone cannot give: has anybody asked?
//
// =====================================================================
// WHY THE "NOT ASKED" STATE IS THE LOUDEST THING ON THIS PANEL
// =====================================================================
//
// An empty allergy list is ambiguous, and a reader resolves ambiguity
// toward the reassuring reading. "No allergies listed" and "nobody has
// taken an allergy history" look identical if you render them the same
// way, and only one of them is safe to dispense against. So the three
// states get visibly different treatment, and the dangerous one gets the
// warning banner:
//
//   NOT_ASKED           → amber banner, named as a gap, with the control
//                         to close it right here.
//   NO_KNOWN_ALLERGIES  → quiet success line, WITH who asserted it and
//                         when. An unattributed "none" is a rumour.
//   UNABLE_TO_ASSESS    → amber, because it is not an answer. Somebody
//                         tried; the gap is still open.
//
// =====================================================================
// WHY THE PANEL MATTERS EVEN WHERE THE ENGINE CANNOT SCREEN
// =====================================================================
//
// Two independent things have to be true before allergy screening
// works: we must hold the patient's allergies, AND we must be able to
// tell whether the prescribed drug contains the allergen. The second
// needs ingredient-level resolution and cross-reactivity data from a
// licensed source, and no such source is wired in production.
//
// So for now this panel is not a convenience beside an automated check —
// for a large fraction of records it IS the check. A pharmacist reading
// "anaphylaxis to penicillin" next to the prescription is doing the
// comparison the engine cannot. Two consequences for the design:
//
//   - Records the engine cannot use are shown, not hidden, and marked
//     "not screened" so nobody assumes the machine has them covered.
//     An UNCODED allergen ("sulfa, as the patient said it") is exactly
//     such a record, and it is the one where the human is the only
//     reader there will ever be.
//   - Retracted and retired records are shown too, greyed, with the
//     reason. A pharmacist wants to know that a penicillin allergy was
//     refuted last year and by what.

import type { ReactNode } from "react";

import { ALLERGY_STATUS_CHANGE_REASON_CODES, type PatientAllergyView } from "@pharmax/patients";

import type { PatientAllergyProfile } from "../../server/ops/get-patient-allergies.js";
import { Badge, type Tone } from "../ui/badge.js";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card.js";
import { Banner, EmptyState } from "../ui/feedback.js";
import { Field, Input, Select } from "../ui/field.js";
import { Section } from "../ui/page.js";
import { ActionForm, SubmitButton } from "./action-form.js";

/** What this viewer may do, resolved by the page from its permissions. */
export interface AllergyPanelCapabilities {
  readonly canRecord: boolean;
  readonly canAmendStatus: boolean;
}

export interface PatientAllergyPanelProps {
  readonly profile: PatientAllergyProfile;
  readonly capabilities: AllergyPanelCapabilities;
  /** Where the capture forms post to, e.g. `/api/ops/admin/patients/:id`. */
  readonly actionBase: string;
  /** Rendered instead of the forms when the surface is read-only. */
  readonly title?: string;
  readonly footnote?: ReactNode;
}

const CATEGORIES = ["MEDICATION", "BIOLOGIC", "FOOD", "ENVIRONMENT"] as const;
const TYPES = ["ALLERGY", "INTOLERANCE"] as const;
const CRITICALITIES = ["HIGH", "LOW", "UNABLE_TO_ASSESS"] as const;
const VERIFICATION_STATUSES = ["UNCONFIRMED", "CONFIRMED"] as const;
const CODE_SYSTEMS = ["RXNORM", "NDC", "SNOMED_CT", "PHARMAX_ALLERGEN_CLASS", "UNCODED"] as const;
const REACTION_SEVERITIES = ["MILD", "MODERATE", "SEVERE"] as const;
const MANIFESTATIONS = [
  "ANAPHYLAXIS",
  "ANGIOEDEMA",
  "BRONCHOSPASM",
  "HYPOTENSION",
  "URTICARIA",
  "RASH",
  "PRURITUS",
  "SEVERE_CUTANEOUS_REACTION",
  "NAUSEA_OR_VOMITING",
  "DIARRHEA",
  "ABDOMINAL_PAIN",
  "HEADACHE",
  "DIZZINESS",
  "HEPATOTOXICITY",
  "NEPHROTOXICITY",
  "CYTOPENIA",
  "OTHER",
] as const;

const AMEND_CLINICAL_STATUSES = ["ACTIVE", "INACTIVE", "RESOLVED"] as const;
const AMEND_VERIFICATION_STATUSES = [
  "CONFIRMED",
  "UNCONFIRMED",
  "REFUTED",
  "ENTERED_IN_ERROR",
] as const;

/**
 * Criticality drives the tone, not reaction severity.
 *
 * Criticality is the risk of a FUTURE exposure being life-threatening,
 * which is the question a pharmacist about to dispense is asking.
 * Reaction severity describes what happened last time. Colouring by the
 * latter would paint a mild first reaction calm on a patient graded
 * high-risk for the next one.
 */
function criticalityTone(allergy: PatientAllergyView): Tone {
  if (!isLive(allergy)) return "neutral";
  if (allergy.type === "INTOLERANCE") return "neutral";
  switch (allergy.criticality) {
    case "HIGH":
      return "danger";
    case "LOW":
    case "UNABLE_TO_ASSESS":
      return "warning";
    default:
      return "neutral";
  }
}

/** Whether this record still describes a live risk. */
function isLive(allergy: PatientAllergyView): boolean {
  if (allergy.verificationStatus === "REFUTED") return false;
  if (allergy.verificationStatus === "ENTERED_IN_ERROR") return false;
  return allergy.clinicalStatus === "ACTIVE";
}

function humanize(code: string): string {
  return code.toLowerCase().replaceAll("_", " ");
}

/** What to call the allergen when the panel has to name it. */
function substanceLabel(allergy: PatientAllergyView): string {
  if (allergy.substanceLabel !== null && allergy.substanceLabel.length > 0) {
    return allergy.substanceLabel;
  }
  if (allergy.substanceCode !== null) return allergy.substanceCode;
  // Reachable only when the narrative failed to decrypt on an UNCODED
  // record: the CHECK constraint guarantees one of the two is present.
  // Say so rather than rendering an empty row, which would read as a
  // record with nothing in it.
  return "— unreadable, see the decrypt warning above —";
}

function HistoryState({ profile }: { readonly profile: PatientAllergyProfile }): ReactNode {
  const state = profile.historyState;

  if (state.kind === "NOT_ASKED") {
    return (
      <Banner tone="warning" title="No allergy history has been taken">
        This is <strong>not</strong> the same as &ldquo;no known allergies&rdquo;. Nobody has
        recorded an allergy history for this patient, so PV1 screening reports the allergy check as
        not performed and asks the verifying pharmacist to acknowledge it. Take a history and record
        it below — including recording that there are none, if that is the answer.
      </Banner>
    );
  }

  if (state.kind === "UNABLE_TO_ASSESS") {
    return (
      <Banner tone="warning" title="Allergy history was attempted and could not be obtained">
        Recorded as <strong>unable to assess</strong> on{" "}
        <span className="font-mono">{state.assertedAt.toISOString().slice(0, 10)}</span>. This
        deliberately does not satisfy allergy screening: an attempt is not an answer, and the gap
        stays open until a history is obtained.
      </Banner>
    );
  }

  // A NO_KNOWN_ALLERGIES assertion coexisting with a live allergy
  // record is stale, and screening already treats it that way: the
  // availability computation reads the records first and never consults
  // the assertion (see `hasScreenableAllergyInput`). The banner must not
  // out-claim the screen — a green "no known allergies" line above a
  // live penicillin row is exactly the reassuring misreading this panel
  // exists to prevent.
  if (profile.allergies.some(isLive)) {
    return (
      <Banner tone="warning" title="A no-known-allergies assertion has been superseded">
        &ldquo;No known allergies&rdquo; was asserted on{" "}
        <span className="font-mono">{state.assertedAt.toISOString().slice(0, 10)}</span> by user{" "}
        <span className="font-mono text-xs">{state.assertedByUserId}</span>, but this patient now
        has live allergy records below. Screening uses the records, not the assertion; the assertion
        stays in the history as the record of who said what, when.
      </Banner>
    );
  }

  return (
    <Banner tone="success" title="Allergy history taken — no known allergies">
      Asserted on <span className="font-mono">{state.assertedAt.toISOString().slice(0, 10)}</span>{" "}
      by user <span className="font-mono text-xs">{state.assertedByUserId}</span>. Allergy screening
      treats this patient as screened and clear on that axis.
    </Banner>
  );
}

function AllergyRow({
  allergy,
  capabilities,
  actionBase,
}: {
  readonly allergy: PatientAllergyView;
  readonly capabilities: AllergyPanelCapabilities;
  readonly actionBase: string;
}): ReactNode {
  const live = isLive(allergy);
  const tone = criticalityTone(allergy);

  return (
    <Card accent={tone === "danger" ? "danger" : undefined}>
      <CardContent className={live ? "space-y-2" : "space-y-2 opacity-60"}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-fg">{substanceLabel(allergy)}</span>
          <Badge tone={tone}>{humanize(allergy.type)}</Badge>
          <Badge tone={tone}>criticality {humanize(allergy.criticality)}</Badge>
          <Badge tone="neutral">{humanize(allergy.category)}</Badge>
          {live ? null : (
            <Badge tone="neutral">
              {allergy.verificationStatus === "REFUTED" ||
              allergy.verificationStatus === "ENTERED_IN_ERROR"
                ? humanize(allergy.verificationStatus)
                : humanize(allergy.clinicalStatus)}
            </Badge>
          )}
          {/* The badge that stops a pharmacist assuming the engine has
              this covered. For an uncoded allergen, reading this row IS
              the screen. */}
          {allergy.screenable ? null : (
            <Badge tone="warning">not machine-screened — read this row</Badge>
          )}
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted sm:grid-cols-4">
          <div>
            <dt className="text-subtle">Code</dt>
            <dd className="font-mono">
              {allergy.substanceCode ?? "—"} ({humanize(allergy.substanceCodeSystem)})
            </dd>
          </div>
          <div>
            <dt className="text-subtle">Verification</dt>
            <dd>{humanize(allergy.verificationStatus)}</dd>
          </div>
          <div>
            <dt className="text-subtle">Clinical status</dt>
            <dd>{humanize(allergy.clinicalStatus)}</dd>
          </div>
          <div>
            <dt className="text-subtle">Onset</dt>
            <dd className="font-mono">
              {allergy.onsetDate === null ? "—" : allergy.onsetDate.toISOString().slice(0, 10)}
            </dd>
          </div>
        </dl>

        {allergy.reactionManifestations.length > 0 || allergy.reactionSeverity !== null ? (
          <p className="text-sm text-muted">
            <span className="text-subtle">Reaction: </span>
            {allergy.reactionManifestations.map((m) => humanize(m)).join(", ") || "not recorded"}
            {allergy.reactionSeverity === null
              ? null
              : ` (${humanize(allergy.reactionSeverity)} when it happened)`}
          </p>
        ) : null}

        {allergy.reactionNote === null ? null : (
          <p className="text-sm text-muted">
            <span className="text-subtle">Note: </span>
            {allergy.reactionNote}
          </p>
        )}

        {allergy.statusChangeReason === null ? null : (
          <p className="text-xs text-subtle">
            Status changed for reason{" "}
            <code className="font-mono">{allergy.statusChangeReason}</code>.
          </p>
        )}

        {capabilities.canAmendStatus ? (
          <ActionForm
            action={`${actionBase}/allergies/${allergy.allergyId}/amend-status`}
            className="flex flex-wrap items-end gap-2 border-t border-subtle pt-2"
          >
            <Field label="Clinical status">
              <Select name="clinicalStatus" defaultValue={allergy.clinicalStatus}>
                {AMEND_CLINICAL_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Verification">
              <Select name="verificationStatus" defaultValue={allergy.verificationStatus}>
                {AMEND_VERIFICATION_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Reason">
              <Select name="reasonCode" defaultValue={ALLERGY_STATUS_CHANGE_REASON_CODES[0]}>
                {ALLERGY_STATUS_CHANGE_REASON_CODES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </Select>
            </Field>
            <SubmitButton variant="secondary" icon="check">
              Amend status
            </SubmitButton>
          </ActionForm>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function PatientAllergyPanel({
  profile,
  capabilities,
  actionBase,
  title = "Allergies & intolerances",
  footnote,
}: PatientAllergyPanelProps): ReactNode {
  const unscreenable = profile.allergies.filter((a) => !a.screenable).length;

  return (
    <Section title={title}>
      <div className="space-y-3">
        <HistoryState profile={profile} />

        {profile.phiDecryptErrors ? (
          <Banner tone="danger" title="One or more allergy notes failed to decrypt">
            The coded fields below are complete; a narrative field could not be read. Treat this
            profile as INCOMPLETE and investigate before relying on it.
          </Banner>
        ) : null}

        {profile.allergies.length === 0 ? (
          <EmptyState
            icon="patients"
            title="No allergy or intolerance records"
            // Wording chosen so the empty list cannot be read as
            // reassurance on its own. The banner above is what says
            // whether that emptiness has been verified.
            action={
              <p className="text-sm text-muted">
                Whether this means &ldquo;none&rdquo; is answered by the history state above, not by
                this list being empty.
              </p>
            }
          />
        ) : (
          <>
            <p className="text-xs text-subtle">
              {profile.screenableCount} of {profile.allergies.length} record
              {profile.allergies.length === 1 ? "" : "s"} can be compared automatically at PV1.
              {unscreenable > 0
                ? ` ${unscreenable} cannot — uncoded, non-drug, or retired — and must be read.`
                : ""}
            </p>
            {profile.allergies.map((allergy) => (
              <AllergyRow
                key={allergy.allergyId}
                allergy={allergy}
                capabilities={capabilities}
                actionBase={actionBase}
              />
            ))}
          </>
        )}

        {footnote}

        {capabilities.canRecord ? (
          <>
            <Card>
              <CardHeader>
                <CardTitle>Record the allergy history</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm text-muted">
                  Use this after taking a history. <strong>No known allergies</strong> is a positive
                  clinical statement with your name on it, and it is what lets allergy screening
                  report clear. <strong>Unable to assess</strong> records that you tried and could
                  not find out — it does not close the gap, on purpose.
                </p>
                <ActionForm
                  action={`${actionBase}/allergies/assert-history`}
                  className="flex flex-wrap items-end gap-2"
                >
                  <Field label="History outcome">
                    <Select name="status" defaultValue="NO_KNOWN_ALLERGIES">
                      <option value="NO_KNOWN_ALLERGIES">No known allergies</option>
                      <option value="UNABLE_TO_ASSESS">Unable to assess</option>
                    </Select>
                  </Field>
                  <SubmitButton icon="check">Record history</SubmitButton>
                </ActionForm>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Add an allergy or intolerance</CardTitle>
              </CardHeader>
              <CardContent>
                <ActionForm action={`${actionBase}/allergies/record`} className="space-y-3">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    <Field
                      label="Code system"
                      help="UNCODED if you cannot code it — the record is then read by a human, not compared by the engine."
                    >
                      <Select name="substanceCodeSystem" defaultValue="RXNORM">
                        {CODE_SYSTEMS.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Substance code" help="Required unless the system is UNCODED.">
                      <Input
                        type="text"
                        name="substanceCode"
                        maxLength={64}
                        className="font-mono"
                      />
                    </Field>
                    <Field
                      label="Substance as reported"
                      help="What the patient or clinic actually said. Required when UNCODED. Stored encrypted."
                    >
                      <Input type="text" name="substanceLabel" maxLength={300} />
                    </Field>
                    <Field label="Category">
                      <Select name="category" defaultValue="MEDICATION">
                        {CATEGORIES.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Type" help="An intolerance is not immune-mediated.">
                      <Select name="type" defaultValue="ALLERGY">
                        {TYPES.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field
                      label="Criticality"
                      help="Risk that a FUTURE exposure is life-threatening — not how bad last time was."
                    >
                      <Select name="criticality" defaultValue="LOW">
                        {CRITICALITIES.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Verification">
                      <Select name="verificationStatus" defaultValue="UNCONFIRMED">
                        {VERIFICATION_STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Reaction severity" help="How bad the observed reaction was.">
                      <Select name="reactionSeverity" defaultValue="">
                        <option value="">— not recorded —</option>
                        {REACTION_SEVERITIES.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Onset date" help="YYYY-MM-DD, if known.">
                      <Input
                        type="text"
                        name="onsetDate"
                        placeholder="2015-07-04"
                        className="font-mono"
                      />
                    </Field>
                  </div>

                  <Field label="Reaction" help="Select every manifestation that applies.">
                    <div className="grid grid-cols-2 gap-1 sm:grid-cols-3 lg:grid-cols-4">
                      {MANIFESTATIONS.map((m) => (
                        <label key={m} className="flex items-center gap-1.5 text-xs text-muted">
                          <input
                            type="checkbox"
                            name="reactionManifestations"
                            value={m}
                            className="h-3.5 w-3.5"
                          />
                          {humanize(m)}
                        </label>
                      ))}
                    </div>
                  </Field>

                  <Field
                    label="Reaction note"
                    help="Free text. Stored encrypted and never used by the screening engine."
                  >
                    <Input type="text" name="reactionNote" maxLength={2000} />
                  </Field>

                  <SubmitButton icon="check">Record allergy</SubmitButton>
                </ActionForm>
              </CardContent>
            </Card>
          </>
        ) : null}
      </div>
    </Section>
  );
}
