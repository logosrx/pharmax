// Pv1DecisionPanel — approve / reject, ON the review surface.
//
// WHY THE DECISION BELONGS HERE. The queue row can approve, but the
// queue row shows no findings — a pharmacist who opened the order,
// read the screen, and met a hard stop had to walk BACK to the queue
// to reject, and the approve they might click there is blind to
// everything this page just showed them. The decision controls belong
// beside the evidence they are a decision about.
//
// THE DIGEST IS THE LOAD-BEARING PART. The approve form carries
// `reviewedScreenDigest`: a hash of the exact findings list rendered
// above (computed by the page from the same projection the panel
// drew). `ApprovePV1` re-screens at sign-off and refuses if the fresh
// screen digests differently — for ANY difference, including ones the
// acknowledgement gate would wave through. That is the "screened at
// sign-off" guarantee: the approval on record names the list the
// pharmacist actually saw, or it does not happen.
//
// The queue's one-click approve stays digest-less deliberately: it
// renders no findings, so it has no list to attest to. Its protection
// remains the acknowledgement gate — which is exactly why the review
// surface, which CAN attest, must.
//
// UI gating only — the commands re-check permission, assignment,
// order stage and the digest itself. This decides what to render,
// never what is allowed.
//
// PHI: none. Order id, counts and a hash of PHI-free fingerprints.

import { PV1_REJECTION_REASONS } from "@pharmax/verification";

import type { OrderScreening } from "../../server/ops/get-order-screening.js";
import { Card, CardContent } from "../ui/card.js";
import { Field, Select } from "../ui/field.js";
import { Section } from "../ui/page.js";
import { ActionForm, SubmitButton } from "./action-form.js";

export interface Pv1DecisionCapabilities {
  /** Operator holds `pv1.approve`. */
  readonly canApprove: boolean;
  /** Operator holds `pv1.reject`. */
  readonly canReject: boolean;
}

/**
 * The PV1 decision block of the order detail page. The page renders it
 * only while the order is `PV1_IN_PROGRESS`; the panel renders nothing
 * when the operator can take neither action.
 */
export function Pv1DecisionPanel({
  orderId,
  screening,
  reviewedScreenDigest,
  capabilities,
}: {
  readonly orderId: string;
  readonly screening: OrderScreening | null;
  /**
   * Digest of `screening.findings` as rendered, or `null` when there
   * is no persisted screen to attest to (the command then falls back
   * to gate-only behaviour, same as a queue approve).
   */
  readonly reviewedScreenDigest: string | null;
  readonly capabilities: Pv1DecisionCapabilities;
}) {
  if (!capabilities.canApprove && !capabilities.canReject) return null;

  const hardStopCount = screening?.hardStopCount ?? 0;
  const outstandingCount = screening?.outstandingCount ?? 0;

  return (
    <Section title="PV1 decision">
      <Card>
        <CardContent className="space-y-4">
          {hardStopCount > 0 ? (
            <p className="text-sm font-medium text-tone-danger-strong">
              Screening shows {hardStopCount} hard stop{hardStopCount === 1 ? "" : "s"} — approval
              will be refused. The route forward is Reject, and a call to the prescriber.
            </p>
          ) : outstandingCount > 0 ? (
            <p className="text-sm font-medium text-tone-warning-strong">
              {outstandingCount} finding{outstandingCount === 1 ? "" : "s"} above still need your
              acknowledgement — approval will be refused until you record them.
            </p>
          ) : null}

          <div className="flex flex-wrap items-end gap-6">
            {capabilities.canApprove ? (
              <ActionForm action={`/api/ops/orders/${orderId}/approve-pv1`}>
                <input type="hidden" name="from" value="detail" />
                {reviewedScreenDigest !== null ? (
                  <input type="hidden" name="reviewedScreenDigest" value={reviewedScreenDigest} />
                ) : null}
                <SubmitButton variant="go" icon="check">
                  Approve PV1
                </SubmitButton>
              </ActionForm>
            ) : null}

            {capabilities.canReject ? (
              <ActionForm
                action={`/api/ops/orders/${orderId}/reject-pv1`}
                className="flex flex-wrap items-end gap-2"
              >
                <input type="hidden" name="from" value="detail" />
                <Field label="Rejection reason">
                  <Select name="reasonCode" defaultValue="DOSE_INCORRECT">
                    {PV1_REJECTION_REASONS.map((reason) => (
                      <option key={reason} value={reason}>
                        {reason}
                      </option>
                    ))}
                  </Select>
                </Field>
                <SubmitButton variant="danger" icon="x">
                  Reject
                </SubmitButton>
              </ActionForm>
            ) : null}
          </div>

          {capabilities.canApprove ? (
            <p className="max-w-3xl text-xs text-subtle">
              {reviewedScreenDigest !== null ? (
                <>
                  Approval is bound to the findings list shown above. The order is screened again at
                  the moment you sign; if that screen differs from this list in any way, the
                  approval is refused and you review the new findings instead.
                </>
              ) : (
                <>
                  No screen is on record for this order yet, so this approval carries no
                  reviewed-list attestation. The sign-off re-screen and its acknowledgement gate
                  still apply in full.
                </>
              )}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </Section>
  );
}
