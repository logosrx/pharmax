// Render a `SECURITY_DIGEST_DAILY_V1` notification context into the
// subject + plain-text + HTML payload the email channel needs.
//
// Renderer kept SEPARATE from the channel adapter for the same
// three reasons as `render-report-completed-email.ts`:
//   - The HTML/text strings have their own focused unit tests
//     without needing a fake Resend SDK in scope.
//   - A future template-versioned bump (SECURITY_DIGEST_DAILY_V2)
//     can ship a sibling renderer without touching the adapter.
//   - A future Slack/Teams adapter can render the SAME context
//     into a markdown block by writing a sibling renderer.
//
// PHI invariant: the renderer receives a `context` already
// PHI-guarded by `assertNoPhiInContext` at the channel boundary.
// The digest itself is non-PHI by construction (the composer in
// @pharmax/security only surfaces counts + ids + status enums), and
// `digestText` is therefore safe to embed verbatim. The renderer
// HTML-escapes everything anyway because the body lives inside a
// `<pre>` tag and a stray `<` in (say) a future probe's reason
// string must not break the markup.

/**
 * Stable subject prefix so a corporate inbox filter or Datadog
 * email-trigger rule keys off the bracket prefix without matching
 * the date. Capitalisation matches the existing operator-facing
 * `[Pharmax]` prefix on report completion emails.
 */
const SUBJECT_PREFIX = "[Pharmax security]";

export interface SecurityDigestRenderInput {
  /** ISO timestamp the digest was composed. Drives the subject date. */
  readonly generatedAtIso: string;
  /** Window start ISO timestamp the digest covers. */
  readonly windowFromIso: string;
  /** Window end ISO timestamp the digest covers. */
  readonly windowToIso: string;
  /**
   * Pre-rendered plaintext body — exactly what
   * `renderDigestAsText(digest)` produces upstream of the
   * publisher. Embedded verbatim in the email text part and inside
   * a `<pre>` block in the HTML part.
   */
  readonly digestText: string;
  /** Number of organizations the audit-chain probe verified. */
  readonly auditOrgCount: number;
  /** Number of orgs whose chain came back broken. Drives the subject status badge. */
  readonly brokenChainCount: number;
  /** Break-glass sessions opened in the digest's window. */
  readonly breakGlassCount: number;
  /** Outbox orgs with DEAD rows added in the window. */
  readonly outboxDeadCount: number;
}

export interface RenderedSecurityDigestEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/**
 * Subject line shape — three rules:
 *
 *   1. The bracket prefix is always present so inbox rules key off it.
 *   2. The clean / attention badge fires off the SUM of the three
 *      operator-actionable signals (broken chains, break-glass
 *      sessions, outbox DEAD rows). A non-zero count anywhere
 *      yields ATTENTION; zeros across the board yields CLEAN.
 *   3. The date suffix is the calendar date of `generatedAtIso`
 *      in UTC so the subject sorts naturally in the inbox.
 *
 * The four scalar counts are ALSO embedded so the on-call can
 * triage from the preview pane without opening the body.
 */
export function renderSecurityDigestEmail(
  input: SecurityDigestRenderInput
): RenderedSecurityDigestEmail {
  const dateLabel = toUtcDateLabel(input.generatedAtIso);
  const attentionSignal =
    input.brokenChainCount + input.breakGlassCount + input.outboxDeadCount > 0;
  const statusBadge = attentionSignal ? "ATTENTION" : "CLEAN";
  const subject = `${SUBJECT_PREFIX} ${statusBadge} · ${dateLabel} · ${input.auditOrgCount} orgs, ${input.brokenChainCount} broken chains, ${input.breakGlassCount} break-glass, ${input.outboxDeadCount} dead-outbox orgs`;

  const text = input.digestText.endsWith("\n") ? input.digestText : `${input.digestText}\n`;

  const html = renderHtml({ ...input, dateLabel, statusBadge, attentionSignal });

  return Object.freeze({ subject, text, html });
}

interface RenderHtmlInput extends SecurityDigestRenderInput {
  readonly dateLabel: string;
  readonly statusBadge: "CLEAN" | "ATTENTION";
  readonly attentionSignal: boolean;
}

function renderHtml(input: RenderHtmlInput): string {
  const badgeColor = input.attentionSignal
    ? { bg: "#fef2f2", fg: "#991b1b", border: "#fecaca" }
    : { bg: "#ecfdf5", fg: "#065f46", border: "#a7f3d0" };

  const scalarsHtml = `<dl style="margin:8px 0 0;padding:0">${[
    ["Audit orgs verified", input.auditOrgCount],
    ["Broken chains", input.brokenChainCount],
    ["Break-glass sessions opened", input.breakGlassCount],
    ["Orgs with dead outbox rows", input.outboxDeadCount],
  ]
    .map(
      ([label, value]) =>
        `<div style="display:flex;gap:12px;margin:2px 0"><dt style="min-width:240px;color:#525252">${escapeHtml(String(label))}</dt><dd style="margin:0;font-variant-numeric:tabular-nums">${escapeHtml(String(value))}</dd></div>`
    )
    .join("")}</dl>`;

  return `<!DOCTYPE html>
<html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;background:#fafafa;padding:24px;color:#0a0a0a">
  <div style="max-width:720px;margin:0 auto;background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:24px">
    <div style="display:inline-block;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:600;background:${badgeColor.bg};color:${badgeColor.fg};border:1px solid ${badgeColor.border}">${escapeHtml(input.statusBadge)}</div>
    <h1 style="margin:12px 0 4px;font-size:20px">Pharmax Nightly Security Digest</h1>
    <p style="margin:0;color:#525252;font-size:14px">${escapeHtml(input.dateLabel)} · Window <code style="font-size:12px">${escapeHtml(input.windowFromIso)} → ${escapeHtml(input.windowToIso)}</code></p>
    <hr style="border:none;border-top:1px solid #e5e5e5;margin:16px 0" />
    ${scalarsHtml}
    <hr style="border:none;border-top:1px solid #e5e5e5;margin:16px 0" />
    <pre style="margin:0;padding:12px;background:#fafafa;border:1px solid #e5e5e5;border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word">${escapeHtml(input.digestText)}</pre>
    <p style="margin:24px 0 0;color:#737373;font-size:12px">SOC 2 evidence — generated by apps/worker nightly-security-digest-loop. This message is operator-facing and does not contain PHI.</p>
  </div>
</body></html>`;
}

function toUtcDateLabel(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return iso;
  }
  // YYYY-MM-DD in UTC so multi-region operators see the same date.
  return parsed.toISOString().slice(0, 10);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
