// scripts/check-alarm-actions.test.ts
//
// Covers each pure function exported from check-alarm-actions.ts.
// Inputs are inline synthetic HCL, so the suite pins the parser and
// the comparator against the shapes that actually caused the incident
// this guard exists to prevent — a literal empty action list, a
// missing attribute, and a severity comment that disagrees with the
// routing — without depending on the real Terraform tree. The one
// filesystem-touching helper (`listProdTfvarsFiles`) is exercised
// against a temporary directory.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  actionsLocalFor,
  checkAlarmModule,
  checkProdTfvars,
  checkRootWiring,
  declaredSeverityLocals,
  extractLabelledBlock,
  formatViolations,
  listProdTfvarsFiles,
  parseAlarms,
  parseSeverityComment,
  readAttribute,
} from "./check-alarm-actions.js";

const SEVERITY_LOCALS = `
locals {
  critical_alarm_actions = local.critical_topic_arn != "" ? [local.critical_topic_arn] : []
  warning_alarm_actions  = local.warning_topic_arn != "" ? [local.warning_topic_arn] : []
}
`;

/** A minimal well-formed alarm. Fields are overridable per test. */
function alarm(
  options: {
    readonly name?: string;
    readonly severityComment?: string | null;
    readonly alarmActions?: string | null;
    readonly okActions?: string | null;
  } = {}
): string {
  const name = options.name ?? "rds_cpu_high";
  const severityComment =
    options.severityComment === undefined
      ? "  # severity: warning — CPU pressure with no user-visible impact yet."
      : options.severityComment;
  const alarmActions =
    options.alarmActions === undefined ? "local.warning_alarm_actions" : options.alarmActions;
  const okActions =
    options.okActions === undefined ? "local.warning_alarm_actions" : options.okActions;
  return [
    `resource "aws_cloudwatch_metric_alarm" "${name}" {`,
    ...(severityComment === null ? [] : [severityComment]),
    `  alarm_name = "prefix-${name}"`,
    `  threshold  = 80`,
    ...(alarmActions === null ? [] : [`  alarm_actions = ${alarmActions}`]),
    ...(okActions === null ? [] : [`  ok_actions    = ${okActions}`]),
    `}`,
  ].join("\n");
}

function moduleHcl(...alarms: ReadonlyArray<string>): string {
  return [SEVERITY_LOCALS, ...alarms].join("\n\n");
}

function run(hcl: string) {
  return checkAlarmModule({ file: "modules/cloudwatch/main.tf", hcl });
}

describe("actionsLocalFor", () => {
  it("names the per-severity local", () => {
    expect(actionsLocalFor("critical")).toBe("local.critical_alarm_actions");
    expect(actionsLocalFor("warning")).toBe("local.warning_alarm_actions");
  });
});

describe("readAttribute", () => {
  it("reads a single-line assignment", () => {
    expect(readAttribute("  alarm_actions = local.critical_alarm_actions\n", "alarm_actions")).toBe(
      "local.critical_alarm_actions"
    );
  });

  it("strips a trailing comment", () => {
    expect(readAttribute("  enable_alerting = true # required in prod\n", "enable_alerting")).toBe(
      "true"
    );
  });

  it("returns null when the attribute is absent", () => {
    expect(readAttribute("  threshold = 80\n", "alarm_actions")).toBeNull();
  });

  it("does not read a commented-out assignment as a value", () => {
    expect(readAttribute("# enable_alerting = true\n", "enable_alerting")).toBeNull();
  });
});

describe("parseSeverityComment", () => {
  it("parses the em-dash form", () => {
    expect(parseSeverityComment("  # severity: critical — zero tasks is the outage.\n")).toEqual({
      severity: "critical",
      rationale: "zero tasks is the outage.",
    });
  });

  it("parses a plain-hyphen separator", () => {
    expect(parseSeverityComment("  # severity: warning - stale reports only.\n").severity).toBe(
      "warning"
    );
  });

  it("returns null severity when no annotation is present", () => {
    expect(parseSeverityComment('  alarm_name = "x"\n')).toEqual({
      severity: null,
      rationale: "",
    });
  });

  it("reports an empty rationale for a bare annotation", () => {
    expect(parseSeverityComment("  # severity: critical\n").rationale).toBe("");
  });
});

describe("declaredSeverityLocals", () => {
  it("finds both severity locals", () => {
    expect([...declaredSeverityLocals(SEVERITY_LOCALS)].sort()).toEqual(["critical", "warning"]);
  });

  it("finds neither in the pre-split single-topic form", () => {
    const legacy = `locals {\n  alarm_actions = var.alarm_sns_topic_arn != "" ? [var.alarm_sns_topic_arn] : []\n}`;
    expect([...declaredSeverityLocals(legacy)]).toEqual([]);
  });
});

