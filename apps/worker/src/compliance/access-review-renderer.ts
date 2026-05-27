// Markdown renderer for the quarterly access-review report.
//
// Input: an `AccessReviewReport` (from @pharmax/security), the
// quarter's activity aggregate, the detected anomalies, and the
// evidence URIs for the JSONL artifacts. Output: a human-readable
// markdown report the auditor opens FIRST.
//
// PHI invariant: the renderer is a pure transform over PHI-free
// inputs. No format-string surprises (no nested template literal
// that interpolates `payload`), no fall-through that could leak
// raw rows.

import {
  INACTIVE_USER_THRESHOLD_DAYS,
  STALE_ASSIGNMENT_THRESHOLD_DAYS,
  type AccessReviewReport,
} from "@pharmax/security";

import type { AccessActivityAggregate } from "./access-activity-aggregator.js";
import type { AccessAnomaly } from "./access-review-anomaly-detector.js";

export interface AccessReviewMarkdownInput {
  readonly report: AccessReviewReport;
  readonly aggregate: AccessActivityAggregate;
  readonly anomalies: ReadonlyArray<AccessAnomaly>;
  readonly quarterLabel: string;
  readonly evidenceJsonlUri: string;
  readonly breakGlassSessions: ReadonlyArray<BreakGlassSessionLite>;
}

/**
 * Minimal projection of a `break_glass_session` row — only the
 * non-PHI metadata fields. Empty list is the default until the
 * schema lands (per `packages/security/src/break-glass/SCHEMA.md`).
 */
export interface BreakGlassSessionLite {
  readonly id: string;
  readonly requestedByUserId: string;
  readonly approvedByUserId: string | null;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly ticketUrl: string;
  readonly resolution: string | null;
}

