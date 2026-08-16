// What Field wires up for assistive tech — the label/control/help
// associations added in the WCAG 2.1 AA pass.
//
// The quiet failure this guards: a <label> rendered NEXT to an input
// with no `for`/`id` pair looks identical on screen and is silent in a
// screen reader. These assertions pin the invariants: a single
// control child gets an id + label[for], help text is referenced via
// aria-describedby, required is exposed, and composite children
// (checkbox groups with their own inner labels) become a labelled
// group instead of an invalid nested label.
//
// CLEAN ROOM / PHI: synthetic field names only.

import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Field, Input, Select } from "./field.js";

function attr(html: string, name: string): string | null {
  const m = new RegExp(`${name}="([^"]*)"`).exec(html);
  return m?.[1] ?? null;
}

function renderField(
  props: {
    readonly label?: ReactNode;
    readonly required?: boolean;
    readonly help?: ReactNode;
    readonly htmlFor?: string;
  },
  children: ReactNode
): string {
  return renderToStaticMarkup(createElement(Field, { ...props, children }));
}

describe("Field", () => {
  it("associates the label with a single Input child via for/id", () => {
    const html = renderField({ label: "Lot number" }, createElement(Input, { name: "lot" }));
    const forId = attr(html, "for");
    expect(forId).not.toBeNull();
    expect(html).toContain(`id="${forId}"`);
    expect(html).toContain("<label");
    expect(html).toContain("Lot number");
  });

  it("keeps an explicit htmlFor/id pair untouched", () => {
    const html = renderField(
      { label: "Refills", htmlFor: "refills" },
      createElement(Input, { id: "refills", name: "refills" })
    );
    expect(html).toContain('for="refills"');
    expect(html).toContain('id="refills"');
  });

  it("links help text to the control via aria-describedby", () => {
    const html = renderField(
      { label: "NDC", help: "10 or 11 digits." },
      createElement(Input, { name: "ndc" })
    );
    const describedBy = attr(html, "aria-describedby");
    expect(describedBy).not.toBeNull();
    expect(html).toContain(`id="${describedBy}"`);
    expect(html).toContain("10 or 11 digits.");
  });

  it("does not clobber a call site's own aria-describedby", () => {
    const html = renderField(
      { label: "Refills", help: "Schedule cap applies." },
      createElement(Input, { name: "refills", "aria-describedby": "refills-federal-cap" })
    );
    expect(html).toContain('aria-describedby="refills-federal-cap"');
  });

  it("exposes Field-level required as aria-required and hides the asterisk", () => {
    const html = renderField(
      { label: "Reason", required: true },
      createElement(Select, {}, createElement("option", { value: "OTHER" }, "OTHER"))
    );
    expect(html).toContain('aria-required="true"');
    expect(html).toMatch(/<span aria-hidden="true"[^>]*>\s*\*<\/span>/);
  });

  it("leaves native required alone (no duplicate aria-required)", () => {
    const html = renderField(
      { label: "Quantity", required: true },
      createElement(Input, { name: "qty", required: true })
    );
    expect(html).toContain("required=");
    expect(html).not.toContain("aria-required");
  });

  it("exposes a composite child as a labelled group, not a nested label", () => {
    const html = renderField(
      { label: "Scopes" },
      createElement(
        "div",
        null,
        createElement("label", null, createElement("input", { type: "checkbox" }), "orders.read")
      )
    );
    expect(html).toContain('role="group"');
    const labelledBy = attr(html, "aria-labelledby");
    expect(labelledBy).not.toBeNull();
    expect(html).toContain(`id="${labelledBy}"`);
    // The caption must not render as a <label> — a label wrapping or
    // pointing at a composite is what this path exists to avoid.
    expect(html).not.toContain(`for="${labelledBy}"`);
  });
});
