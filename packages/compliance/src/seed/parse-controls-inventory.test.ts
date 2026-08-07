// Controls-inventory parser tests.
//
// Two layers. Synthetic fixtures pin the parsing rules and the
// failure modes; the last block parses the REAL
// docs/soc2/controls-inventory.md, which is what actually protects
// the seed. A parser that only ever sees its own fixtures will keep
// passing on the day someone adds a "Bi-annual" cadence to the
// document and the seeder starts dropping rows.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CONTROLS_INVENTORY_BAD_CONTROL_CODE,
  CONTROLS_INVENTORY_DUPLICATE_CODE,
  CONTROLS_INVENTORY_NO_CONTROLS,
  CONTROLS_INVENTORY_UNKNOWN_CADENCE,
  CONTROLS_INVENTORY_UNKNOWN_STATUS,
  extractImplementationRefs,
  parseControlsInventory,
  resolveCadence,
} from "./parse-controls-inventory.js";
import { MARKDOWN_TABLE_RAGGED_ROW, parseMarkdownTables } from "./parse-markdown-table.js";

function table(rows: readonly string[]): string {
  return [
    "## Common Criteria",
    "",
    "| Control ID | Description | Status | Owner | Review Cadence | Notes |",
    "| ---------- | ----------- | ------ | ----- | -------------- | ----- |",
    ...rows,
    "",
  ].join("\n");
}

describe("parseControlsInventory — shape", () => {
  it("derives the criterion code and category from the row and its heading", () => {
    const parsed = parseControlsInventory(
      table(["| CC6.1-2 | RBAC before mutation | Implemented | Security Officer | Quarterly | |"])
    );

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.code).toBe("CC6.1-2");
    expect(parsed[0]?.criterionCode).toBe("CC6.1");
    expect(parsed[0]?.category).toBe("Common Criteria");
    expect(parsed[0]?.status).toBe("IMPLEMENTED");
    expect(parsed[0]?.cadence).toBe("QUARTERLY");
    expect(parsed[0]?.notes).toBeNull();
  });

  it("reads the category out of an 'Additional Criteria' heading", () => {
    const md = [
      "## Additional Criteria — Processing Integrity",
      "",
      "| Control ID | Description | Status | Owner | Review Cadence | Notes |",
      "| --- | --- | --- | --- | --- | --- |",
      "| PI1.1-1 | Command bus contract | Implemented | Engineering Lead | Continuous | |",
      "",
    ].join("\n");

    expect(parseControlsInventory(md)[0]?.category).toBe("Processing Integrity");
  });

  it("strips markdown links from the description but keeps notes verbatim", () => {
    const parsed = parseControlsInventory(
      table([
        "| CC1.4-1 | [Workforce competence](../x.md) | Implemented | Workforce Lead | Annual | See [program](../y.md). |",
      ])
    );

    expect(parsed[0]?.title).toBe("Workforce competence");
    expect(parsed[0]?.notes).toBe("See [program](../y.md).");
  });
});

describe("resolveCadence — multi-valued cells", () => {
  it("prefers the tightest periodic cadence over an event-driven one", () => {
    // "the obligation with a deadline attached" wins.
    expect(resolveCadence("Per-event, quarterly").cadence).toBe("QUARTERLY");
    expect(resolveCadence("Continuous, daily").cadence).toBe("CONTINUOUS");
    expect(resolveCadence("Annual, on-change").cadence).toBe("ANNUAL");
  });

  it("falls back to the event-driven value when there is no periodic term", () => {
    expect(resolveCadence("On-change").cadence).toBe("ON_CHANGE");
    expect(resolveCadence("Per-event").cadence).toBe("PER_EVENT");
  });

  it("retains every term so the seeder can preserve the original text", () => {
    expect(resolveCadence("Per-event, quarterly").all).toEqual(["PER_EVENT", "QUARTERLY"]);
  });
});

