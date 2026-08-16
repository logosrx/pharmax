#!/usr/bin/env tsx
// scripts/check-alarm-actions.ts
//
// Pre-merge guard. Asserts that a production CloudWatch alarm cannot
// be declared with an empty action list — i.e. that it cannot fire
// into the void.
//
// Why this guard exists:
//
//   This repository shipped 18 alarm definitions (16 alarm instances)
//   that evaluated correctly, transitioned to ALARM correctly, and
//   notified nobody, because `infra/terraform/environments/prod/
//   us-east-1/terraform.tfvars` set `alarm_sns_topic_arn = ""` and the
//   cloudwatch module turns an empty topic ARN into an empty
//   `alarm_actions` list. Nothing in CI noticed. Nothing in the AWS
//   console looks wrong either: the alarm is green, the metric is
//   there, the dashboard renders. The failure is invisible until a
//   pharmacist phones to say the system is down.
//
//   For a platform that dispenses medication, "the monitoring is
//   configured but disconnected" is a worse posture than no
//   monitoring, because it buys false confidence. So the wiring is an
//   invariant, not a convention.
//
// What it checks:
//
//   1. Severity locals exist. `modules/cloudwatch/main.tf` must
//      declare BOTH `critical_alarm_actions` and
//      `warning_alarm_actions` locals. Their absence means someone
//      collapsed the severity split back to one topic.
//
//   2. Every alarm routes to one of them. Each
//      `aws_cloudwatch_metric_alarm` must set `alarm_actions` (and
//      `ok_actions`) to `local.critical_alarm_actions` or
//      `local.warning_alarm_actions` — never a literal `[]`, never a
//      bare omission (which defaults to no actions), never some other
//      expression the guard cannot reason about.
//
//   3. Both action lists agree. An alarm that pages on entry and
//      emails on recovery leaves the pager holding an alarm nobody
//      knows is resolved.
//
//   4. Every alarm documents its tier. Each alarm body carries a
//      `# severity: <critical|warning> — <why>` comment, and the tier
//      in the comment matches the actions. The comment is the only
//      place the routing DECISION is recorded; a diff that moves an
//      alarm between tiers without touching the rationale is a diff
//      that silently changes who gets woken up at 03:00.
//
//   5. Production is wired to the module output. The root
//      composition's `module "cloudwatch"` block must pass
//      `critical_alarm_sns_topic_arn` and
//      `warning_alarm_sns_topic_arn`, and each must reference
//      `module.alerting` rather than a literal empty string.
//
//   6. Every production env-region enables alerting.
//      `enable_alerting = true` in each `terraform.tfvars` (and
//      `terraform.tfvars.example`, so a copied-forward new region
//      starts wired) under `environments/prod/`. Non-prod is
//      deliberately exempt: "empty means no action" is the intended
//      dev and staging posture.
//
// What it does NOT check (out of scope):
//
//   - Whether a topic has any confirmed subscribers. That is runtime
//     state in AWS, not text in the repo; the alerting module's
//     `check` blocks surface it at plan time and
//     `terraform output alerting_critical_subscription_count` answers
//     it after an apply.
//   - Whether the severity assignment is CORRECT. "Should replica lag
//     page?" is a judgement call for a human reviewer; the guard only
//     enforces that the judgement was made and written down.
//   - Alarms declared outside `modules/cloudwatch`. Today there are
//     none. If a future module grows its own alarms, add it to
//     ALARM_MODULE_FILES below in the same PR.
//
// Exit code:
//   0  Every alarm routes somewhere and prod is wired.
//   1  Violations found (printed to stderr, one actionable line each).
//   2  Internal error (a source file is missing or unparseable; treat
//      the PR as broken).
//
// Designed to run alongside the other pharmacy safety linters
// (`check:migrations`, `check:kms-inventory`,
// `check:terraform-apply-workflow`) in the `safety-linters` CI job and
// in `pnpm verify`. Reads local files only — no AWS credentials, no
// network.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { extractResourceBlocks, findMatchingCloseBrace } from "./check-kms-inventory.js";

// ---- types ---------------------------------------------------------

export type Severity = "critical" | "warning";

export const SEVERITIES: ReadonlyArray<Severity> = ["critical", "warning"];

/** The local each severity's action list must be bound to. */
export function actionsLocalFor(severity: Severity): string {
  return `local.${severity}_alarm_actions`;
}

export interface ParsedAlarm {
  readonly name: string;
  /** Severity declared in the `# severity:` comment, or null when absent. */
  readonly declaredSeverity: Severity | null;
  /** Prose after the severity word; used to reject a bare `# severity: warning`. */
  readonly rationale: string;
  /** Raw right-hand side of `alarm_actions`, or null when the attribute is absent. */
  readonly alarmActions: string | null;
  /** Raw right-hand side of `ok_actions`, or null when the attribute is absent. */
  readonly okActions: string | null;
}

