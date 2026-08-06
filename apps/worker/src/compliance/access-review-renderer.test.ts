import type { AccessReviewReport } from "@pharmax/security";
import { describe, expect, it } from "vitest";

import type { AccessActivityAggregate } from "./access-activity-aggregator.js";
import type { AccessAnomaly } from "./access-review-anomaly-detector.js";
import {
  renderAccessReviewMarkdown,
  type BreakGlassSessionLite,
} from "./access-review-renderer.js";

const report: AccessReviewReport = {
  organizationId: "org_synthetic",
  organizationSlug: "acme-compounding",
  generatedAt: "2026-01-05T09:00:00.000Z",
  period: { start: "2025-10-01T00:00:00.000Z", end: "2025-12-31T23:59:59.999Z" },
  principals: [],
  summary: {
    totalPrincipals: 0,
    principalsWithElevatedRoles: [],
    inactivePrincipals: [],
    staleAssignments: [],
    cryptoShredCapableRoles: [],
  },
};

const aggregate: AccessActivityAggregate = {
  organizationId: "org_synthetic",
  periodStart: "2025-10-01T00:00:00.000Z",
  periodEnd: "2025-12-31T23:59:59.999Z",
  commandCounts: [],
  auditCounts: [],
  totals: { commandRows: 0, auditRows: 0, distinctOperators: 0 },
};

function render(overrides: {
  readonly anomalies?: ReadonlyArray<AccessAnomaly>;
  readonly breakGlassSessions?: ReadonlyArray<BreakGlassSessionLite>;
}): string {
  return renderAccessReviewMarkdown({
    report,
    aggregate,
    anomalies: overrides.anomalies ?? [],
    quarterLabel: "2025-Q4",
    evidenceJsonlUri: "s3://pharmax-evidence/access-reviews/2025-Q4/acme.jsonl",
    breakGlassSessions: overrides.breakGlassSessions ?? [],
  });
}

function rowContaining(markdown: string, needle: string): string {
  const row = markdown.split("\n").find((line) => line.includes(needle));
  if (row === undefined) {
    throw new Error(`no rendered row contains ${needle}`);
  }
  return row;
}

/**
 * Count the `|` characters a markdown reader would treat as column
 * separators. A pipe is live only when preceded by an even number of
 * backslashes — an odd count means the pipe itself is escaped.
 */
function liveSeparators(row: string): number {
  let live = 0;
  let backslashes = 0;
  for (const ch of row) {
    if (ch === "\\") {
      backslashes += 1;
      continue;
    }
    if (ch === "|" && backslashes % 2 === 0) {
      live += 1;
    }
    backslashes = 0;
  }
  return live;
}

const session: BreakGlassSessionLite = {
  id: "bg_1",
  requestedByUserId: "usr_requester",
  approvedByUserId: "usr_approver",
  openedAt: "2025-11-02T03:00:00.000Z",
  closedAt: "2025-11-02T04:10:00.000Z",
  ticketUrl: "https://tickets.test/OPS-1",
  resolution: "resolved",
};

describe("renderAccessReviewMarkdown", () => {
  it("keeps a backslash-then-pipe resolution inside a single table cell", () => {
    // The dangerous input: a backslash immediately before a pipe.
    // Escaping the pipe without first escaping the backslash yields
    // `\\|` — an escaped backslash followed by a LIVE separator, which
    // silently splits the row and shifts every later column.
    const markdown = render({
      breakGlassSessions: [{ ...session, resolution: "restored drive C:\\|see OPS-1" }],
    });

    const row = rowContaining(markdown, "bg_1");
    // 7 columns -> 8 separators. Anything more means the cell escaped.
    expect(liveSeparators(row)).toBe(8);
    expect(row).toContain("restored drive C:\\\\\\|see OPS-1");
  });

  it("escapes pipes and backslashes in an anomaly message", () => {
    const anomaly: AccessAnomaly = {
      kind: "high-failure-ratio",
      actorUserId: "usr_tech",
      label: "SubmitTyping",
      count: 42,
      message: "ratio 0.9 | path a\\b",
    };

    const row = rowContaining(render({ anomalies: [anomaly] }), "SubmitTyping");

    // 5 columns -> 6 separators.
    expect(liveSeparators(row)).toBe(6);
    expect(row).toContain("ratio 0.9 \\| path a\\\\b");
  });

  it("collapses newlines so a multi-line value cannot break the table", () => {
    const markdown = render({
      breakGlassSessions: [{ ...session, resolution: "line one\r\nline two\nline three" }],
    });

    const row = rowContaining(markdown, "bg_1");
    expect(row).toContain("line one line two line three");
    expect(liveSeparators(row)).toBe(8);
  });

  it("renders the zero-state sections when nothing is flagged", () => {
    const markdown = render({});

    expect(markdown).toContain("_None surfaced for this quarter. Proceed to per-row walk._");
    expect(markdown).toContain("Break-glass sessions in window: **0**");
    expect(markdown.endsWith("\n")).toBe(true);
  });
});