describe("parseAlarms", () => {
  it("extracts every alarm with its severity and action bindings", () => {
    const parsed = parseAlarms(
      moduleHcl(
        alarm(),
        alarm({
          name: "alb_5xx_rate",
          severityComment: "  # severity: critical — users are getting errors right now.",
          alarmActions: "local.critical_alarm_actions",
          okActions: "local.critical_alarm_actions",
        })
      )
    );
    expect(parsed.map((a) => [a.name, a.declaredSeverity, a.alarmActions])).toEqual([
      ["rds_cpu_high", "warning", "local.warning_alarm_actions"],
      ["alb_5xx_rate", "critical", "local.critical_alarm_actions"],
    ]);
  });
});

describe("checkAlarmModule", () => {
  it("passes a well-formed module", () => {
    const result = run(
      moduleHcl(
        alarm(),
        alarm({
          name: "audit_chain_integrity_failure",
          severityComment: "  # severity: critical — the audit record is the evidence.",
          alarmActions: "local.critical_alarm_actions",
          okActions: "local.critical_alarm_actions",
        })
      )
    );
    expect(result.violations).toEqual([]);
    expect(result.alarms).toHaveLength(2);
  });

  it("rejects a literal empty action list — the original regression", () => {
    const result = run(moduleHcl(alarm({ alarmActions: "[]", okActions: "[]" })));
    expect(result.violations.map((v) => v.message).join("\n")).toContain("literal empty list");
  });

  it("rejects a missing alarm_actions attribute", () => {
    const result = run(moduleHcl(alarm({ alarmActions: null })));
    expect(result.violations.some((v) => v.message.includes("`alarm_actions` is not set"))).toBe(
      true
    );
  });

  it("rejects an unrecognised action expression", () => {
    const result = run(moduleHcl(alarm({ alarmActions: '["arn:aws:sns:us-east-1:1:topic"]' })));
    expect(
      result.violations.some((v) => v.message.includes("not one of the recognised severity"))
    ).toBe(true);
  });

  it("rejects an alarm with no severity annotation", () => {
    const result = run(moduleHcl(alarm({ severityComment: null })));
    expect(result.violations.some((v) => v.message.includes("missing a `# severity:"))).toBe(true);
  });

  it("rejects a severity annotation with no rationale", () => {
    const result = run(moduleHcl(alarm({ severityComment: "  # severity: warning" })));
    expect(result.violations.some((v) => v.message.includes("no rationale"))).toBe(true);
  });

  it("rejects routing that disagrees with the documented severity", () => {
    const result = run(
      moduleHcl(
        alarm({
          severityComment: "  # severity: warning — documented as a ticket, routed to the pager.",
          alarmActions: "local.critical_alarm_actions",
          okActions: "local.critical_alarm_actions",
        })
      )
    );
    expect(result.violations.some((v) => v.message.includes("disagrees with"))).toBe(true);
  });

  it("rejects an alarm whose recovery notification goes to the other tier", () => {
    const result = run(
      moduleHcl(
        alarm({
          severityComment: "  # severity: critical — availability loss, pages the on-call human.",
          alarmActions: "local.critical_alarm_actions",
          okActions: "local.warning_alarm_actions",
        })
      )
    );
    expect(result.violations.some((v) => v.message.includes("different tiers"))).toBe(true);
  });

  it("rejects a module that collapsed the severity split", () => {
    const collapsed = [
      `locals {\n  alarm_actions = var.alarm_sns_topic_arn != "" ? [var.alarm_sns_topic_arn] : []\n}`,
      alarm({ alarmActions: "local.alarm_actions", okActions: "local.alarm_actions" }),
    ].join("\n\n");
    const messages = run(collapsed).violations.map((v) => v.message);
    expect(messages.some((m) => m.includes("`critical_alarm_actions` local is missing"))).toBe(
      true
    );
    expect(messages.some((m) => m.includes("`warning_alarm_actions` local is missing"))).toBe(true);
  });

  it("reports a module with no alarms rather than passing vacuously", () => {
    const messages = run(SEVERITY_LOCALS).violations.map((v) => v.message);
    expect(messages.some((m) => m.includes("no `aws_cloudwatch_metric_alarm` resources"))).toBe(
      true
    );
  });
});

describe("extractLabelledBlock", () => {
  const root = `
module "alerting" {
  count = var.enable_alerting ? 1 : 0
}

module "cloudwatch" {
  name_prefix = local.name_prefix
  tags        = local.common_tags
}
`;

  it("extracts the requested module body", () => {
    expect(extractLabelledBlock(root, "module", "cloudwatch")).toContain("name_prefix");
  });

  it("does not bleed into the next block", () => {
    expect(extractLabelledBlock(root, "module", "alerting")).not.toContain("name_prefix");
  });

  it("returns null for an absent block", () => {
    expect(extractLabelledBlock(root, "module", "nope")).toBeNull();
  });
});

