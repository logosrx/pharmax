// What the withheld-results banner says, and when it says nothing.
//
// The property that matters most is a NEGATIVE one: the banner must
// not name, count-by-identity, or otherwise describe the withheld
// patients — they are exactly the rows with no audit trail, so any
// identifying detail here would be the disclosure the suppression
// exists to prevent. The tests therefore assert on counts, the
// operator id, and the hidden/withheld wording only.
//
// CLEAN ROOM / PHI: synthetic ids only.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { UnauditedResultsBanner } from "./unaudited-results-banner.js";

const OPERATOR = "00000000-0000-4000-8000-0000000000op";

function render(props: { readonly suppressedCount: number; readonly attempted: number }): string {
  return renderToStaticMarkup(
    createElement(UnauditedResultsBanner, { ...props, operatorUserId: OPERATOR })
  );
}

describe("UnauditedResultsBanner", () => {
  it("renders nothing when no rows were suppressed", () => {
    expect(render({ suppressedCount: 0, attempted: 12 })).toBe("");
  });

  it("names the suppressed and attempted counts, and the operator id", () => {
    const html = render({ suppressedCount: 3, attempted: 12 });
    expect(html).toContain("3 of 12 results hidden");
    expect(html).toContain(OPERATOR);
  });

  it("says the rows were hidden, not shown-without-a-record", () => {
    const html = render({ suppressedCount: 3, attempted: 12 });
    expect(html).toContain("view audit could not be recorded");
    expect(html).toContain("Nothing about those patients was rendered.");
    // The pre-#79 banner's apology must not come back.
    expect(html).not.toContain("rendered the data anyway");
  });

  it("uses singular phrasing for a single suppressed row", () => {
    const html = render({ suppressedCount: 1, attempted: 5 });
    expect(html).toContain("1 of 5 results hidden");
    expect(html).toContain("failed for one result");
    expect(html).toContain("Nothing about that patient was rendered.");
  });
});