export interface Violation {
  readonly where: string;
  readonly message: string;
}

// ---- HCL parsing ---------------------------------------------------

/**
 * Extract the body of a top-level `<blockType> "<label>" { ... }`
 * block (e.g. `module "cloudwatch"`). Returns null when absent.
 *
 * Brace pairing is delegated to the same walker the KMS inventory
 * check uses, so comment handling stays consistent between the two
 * guards.
 */
export function extractLabelledBlock(hcl: string, blockType: string, label: string): string | null {
  const headerRe = new RegExp(`^\\s*${blockType}\\s+"${label}"\\s*\\{`, "m");
  const header = headerRe.exec(hcl);
  if (!header || header.index === undefined) return null;
  const openBraceIdx = header.index + header[0].length - 1;
  const closeBraceIdx = findMatchingCloseBrace(hcl, openBraceIdx);
  if (closeBraceIdx === -1) return null;
  return hcl.slice(openBraceIdx + 1, closeBraceIdx);
}

/**
 * Read the right-hand side of a single-line `<attribute> = <value>`
 * assignment. Returns null when the attribute is absent. Trailing
 * comments are stripped; a multi-line value (a heredoc, a multi-line
 * list) yields only its first line, which is enough for the
 * `local.<x>_alarm_actions` / `[]` shapes this guard reasons about
 * and is reported as "unrecognised" otherwise.
 */
