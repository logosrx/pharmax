import type { ErrorEvent } from "@sentry/node";
import { describe, expect, it } from "vitest";

import { scrubPrintAgentEvent } from "./sentry-init.js";

/**
 * The print-agent mirrors the worker's Sentry init, and shared the same
 * gap: free text was only truncated, never pattern-redacted. Label
 * content is patient-identifying by definition, so this process is not
 * a lesser case than the worker — an error carrying the text of a label
 * carries a name and an address by construction.
 *
 * See R-018 and `evidence/dr-drills/2026/incident-tabletop.md`.
 */
describe("scrubPrintAgentEvent", () => {
  it("redacts PHI from an exception message", () => {
    const event = {
      exception: {
        values: [{ type: "PrintError", value: "ZPL render failed for Jane Smith, 400 Oak Avenue" }],
      },
    } as unknown as ErrorEvent;

    const message = scrubPrintAgentEvent(event).exception?.values?.[0]?.value ?? "";
    expect(message).not.toContain("400 Oak Avenue");
    expect(message).toContain("[address]");
  });

  it("redacts event.message", () => {
    const event = { message: "label for 555-867-5309 rejected" } as ErrorEvent;
    expect(scrubPrintAgentEvent(event).message).toContain("[phone]");
  });

  it("redacts breadcrumb messages", () => {
    const event = {
      breadcrumbs: [{ message: "spooled label for patient born 1962-07-04" }],
    } as ErrorEvent;

    expect(scrubPrintAgentEvent(event).breadcrumbs?.[0]?.message).toContain("[date]");
  });

  it("drops non-allowlisted extra keys", () => {
    const event = {
      extra: { printJobId: "pj-1", patientName: "Jane Smith" },
    } as unknown as ErrorEvent;

    expect(scrubPrintAgentEvent(event).extra).toEqual({ printJobId: "pj-1" });
  });

  it("leaves an operational message untouched", () => {
    const clean = "printer offline: ECONNREFUSED";
    expect(scrubPrintAgentEvent({ message: clean } as ErrorEvent).message).toBe(clean);
  });
});