export function renderAccessReviewMarkdown(input: AccessReviewMarkdownInput): string {
  const { report, aggregate, anomalies, quarterLabel, evidenceJsonlUri, breakGlassSessions } =
    input;
  const lines: string[] = [];

  lines.push(`# Quarterly Access Review — ${report.organizationSlug} — ${quarterLabel}`);
  lines.push("");
  lines.push(`| Field | Value |`);
  lines.push(`| ----- | ----- |`);
  lines.push(`| Organization | ${report.organizationSlug} (\`${report.organizationId}\`) |`);
  lines.push(`| Quarter | ${quarterLabel} |`);
  lines.push(`| Period | ${report.period.start} → ${report.period.end} |`);
  lines.push(`| Generated at | ${report.generatedAt} |`);
  lines.push(`| Evidence JSONL | ${evidenceJsonlUri} |`);
  lines.push("");

  lines.push(`## Executive summary`);
  lines.push("");
  lines.push(`- Total operators with assignments: **${String(report.summary.totalPrincipals)}**`);
  lines.push(
    `- Operators with elevated roles: **${String(report.summary.principalsWithElevatedRoles.length)}**`
  );
  lines.push(
    `- Inactive operators (no login in ${String(INACTIVE_USER_THRESHOLD_DAYS)} days): **${String(report.summary.inactivePrincipals.length)}**`
  );
  lines.push(
    `- Stale role assignments (> ${String(STALE_ASSIGNMENT_THRESHOLD_DAYS)} days): **${String(report.summary.staleAssignments.length)}**`
  );
  lines.push(
    `- Distinct operators with activity this quarter: **${String(aggregate.totals.distinctOperators)}**`
  );
  lines.push(`- Command-log rows: **${String(aggregate.totals.commandRows)}**`);
  lines.push(`- Audit-log rows: **${String(aggregate.totals.auditRows)}**`);
  lines.push(`- Break-glass sessions in window: **${String(breakGlassSessions.length)}**`);
  lines.push(`- Anomalies surfaced: **${String(anomalies.length)}**`);
  lines.push("");

  lines.push(`## Anomalies (reviewer follow-up required)`);
  lines.push("");
  if (anomalies.length === 0) {
    lines.push(`_None surfaced for this quarter. Proceed to per-row walk._`);
  } else {
    lines.push(`| Kind | Actor | Label | Count | Message |`);
    lines.push(`| ---- | ----- | ----- | ----- | ------- |`);
    for (const a of anomalies) {
      lines.push(
        `| ${a.kind} | ${a.actorUserId ?? "<system>"} | ${a.label} | ${String(a.count)} | ${escapeTableCell(a.message)} |`
      );
    }
  }
  lines.push("");

  lines.push(`## Break-glass sessions`);
  lines.push("");
  if (breakGlassSessions.length === 0) {
    lines.push(
      `_No break-glass sessions opened in this period. (Once the \`break_glass_session\` migration lands, sessions will be enumerated here; until then the section reports zero.)_`
    );
  } else {
    lines.push(`| Session id | Requester | Approver | Opened | Closed | Ticket | Resolution |`);
    lines.push(`| ---------- | --------- | -------- | ------ | ------ | ------ | ---------- |`);
    for (const s of breakGlassSessions) {
      lines.push(
        `| ${s.id} | ${s.requestedByUserId} | ${s.approvedByUserId ?? "—"} | ${s.openedAt} | ${s.closedAt ?? "<open>"} | ${escapeTableCell(s.ticketUrl)} | ${escapeTableCell(s.resolution ?? "")} |`
      );
    }
  }
  lines.push("");

  lines.push(`## Operators with elevated roles`);
  lines.push("");
  if (report.summary.principalsWithElevatedRoles.length === 0) {
    lines.push(`_No elevated role-holders found. Verify roles seeded correctly._`);
  } else {
    lines.push(`| User id | Email | Display name | Status |`);
    lines.push(`| ------- | ----- | ------------ | ------ |`);
    for (const userId of report.summary.principalsWithElevatedRoles) {
      const principal = report.principals.find((p) => p.userId === userId);
      if (principal === undefined) continue;
      lines.push(
        `| ${principal.userId} | ${principal.email} | ${principal.displayName} | ${principal.status} |`
      );
    }
  }
  lines.push("");

  lines.push(`## Inactive operators`);
  lines.push("");
  if (report.summary.inactivePrincipals.length === 0) {
    lines.push(`_No inactive operators flagged._`);
  } else {
    lines.push(`| User id | Email | Last login |`);
    lines.push(`| ------- | ----- | ---------- |`);
    for (const userId of report.summary.inactivePrincipals) {
      const principal = report.principals.find((p) => p.userId === userId);
      if (principal === undefined) continue;
      lines.push(
        `| ${principal.userId} | ${principal.email} | ${principal.lastLoginAt ?? "never"} |`
      );
    }
  }
  lines.push("");

  lines.push(`## Stale role assignments`);
  lines.push("");
  if (report.summary.staleAssignments.length === 0) {
    lines.push(`_No stale assignments flagged._`);
  } else {
    lines.push(`| Assignment id | User id | Role | Age (days) | Scope |`);
    lines.push(`| ------------- | ------- | ---- | ---------- | ----- |`);
    for (const stale of report.summary.staleAssignments) {
      const principal = report.principals.find((p) => p.userId === stale.userId);
      const assignment = principal?.assignments.find((a) => a.userRoleId === stale.userRoleId);
      if (assignment === undefined) continue;
      lines.push(
        `| ${assignment.userRoleId} | ${stale.userId} | ${assignment.roleCode} | ${String(assignment.ageDays)} | ${assignment.scope} |`
      );
    }
  }
  lines.push("");

  lines.push(`## Reviewer checklist`);
  lines.push("");
  lines.push(
    `Per [\`docs/governance/access-review-procedure.md\`](../../governance/access-review-procedure.md):`
  );
  lines.push("");
  lines.push(`- [ ] Walked the elevated-role operators above; each is appropriate.`);
  lines.push(`- [ ] Walked the inactive operators above; each has a documented disposition.`);
  lines.push(`- [ ] Walked the stale assignments above; each is re-justified or removed.`);
  lines.push(
    `- [ ] Walked each anomaly above; each is closed (no concern / corrective ticket filed).`
  );
  lines.push(`- [ ] Walked break-glass sessions above; every session has a closed ticket.`);
  lines.push(`- [ ] Cross-checked BAA tracker (per access-review-procedure §5.3.4).`);
  lines.push(`- [ ] Cross-checked SoD principals (per access-review-procedure §5.3.5).`);
  lines.push(`- [ ] Cross-checked system identities have no \`clerkUserId\` (per §5.3.6).`);
  lines.push(
    `- [ ] Filed corrective tickets for every \`Remove\` / \`Reduce\` / \`Investigate\` decision.`
  );
  lines.push(
    `- [ ] Sign-off committed under \`evidence/access-reviews/${quarterLabel}/${report.organizationSlug}-signoff.md\`.`
  );
  lines.push("");

  lines.push(`## Cross-references`);
  lines.push("");
  lines.push(`- [Access Control Policy](../../policies/access-control-policy.md) §7`);
  lines.push(`- [Access Review Procedure](../../governance/access-review-procedure.md)`);
  lines.push(
    `- [Control Matrix](../../security/control-matrix.md) CC6.2 / CC6.3 / § 164.308(a)(4)`
  );
  lines.push("");

  return lines.join("\n") + "\n";
}

function escapeTableCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