describe("checkRootWiring", () => {
  const wired = `
module "cloudwatch" {
  critical_alarm_sns_topic_arn = try(module.alerting[0].critical_topic_arn, "")
  warning_alarm_sns_topic_arn  = try(module.alerting[0].warning_topic_arn, "")
}
`;

  it("passes when both severities come from the alerting module", () => {
    expect(checkRootWiring({ file: "main.tf", hcl: wired })).toEqual([]);
  });

  it("fails when a severity argument is not passed at all", () => {
    const partial = `
module "cloudwatch" {
  critical_alarm_sns_topic_arn = try(module.alerting[0].critical_topic_arn, "")
}
`;
    const messages = checkRootWiring({ file: "main.tf", hcl: partial }).map((v) => v.message);
    expect(messages.some((m) => m.includes("`warning_alarm_sns_topic_arn` is not passed"))).toBe(
      true
    );
  });

  it("fails when a severity argument is hardcoded to an empty string", () => {
    const empty = `
module "cloudwatch" {
  critical_alarm_sns_topic_arn = ""
  warning_alarm_sns_topic_arn  = try(module.alerting[0].warning_topic_arn, "")
}
`;
    const messages = checkRootWiring({ file: "main.tf", hcl: empty }).map((v) => v.message);
    expect(messages.some((m) => m.includes("does not come from the alerting module"))).toBe(true);
  });

  it("fails when the cloudwatch module block is gone", () => {
    const messages = checkRootWiring({ file: "main.tf", hcl: "# nothing here" }).map(
      (v) => v.message
    );
    expect(messages.some((m) => m.includes('no `module "cloudwatch"` block'))).toBe(true);
  });
});

describe("checkProdTfvars", () => {
  it("passes when every production file enables alerting", () => {
    expect(
      checkProdTfvars([
        { file: "prod/us-east-1/terraform.tfvars", text: "enable_alerting = true\n" },
        { file: "prod/us-west-2/terraform.tfvars.example", text: "enable_alerting = true\n" },
      ])
    ).toEqual([]);
  });

  it("fails a production file that opts out", () => {
    const messages = checkProdTfvars([
      { file: "prod/us-east-1/terraform.tfvars", text: "enable_alerting = false\n" },
    ]).map((v) => v.message);
    expect(messages.some((m) => m.includes("production must be `true`"))).toBe(true);
  });

  it("fails a production file that never mentions alerting", () => {
    const messages = checkProdTfvars([
      { file: "prod/us-east-1/terraform.tfvars", text: 'region = "us-east-1"\n' },
    ]).map((v) => v.message);
    expect(messages.some((m) => m.includes("`enable_alerting` is not set"))).toBe(true);
  });

  it("fails when no production files were found at all", () => {
    const messages = checkProdTfvars([]).map((v) => v.message);
    expect(messages.some((m) => m.includes("no production tfvars files found"))).toBe(true);
  });
});

describe("listProdTfvarsFiles", () => {
  it("collects live and example tfvars from every region directory", () => {
    const root = mkdtempSync(join(tmpdir(), "pharmax-alerting-check-"));
    mkdirSync(join(root, "us-east-1"));
    mkdirSync(join(root, "us-west-2"));
    writeFileSync(join(root, "us-east-1", "terraform.tfvars"), "enable_alerting = true\n");
    writeFileSync(join(root, "us-east-1", "terraform.tfvars.example"), "enable_alerting = true\n");
    // us-west-2 is not deployed yet: example only, which is the shape the
    // real tree has today.
    writeFileSync(join(root, "us-west-2", "terraform.tfvars.example"), "enable_alerting = true\n");

    const found = listProdTfvarsFiles(root).map((p) => p.slice(root.length + 1));
    expect(found).toEqual([
      join("us-east-1", "terraform.tfvars"),
      join("us-east-1", "terraform.tfvars.example"),
      join("us-west-2", "terraform.tfvars.example"),
    ]);
  });

  it("returns nothing for a directory that does not exist", () => {
    expect(listProdTfvarsFiles(join(tmpdir(), "pharmax-does-not-exist-9f3a"))).toEqual([]);
  });
});

describe("formatViolations", () => {
  it("counts the violations and points at the runbook", () => {
    const report = formatViolations([{ where: "somewhere", message: "something" }]);
    expect(report).toContain("1 violation(s)");
    expect(report).toContain("docs/runbooks/alerting.md");
  });
});
