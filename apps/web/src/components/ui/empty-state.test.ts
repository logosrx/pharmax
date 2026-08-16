// What the EmptyState / ErrorState pair renders, and how the `action`
// prop is discriminated.
//
// The load-bearing logic here is `isEmptyStateAction`: a React element
// is ALSO a plain object, so a naive shape check would swallow bespoke
// ReactNode actions (forms, client buttons) and try to render them as
// links. These tests pin both branches, plus the operator-facing
// contract of ErrorState — the quotable mono error code and the retry
// link that re-runs a server component's load.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EmptyState, ErrorState, isEmptyStateAction } from "./empty-state.js";

describe("isEmptyStateAction", () => {
  it("accepts the structured { label, href } form", () => {
    expect(isEmptyStateAction({ label: "Receive inventory", href: "/ops/admin/batches" })).toBe(
      true
    );
  });

  it("rejects a React element even though it is an object", () => {
    expect(isEmptyStateAction(createElement("a", { href: "/x" }, "go"))).toBe(false);
  });

  it("rejects nullish values, strings, and near-miss shapes", () => {
    expect(isEmptyStateAction(null)).toBe(false);
    expect(isEmptyStateAction(undefined)).toBe(false);
    expect(isEmptyStateAction("Clear search")).toBe(false);
    expect(isEmptyStateAction({ label: "missing href" })).toBe(false);
    expect(isEmptyStateAction({ label: 1, href: "/x" })).toBe(false);
  });
});

describe("EmptyState", () => {
  it("renders a structured action as a link to its href", () => {
    const html = renderToStaticMarkup(
      createElement(EmptyState, {
        title: "No lots match this filter",
        action: { label: "Receive inventory", href: "/ops/admin/batches/receive" },
      })
    );
    expect(html).toContain('href="/ops/admin/batches/receive"');
    expect(html).toContain("Receive inventory");
  });

  it("passes a ReactNode action through untouched", () => {
    const html = renderToStaticMarkup(
      createElement(EmptyState, {
        title: "Nothing here",
        action: createElement("button", { type: "button" }, "Bespoke affordance"),
      })
    );
    expect(html).toContain("Bespoke affordance");
    // Not misread as a structured action: no link chrome around it.
    expect(html).not.toContain("<a ");
  });

  it("renders the secondary hint and omits it when absent", () => {
    const withHint = renderToStaticMarkup(
      createElement(EmptyState, { title: "Empty", hint: "Refreshes live." })
    );
    expect(withHint).toContain("Refreshes live.");

    const withoutHint = renderToStaticMarkup(createElement(EmptyState, { title: "Empty" }));
    expect(withoutHint).not.toContain("Refreshes live.");
  });
});

describe("ErrorState", () => {
  it("is announced as an alert and shows the quotable error code", () => {
    const html = renderToStaticMarkup(
      createElement(ErrorState, {
        title: "Rate quoting failed",
        detail: "CARRIER_TIMEOUT",
      })
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("CARRIER_TIMEOUT");
    expect(html).toContain("quote this to support");
  });

  it("renders the retry link back to the same route when given", () => {
    const html = renderToStaticMarkup(
      createElement(ErrorState, { retryHref: "/ops/shipping/abc/rates", retryLabel: "Re-quote" })
    );
    expect(html).toContain('href="/ops/shipping/abc/rates"');
    expect(html).toContain("Re-quote");
  });

  it("omits retry and detail affordances when not provided", () => {
    const html = renderToStaticMarkup(createElement(ErrorState, {}));
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("Error code");
  });
});