describe("extractImplementationRefs", () => {
  it("picks up code spans, link targets, and ADR ids", () => {
    const refs = extractImplementationRefs(
      "ADR-0025 §3 — `requireMfaForRole`; see [policy](../policies/x.md)."
    );
    expect(refs).toContain("requireMfaForRole");
    expect(refs).toContain("../policies/x.md");
    expect(refs).toContain("ADR-0025");
  });

  it("does not invent references for a plain note", () => {
    expect(extractImplementationRefs("Pending formal board governance.")).toEqual([]);
  });
});

describe("parseControlsInventory — refuses to guess", () => {
  it("throws on an unknown status rather than dropping the control", () => {
    expect(() =>
      parseControlsInventory(table(["| CC1.1-1 | Something | Mostly Done | CEO | Annual | |"]))
    ).toThrow(CONTROLS_INVENTORY_UNKNOWN_STATUS);
  });

  it("throws on an unknown cadence", () => {
    expect(() =>
      parseControlsInventory(table(["| CC1.1-1 | Something | Implemented | CEO | Bi-annual | |"]))
    ).toThrow(CONTROLS_INVENTORY_UNKNOWN_CADENCE);
  });

  it("throws on a malformed control code", () => {
    expect(() =>
      parseControlsInventory(table(["| CC6.1 | Something | Implemented | CEO | Annual | |"]))
    ).toThrow(CONTROLS_INVENTORY_BAD_CONTROL_CODE);
  });

  it("throws on a duplicate control code", () => {
    expect(() =>
      parseControlsInventory(
        table([
          "| CC1.1-1 | A | Implemented | CEO | Annual | |",
          "| CC1.1-1 | B | Implemented | CEO | Annual | |",
        ])
      )
    ).toThrow(CONTROLS_INVENTORY_DUPLICATE_CODE);
  });

  it("throws rather than seeding an empty catalog", () => {
    expect(() => parseControlsInventory("# Nothing here\n")).toThrow(
      CONTROLS_INVENTORY_NO_CONTROLS
    );
  });

  it("throws on a ragged row instead of padding it", () => {
    const md = [
      "| Control ID | Description | Status |",
      "| --- | --- | --- |",
      "| CC1.1-1 | Something |",
      "",
    ].join("\n");
    expect(() => parseMarkdownTables(md)).toThrow(MARKDOWN_TABLE_RAGGED_ROW);
  });
});

describe("parseControlsInventory — the real document", () => {
  const inventoryPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../docs/soc2/controls-inventory.md"
  );
  const parsed = parseControlsInventory(readFileSync(inventoryPath, "utf8"));

  it("parses every control in docs/soc2/controls-inventory.md", () => {
    // The inventory is the auditor-facing catalog; if it grows, this
    // number moves in the same commit. A drop is the interesting case.
    expect(parsed.length).toBeGreaterThanOrEqual(60);
  });

  it("assigns every control a criterion, an owner, and a category", () => {
    for (const control of parsed) {
      expect(control.criterionCode.length).toBeGreaterThan(0);
      expect(control.ownerRole.length).toBeGreaterThan(0);
      expect(control.category.length).toBeGreaterThan(0);
      expect(control.title.length).toBeGreaterThan(0);
    }
  });

  it("covers all five criteria categories", () => {
    const categories = new Set(parsed.map((c) => c.category));
    expect(categories).toContain("Common Criteria");
    expect(categories).toContain("Availability");
    expect(categories).toContain("Processing Integrity");
    expect(categories).toContain("Confidentiality");
    expect(categories).toContain("Privacy");
  });

  it("resolves known landmark controls", () => {
    const rls = parsed.find((c) => c.code === "CC6.1-3");
    expect(rls?.status).toBe("IMPLEMENTED");
    expect(rls?.cadence).toBe("CONTINUOUS");
    expect(rls?.ownerRole).toBe("Engineering Lead");

    // A "Partial" control must not be seeded as implemented.
    const merkle = parsed.find((c) => c.code === "CC7.2-3");
    expect(merkle?.status).toBe("PARTIAL");
  });
});