export function readAttribute(body: string, attribute: string): string | null {
  const re = new RegExp(`^\\s*${attribute}\\s*=\\s*(.+)$`, "m");
  const match = re.exec(body);
  if (!match || match[1] === undefined) return null;
  return match[1].replace(/\s+#.*$/, "").trim();
}

/**
 * Parse the `# severity: <tier> — <why>` annotation out of an alarm
 * body. Both the em-dash and a plain hyphen are accepted as the
 * separator so the check does not hinge on which one an editor
 * inserted.
 */
export function parseSeverityComment(body: string): {
  readonly severity: Severity | null;
  readonly rationale: string;
} {
  const match =
    /^[ \t]*#[ \t]*severity:[ \t]*(critical|warning)\b[ \t]*(?:—|-{1,2}|:)?[ \t]*(.*)$/m.exec(body);
  if (!match) return { severity: null, rationale: "" };
  return {
    severity: match[1] as Severity,
    rationale: (match[2] ?? "").trim(),
  };
}

export function parseAlarms(hcl: string): ReadonlyArray<ParsedAlarm> {
  return extractResourceBlocks(hcl, "aws_cloudwatch_metric_alarm").map((block) => {
    const { severity, rationale } = parseSeverityComment(block.body);
    return {
      name: block.name,
      declaredSeverity: severity,
      rationale,
      alarmActions: readAttribute(block.body, "alarm_actions"),
      okActions: readAttribute(block.body, "ok_actions"),
    };
  });
}

/** Which `<severity>_alarm_actions` locals the module declares. */
export function declaredSeverityLocals(hcl: string): ReadonlySet<Severity> {
  const found = new Set<Severity>();
  for (const severity of SEVERITIES) {
    if (new RegExp(`^\\s*${severity}_alarm_actions\\s*=`, "m").test(hcl)) found.add(severity);
  }
  return found;
}

// ---- checks --------------------------------------------------------

/** Minimum prose length that counts as a rationale rather than a rubber stamp. */
const MIN_RATIONALE_LENGTH = 20;

export function checkAlarmModule(input: { readonly file: string; readonly hcl: string }): {
  readonly violations: ReadonlyArray<Violation>;
  readonly alarms: ReadonlyArray<ParsedAlarm>;
} {
  const violations: Violation[] = [];
  const alarms = parseAlarms(input.hcl);

  const locals = declaredSeverityLocals(input.hcl);
  for (const severity of SEVERITIES) {
    if (!locals.has(severity)) {
      violations.push({
        where: input.file,
        message:
          `the \`${severity}_alarm_actions\` local is missing. Alarms must route to one of two ` +
          `severity tiers; a single shared action list means a warning wakes whoever a page wakes, ` +
          `and the pager stops being read.`,
      });
    }
  }

  if (alarms.length === 0) {
    violations.push({
      where: input.file,
      message:
        "no `aws_cloudwatch_metric_alarm` resources found. Either the alarms moved (add the new " +
        "file to ALARM_MODULE_FILES in scripts/check-alarm-actions.ts) or the parser broke.",
    });
  }

  for (const alarm of alarms) {
    const where = `${input.file} → aws_cloudwatch_metric_alarm.${alarm.name}`;

    if (alarm.declaredSeverity === null) {
      violations.push({
        where,
        message:
          "missing a `# severity: critical — <why>` / `# severity: warning — <why>` comment in the " +
          "resource body. Whoever is paged by this alarm at 03:00 deserves to know why someone " +
          "decided it was worth waking them.",
      });
    } else if (alarm.rationale.length < MIN_RATIONALE_LENGTH) {
      violations.push({
        where,
        message:
          `the \`# severity: ${alarm.declaredSeverity}\` comment has no rationale after it. State ` +
          `what a human could actually do about this alarm at 03:00 — that is the test for which ` +
          `tier it belongs in.`,
      });
    }

    for (const [attribute, value] of [
      ["alarm_actions", alarm.alarmActions],
      ["ok_actions", alarm.okActions],
    ] as const) {
      if (value === null) {
        violations.push({
          where,
          message:
            `\`${attribute}\` is not set, so the alarm changes state and notifies nobody. Set it to ` +
            `\`${actionsLocalFor("critical")}\` or \`${actionsLocalFor("warning")}\`.`,
        });
        continue;
      }
      if (/^\[\s*\]$/.test(value)) {
        violations.push({
          where,
          message:
            `\`${attribute}\` is a literal empty list. This is exactly the regression this guard ` +
            `exists to prevent: the alarm evaluates, transitions, and reaches no human.`,
        });
        continue;
      }
      const expected = alarm.declaredSeverity ? actionsLocalFor(alarm.declaredSeverity) : null;
      const recognised = SEVERITIES.map(actionsLocalFor);
      if (!recognised.includes(value)) {
        violations.push({
          where,
          message:
            `\`${attribute} = ${value}\` is not one of the recognised severity action lists ` +
            `(${recognised.join(", ")}). The guard cannot prove a hand-rolled expression reaches a ` +
            `human, so it refuses to.`,
        });
        continue;
      }
      if (expected !== null && value !== expected) {
        violations.push({
          where,
          message:
            `\`${attribute} = ${value}\` disagrees with the \`# severity: ${alarm.declaredSeverity}\` ` +
            `comment. Fix whichever one is wrong — a mismatch means the documented routing is not ` +
            `the real routing.`,
        });
      }
    }

    if (
      alarm.alarmActions !== null &&
      alarm.okActions !== null &&
      alarm.alarmActions !== alarm.okActions
    ) {
      violations.push({
        where,
        message:
          `\`alarm_actions\` (${alarm.alarmActions}) and \`ok_actions\` (${alarm.okActions}) route to ` +
          `different tiers. Recovery has to reach whoever got the alarm, or the pager is left holding ` +
          `an incident nobody told it was over.`,
      });
    }
  }

  return { violations, alarms };
}

export function checkRootWiring(input: {
  readonly file: string;
  readonly hcl: string;
}): ReadonlyArray<Violation> {
  const violations: Violation[] = [];
  const body = extractLabelledBlock(input.hcl, "module", "cloudwatch");
  if (body === null) {
    return [
      {
        where: input.file,
        message:
          'no `module "cloudwatch"` block found. If the composition moved, point this guard at the ' +
          "new root file in the same PR.",
      },
    ];
  }

  for (const severity of SEVERITIES) {
    const attribute = `${severity}_alarm_sns_topic_arn`;
    const value = readAttribute(body, attribute);
    if (value === null) {
      violations.push({
        where: `${input.file} → module "cloudwatch"`,
        message:
          `\`${attribute}\` is not passed, so the module falls back to its empty-string default and ` +
          `every ${severity}-tier alarm notifies nobody.`,
      });
      continue;
    }
    if (!value.includes("module.alerting")) {
      violations.push({
        where: `${input.file} → module "cloudwatch"`,
        message:
          `\`${attribute} = ${value}\` does not come from the alerting module. Wire it to ` +
          `\`module.alerting[0].${severity}_topic_arn\` — a hardcoded ARN drifts from the topic ` +
          `Terraform owns, and an empty string is the original bug.`,
      });
    }
  }

  return violations;
}

export function checkProdTfvars(
  files: ReadonlyArray<{ readonly file: string; readonly text: string }>
): ReadonlyArray<Violation> {
  const violations: Violation[] = [];
  if (files.length === 0) {
    return [
      {
        where: "infra/terraform/environments/prod",
        message:
          "no production tfvars files found. Either the environment layout moved or the glob broke; " +
          "either way the prod-wiring half of this guard is not running.",
      },
    ];
  }
  for (const { file, text } of files) {
    const value = readAttribute(text, "enable_alerting");
    if (value === null) {
      violations.push({
        where: file,
        message:
          "`enable_alerting` is not set. A production stack that does not provision alerting topics " +
          "has alarms that evaluate and notify nobody.",
      });
      continue;
    }
    if (value !== "true") {
      violations.push({
        where: file,
        message:
          `\`enable_alerting = ${value}\` — production must be \`true\`. Non-prod may opt out; ` +
          `production may not.`,
      });
    }
  }
  return violations;
}

export function formatViolations(violations: ReadonlyArray<Violation>): string {
  const lines: string[] = [
    `[check-alarm-actions] ${violations.length} violation(s) — a production alarm could reach nobody:`,
    "",
  ];
  for (const v of violations) {
    lines.push(`  ✗ ${v.where}`, `    ${v.message}`);
  }
  lines.push(
    "",
    "Background: scripts/check-alarm-actions.ts header explains each invariant.",
    "Operator view: docs/runbooks/alerting.md.",
    "Terraform: infra/terraform/modules/alerting + infra/terraform/modules/cloudwatch."
  );
  return lines.join("\n");
}

// ---- CLI entry point -----------------------------------------------

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ALARM_MODULE_FILES = [
  join("infra", "terraform", "modules", "cloudwatch", "main.tf"),
  join("infra", "terraform", "modules", "synthetics", "main.tf"),
];
const ROOT_COMPOSITION_FILE = join("infra", "terraform", "main.tf");
const PROD_ENVIRONMENTS_DIR = join("infra", "terraform", "environments", "prod");
const PROD_TFVARS_FILENAMES = ["terraform.tfvars", "terraform.tfvars.example"];

/**
 * Collect the production tfvars files to check: both the live
 * `terraform.tfvars` and the `.example` template, in every
 * `environments/prod/<region>/` directory. The example matters
 * because a new region is provisioned by copying it (see
 * `infra/terraform/README.md`), and a template that ships alerting
 * disabled recreates the bug in the next region.
 */
export function listProdTfvarsFiles(prodDir: string): ReadonlyArray<string> {
  const out: string[] = [];
  let regions: string[];
  try {
    regions = readdirSync(prodDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return out;
  }
  for (const region of regions) {
    for (const filename of PROD_TFVARS_FILENAMES) {
      const candidate = join(prodDir, region, filename);
      try {
        if (statSync(candidate).isFile()) out.push(candidate);
      } catch {
        // Absent is fine: us-west-2 ships only the example until it is deployed.
      }
    }
  }
  return out;
}

export function runFromFilesystem(root: string): number {
  const violations: Violation[] = [];
  let alarmCount = 0;
  const bySeverity = new Map<Severity, number>([
    ["critical", 0],
    ["warning", 0],
  ]);

  try {
    for (const relativePath of ALARM_MODULE_FILES) {
      const hcl = readFileSync(resolve(root, relativePath), "utf8");
      const result = checkAlarmModule({ file: relativePath, hcl });
      violations.push(...result.violations);
      alarmCount += result.alarms.length;
      for (const alarm of result.alarms) {
        if (alarm.declaredSeverity === null) continue;
        bySeverity.set(alarm.declaredSeverity, (bySeverity.get(alarm.declaredSeverity) ?? 0) + 1);
      }
    }

    const rootHcl = readFileSync(resolve(root, ROOT_COMPOSITION_FILE), "utf8");
    violations.push(...checkRootWiring({ file: ROOT_COMPOSITION_FILE, hcl: rootHcl }));

    const prodFiles = listProdTfvarsFiles(resolve(root, PROD_ENVIRONMENTS_DIR)).map((absolute) => ({
      file: relative(root, absolute),
      text: readFileSync(absolute, "utf8"),
    }));
    violations.push(...checkProdTfvars(prodFiles));

    if (violations.length > 0) {
      process.stderr.write(`${formatViolations(violations)}\n`);
      return 1;
    }

    process.stdout.write(
      `[check-alarm-actions] ok — ${alarmCount} alarm(s) checked ` +
        `(${bySeverity.get("critical")} critical, ${bySeverity.get("warning")} warning), ` +
        `${prodFiles.length} production tfvars file(s) wired\n`
    );
    return 0;
  } catch (err) {
    process.stderr.write(
      `[check-alarm-actions] FATAL: ${describeError(err)}\n` +
        "This check expects the layout:\n" +
        `  ${ALARM_MODULE_FILES.join("\n  ")}\n` +
        `  ${ROOT_COMPOSITION_FILE}\n` +
        `  ${PROD_ENVIRONMENTS_DIR}/<region>/terraform.tfvars\n`
    );
    return 2;
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

// Run only when invoked directly — not when imported by tests.
const invokedDirectly =
  typeof process.argv[1] === "string" &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exit(runFromFilesystem(ROOT));
}
