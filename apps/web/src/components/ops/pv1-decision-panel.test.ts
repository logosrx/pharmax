// What the PV1 decision block renders, and what its forms carry.
//
// The quiet failure this guards: the approve form posting WITHOUT the
// digest (or with a stale prop wired in) still renders, still
// typechecks, and still approves — it just approves without the
// "screened at sign-off" attestation the surface exists to provide.
// So the load-bearing assertions here are about hidden form fields,
// not visible text: the digest rides the approve form when there is a
// screen to attest to, is absent when there is not, and both forms
// declare `from=detail` so a refusal lands back beside the findings.
//
// CLEAN ROOM / PHI: synthetic ids only; the digest is a hash of
// PHI-free fingerprints.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { OrderScreening } from "../../server/ops/get-order-screening.js";

import { Pv1DecisionPanel, type Pv1DecisionCapabilities } from "./pv1-decision-panel.js";

const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const DIGEST = "3a".repeat(32);

const BOTH: Pv1DecisionCapabilities = { canApprove: true, canReject: true };

/**
 * The panel reads only the two counts off the screening projection —
 * the findings themselves are the panel above's job. The cast keeps
 * this fixture honest about that: reading more will break here.
 */
function screeningWith(counts: {
  readonly hardStopCount: number;
  readonly outstandingCount: number;
}): OrderScreening {
  return counts as OrderScreening;
}

const CLEAN_SCREEN = screeningWith({ hardStopCount: 0, outstandingCount: 0 });

function render(props: {
  readonly screening: OrderScreening | null;
  readonly reviewedScreenDigest: string | null;
  readonly capabilities: Pv1DecisionCapabilities;
}): string {
  return renderToStaticMarkup(createElement(Pv1DecisionPanel, { orderId: ORDER_ID, ...props }));
}

describe("Pv1DecisionPanel", () => {
  it("renders nothing for an operator who can take neither action", () => {
    const html = render({
      screening: CLEAN_SCREEN,
      reviewedScreenDigest: DIGEST,
      capabilities: { canApprove: false, canReject: false },
    });
    expect(html).toBe("");
  });

  it("the approve form carries the digest and names the surface it posts from", () => {
    const html = render({
      screening: CLEAN_SCREEN,
      reviewedScreenDigest: DIGEST,
      capabilities: BOTH,
    });
    expect(html).toContain(`/api/ops/orders/${ORDER_ID}/approve-pv1`);
    expect(html).toContain(`name="reviewedScreenDigest" value="${DIGEST}"`);
    expect(html).toContain(`name="from" value="detail"`);
    expect(html).toContain("bound to the findings list shown above");
  });

  it("with no screen on record, the approve form carries no digest and says so", () => {
    const html = render({
      screening: null,
      reviewedScreenDigest: null,
      capabilities: BOTH,
    });
    expect(html).toContain(`/api/ops/orders/${ORDER_ID}/approve-pv1`);
    expect(html).not.toContain("reviewedScreenDigest");
    expect(html).toContain("no reviewed-list attestation");
  });

  it("the reject form posts the closed reason vocabulary from the detail surface", () => {
    const html = render({
      screening: CLEAN_SCREEN,
      reviewedScreenDigest: DIGEST,
      capabilities: BOTH,
    });
    expect(html).toContain(`/api/ops/orders/${ORDER_ID}/reject-pv1`);
    expect(html).toContain(`name="reasonCode"`);
    // A known member of PV1_REJECTION_REASONS — the select is built
    // from the real vocabulary, not a copy that can drift.
    expect(html).toContain("DOSE_INCORRECT");
  });

  it("permissions gate each form independently", () => {
    const approveOnly = render({
      screening: CLEAN_SCREEN,
      reviewedScreenDigest: DIGEST,
      capabilities: { canApprove: true, canReject: false },
    });
    expect(approveOnly).toContain("approve-pv1");
    expect(approveOnly).not.toContain("reject-pv1");

    const rejectOnly = render({
      screening: CLEAN_SCREEN,
      reviewedScreenDigest: DIGEST,
      capabilities: { canApprove: false, canReject: true },
    });
    expect(rejectOnly).toContain("reject-pv1");
    expect(rejectOnly).not.toContain("approve-pv1");
    // No approve form means no attestation copy either.
    expect(rejectOnly).not.toContain("reviewedScreenDigest");
  });

  it("a hard stop is announced as unapprovable, pointing at Reject", () => {
    const html = render({
      screening: screeningWith({ hardStopCount: 1, outstandingCount: 0 }),
      reviewedScreenDigest: DIGEST,
      capabilities: BOTH,
    });
    expect(html).toContain("will be refused");
    expect(html).toContain("hard stop");
    expect(html).toContain("Reject");
  });

  it("outstanding acknowledgements are announced with their count", () => {
    const html = render({
      screening: screeningWith({ hardStopCount: 0, outstandingCount: 2 }),
      reviewedScreenDigest: DIGEST,
      capabilities: BOTH,
    });
    expect(html).toContain("2 findings");
    expect(html).toContain("acknowledgement");
  });
});
