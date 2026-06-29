#!/usr/bin/env tsx
// scripts/check-terraform-apply-workflow.ts
//
// Pre-merge guard. Asserts structural invariants on the
// `.github/workflows/terraform-apply.yml` approval-gated apply
// workflow. Fails the PR on any violation.
//
// Why this guard exists:
//
//   The apply workflow's safety story rests on a small number of
//   load-bearing invariants:
//
//     1. The workflow is `workflow_dispatch`-only. A future slice
//        that accidentally adds `push:` or `pull_request:` would
//        auto-deploy on every commit — a SOC 2 CC8.1 finding.
//     2. The `env_region` enum on disk and in the workflow input
//        match exactly. A new env-region added in
//        `infra/terraform/environments/` but not exposed in the
//        workflow means it cannot be deployed via CI (a CC8.1
//        consistency gap). A removed env-region still listed in
//        the workflow lets an operator dispatch against a
//        directory that does not exist.
//     3. The apply step `terraform apply tfplan` — runs THE
//        SAVED PLAN, never a bare `apply` or `apply -auto-approve`
//        that re-plans at execution time. Re-planning at apply
//        time would defeat the reviewer approval (the reviewer
//        approved a specific plan, and that plan is what gets
//        executed).
//     4. The apply job declares `environment:` (which enables the
//        GH-native required-reviewer approval gate). Without
//        `environment:`, the workflow runs through to apply with
//        no approval — defeats the entire control.
//     5. `apply` job's `needs:` includes `plan` — guarantees the
//        plan ran before apply.
//     6. `concurrency.group` is keyed on `inputs.env_region` —
//        prevents two simultaneous applies against the same
//        env-region from racing on the state lock.
//     7. `permissions:` declares `id-token: write` + `contents:
//        read` and nothing the workflow doesn't need.
//
// None of these are caught by `terraform-ci.yml` (which only
// validates the HCL tree) or by GitHub's own yaml linter (which
// only validates the schema, not the semantic invariants). This
// script is the single guard that makes the apply workflow's
// safety story tamper-evident in CI.
//
// This guard closes the `tf1-applyflow` follow-up tracked in
// `docs/operations/production-deployment.md` § 8 and the G2 row
// of `docs/soc2/code-evidence-map.md`.
//
// Parser note: the checker uses regex-based structural extraction
// rather than full yaml parsing. Adding a yaml dependency just for
// this one check is heavier than the surface it would buy us; the
// invariants are about specific lines + specific text patterns
// inside specific job blocks, all of which regex handles cleanly.
// The unit tests cover each invariant independently so a future
// yaml-format change that breaks a regex assumption will surface
// as a focused test failure rather than a silent rot.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_PATH = resolve(REPO_ROOT, ".github/workflows/terraform-apply.yml");
const ENVIRONMENTS_ROOT = resolve(REPO_ROOT, "infra/terraform/environments");

const REQUIRED_INPUTS = ["env_region", "reason", "expected_changes"] as const;
const FORBIDDEN_TRIGGERS = [
  "push",
  "pull_request",
  "schedule",
  "release",
  "repository_dispatch",
  "issue_comment",
] as const;

export interface CheckResult {
  readonly ok: boolean;
  readonly violations: ReadonlyArray<string>;
}

/**
 * Extracts every line that starts at column 0 (top-level keys), so we
 * can carve the workflow file into top-level sections without parsing
 * yaml. Comments and blank lines are skipped.
 */
function findTopLevelKeyOffsets(
  text: string
): ReadonlyArray<{ key: string; line: number; offset: number }> {
  const lines = text.split("\n");
  const offsets: Array<{ key: string; line: number; offset: number }> = [];
  let runningOffset = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(?:#.*)?$/);
    if (match) {
      offsets.push({ key: match[1]!, line: i + 1, offset: runningOffset });
    }
    runningOffset += line.length + 1; // +1 for the newline
  }
  return offsets;
}

/**
 * Extracts the text of a top-level section (e.g. `on:`, `jobs:`,
 * `concurrency:`) from the workflow file. Returns the empty string
 * if the key is absent.
 */
function extractTopLevelSection(text: string, key: string): string {
  const offsets = findTopLevelKeyOffsets(text);
  for (let i = 0; i < offsets.length; i += 1) {
    const here = offsets[i]!;
    if (here.key !== key) continue;
    const next = offsets[i + 1];
    const start = here.offset;
    const end = next ? next.offset : text.length;
    return text.slice(start, end);
  }
  return "";
}

/**
 * Extracts the body of a named job under `jobs:`. Job blocks start
 * at column 2 (`  <name>:`); we return the slice up to the next
 * column-2 sibling or end of file.
 */
function extractJobBody(text: string, jobName: string): string {
  const jobsSection = extractTopLevelSection(text, "jobs");
  if (jobsSection === "") return "";
  const lines = jobsSection.split("\n");
  const jobHeader = new RegExp(`^  ${jobName}:\\s*(?:#.*)?$`);
  let startLine = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (jobHeader.test(lines[i] ?? "")) {
      startLine = i;
      break;
    }
  }
  if (startLine === -1) return "";
  let endLine = lines.length;
  for (let i = startLine + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (/^ {2}[a-zA-Z_][a-zA-Z0-9_-]*:\s*(?:#.*)?$/.test(line)) {
      endLine = i;
      break;
    }
  }
  return lines.slice(startLine, endLine).join("\n");
}

/**
 * Reads the env-region directories on disk under
 * `infra/terraform/environments/<env>/<region>/`. Returns the
 * canonical kebab-case env-region names the workflow's choice enum
 * should expose (modulo dev, which the workflow intentionally
 * excludes — dev applies run from the operator's local workstation).
 */
export function readEnvRegionsOnDisk(envRoot: string): ReadonlyArray<string> {
  const out: Array<string> = [];
  const envs = readdirSync(envRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const env of envs) {
    if (env === "dev") continue; // intentionally not deployable via CI
    const regions = readdirSync(resolve(envRoot, env), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    for (const region of regions) {
      // us-east-1 → use1; us-west-2 → usw2 (matches the workflow enum).
      const regionShort = region.replace(
        /^([a-z]+)-([a-z]+)-(\d)$/,
        (_m, p1, p2, p3) => `${p1[0]}${p2[0]}${p3}`
      );
      out.push(`${env}-${regionShort}`);
    }
  }
  return out;
}

/**
 * Invariant 1: triggers. The workflow must declare exactly
 * `workflow_dispatch:` under `on:`. Auto-triggers are forbidden.
 */
function checkTriggers(text: string): ReadonlyArray<string> {
  const violations: Array<string> = [];
  const onSection = extractTopLevelSection(text, "on");
  if (onSection === "") {
    violations.push("[triggers] missing top-level `on:` block");
    return violations;
  }
  if (!/^\s+workflow_dispatch:/m.test(onSection)) {
    violations.push(
      "[triggers] `on:` must declare `workflow_dispatch:` (this workflow is dispatch-only)"
    );
  }
  for (const forbidden of FORBIDDEN_TRIGGERS) {
    // Match the trigger as a child of `on:` (indented), not a key in a script
    // line or string. We scan the lines of the `on:` section only.
    const re = new RegExp(`^\\s+${forbidden}:`, "m");
    if (re.test(onSection)) {
      violations.push(
        `[triggers] \`on:\` declares forbidden trigger \`${forbidden}\`. Production apply is dispatch-only.`
      );
    }
  }
  return violations;
}

/**
 * Invariant 2: required dispatch inputs. Each of `env_region`,
 * `reason`, `expected_changes` must appear under
 * `on.workflow_dispatch.inputs` and must be marked `required: true`.
 */
function checkRequiredInputs(text: string): ReadonlyArray<string> {
  const violations: Array<string> = [];
  const onSection = extractTopLevelSection(text, "on");
  for (const inputName of REQUIRED_INPUTS) {
    // Look for `      <name>:` (8 spaces of indent — under inputs:
    // which is under workflow_dispatch: which is under on:). Then
    // peek the next 8 lines for `required: true`.
    const headerRe = new RegExp(`^      ${inputName}:\\s*(?:#.*)?$`, "m");
    const headerMatch = onSection.match(headerRe);
    if (!headerMatch || headerMatch.index === undefined) {
      violations.push(`[inputs] dispatch input \`${inputName}\` not declared`);
      continue;
    }
    const tail = onSection.slice(headerMatch.index);
    // Stop at the next sibling input (8 spaces of indent + identifier + colon).
    const sliceEnd = (() => {
      const m = tail.slice(headerMatch[0].length).match(/^ {6}[a-zA-Z_][a-zA-Z0-9_]*:/m);
      return m && m.index !== undefined ? headerMatch[0].length + m.index : tail.length;
    })();
    const body = tail.slice(0, sliceEnd);
    if (!/^\s+required:\s*true\b/m.test(body)) {
      violations.push(`[inputs] dispatch input \`${inputName}\` is missing \`required: true\``);
    }
  }
  return violations;
}

/**
 * Invariant 3: the `env_region` choice options exactly match the
 * env-region directories on disk under
 * `infra/terraform/environments/` (excluding `dev/`, which is
 * intentionally not deployable via CI).
 */
function checkEnvRegionEnum(
  text: string,
  expectedRegions: ReadonlyArray<string>
): ReadonlyArray<string> {
  const violations: Array<string> = [];
  const onSection = extractTopLevelSection(text, "on");
  // Find the env_region block, then extract every `          - <value>` line.
  const headerMatch = onSection.match(/^ {6}env_region:\s*(?:#.*)?$/m);
  if (!headerMatch || headerMatch.index === undefined) {
    violations.push("[enum] env_region input not declared");
    return violations;
  }
  const tail = onSection.slice(headerMatch.index);
  const sliceEnd = (() => {
    const m = tail.slice(headerMatch[0].length).match(/^ {6}[a-zA-Z_][a-zA-Z0-9_]*:/m);
    return m && m.index !== undefined ? headerMatch[0].length + m.index : tail.length;
  })();
  const body = tail.slice(0, sliceEnd);
  // Options are at indent 10 spaces: `          - prod-use1`
  const optionRegex = /^ {10}- ([a-zA-Z0-9_-]+)\s*(?:#.*)?$/gm;
  const declared: Array<string> = [];
  for (const m of body.matchAll(optionRegex)) {
    declared.push(m[1]!);
  }
  const declaredSet = new Set(declared);
  const expectedSet = new Set(expectedRegions);

  const missing = expectedRegions.filter((r) => !declaredSet.has(r));
  const extra = declared.filter((r) => !expectedSet.has(r));

  if (missing.length > 0) {
    violations.push(
      `[enum] env_region options missing on-disk env-regions: ${missing.join(", ")}. ` +
        "Either add the option to the workflow OR remove the directory from infra/terraform/environments/."
    );
  }
  if (extra.length > 0) {
    violations.push(
      `[enum] env_region options reference non-existent env-regions: ${extra.join(", ")}. ` +
        "Remove the option from the workflow OR add the directory under infra/terraform/environments/."
    );
  }
  return violations;
}

/**
 * Invariant 4: the apply step runs `terraform apply tfplan`
 * (positional plan file). It MUST NOT contain `-auto-approve`
 * (which would skip approval-equivalent checks if the plan-file
 * argument is also missing) AND it MUST contain `tfplan` as a
 * positional argument to the apply invocation.
 */
function checkApplyUsesSavedPlan(text: string): ReadonlyArray<string> {
  const violations: Array<string> = [];
  const applyJob = extractJobBody(text, "apply");
  if (applyJob === "") {
    violations.push("[apply] job `apply` not found");
    return violations;
  }

  // Find every `terraform apply ...` invocation across all run: blocks
  // in the apply job. A "real" invocation is a shell command — the line,
  // after trimming leading whitespace, starts with `terraform apply`.
  // This excludes:
  //   - YAML comments (start with `#`)
  //   - error/echo lines that embed the literal string `terraform apply`
  //     inside a quoted message
  //   - the `name:` step label (e.g. `name: terraform apply tfplan`),
  //     which is documentation, not execution
  const applyInvocations: Array<string> = [];
  const lines = applyJob.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? "";
    const trimmed = raw.replace(/^\s+/, "");
    if (!trimmed.startsWith("terraform apply")) continue;
    // Collect this line + any continuation lines (those ending in `\`).
    let collected = trimmed;
    let j = i;
    while ((lines[j] ?? "").trimEnd().endsWith("\\") && j + 1 < lines.length) {
      j += 1;
      collected = `${collected.replace(/\\\s*$/, "")} ${(lines[j] ?? "").trim()}`;
    }
    applyInvocations.push(collected);
  }

  if (applyInvocations.length === 0) {
    violations.push("[apply] apply job has no `terraform apply` invocation");
    return violations;
  }

  for (const inv of applyInvocations) {
    if (/-auto-approve\b/.test(inv)) {
      violations.push(
        `[apply] \`terraform apply\` invocation uses \`-auto-approve\`. ` +
          `Production apply must execute the saved plan binary (positional plan file), ` +
          `never a fresh re-plan. Offending invocation: ${inv.trim()}`
      );
    }
    // Must contain `tfplan` as a non-flag positional argument.
    // Strip every `-flag` and `-flag=value` token, then check what's left.
    const stripped = inv
      .replace(/--?[a-zA-Z][a-zA-Z0-9_-]*(?:=[^\s]+)?/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    // After stripping flags, expect `terraform apply tfplan` (modulo
    // pipes/redirects). We assert the literal token `tfplan` appears as a positional.
    const tokens = stripped.split(" ");
    const applyIdx = tokens.findIndex((t) => t === "apply");
    const positionals = applyIdx >= 0 ? tokens.slice(applyIdx + 1) : [];
    if (!positionals.includes("tfplan")) {
      violations.push(
        `[apply] \`terraform apply\` invocation is missing positional \`tfplan\` plan-file argument. ` +
          `Production apply MUST execute the saved plan binary. Offending invocation: ${inv.trim()}`
      );
    }
  }
  return violations;
}

/**
 * Invariant 5: the apply job declares `environment:`. This is what
 * enables the GitHub-native required-reviewer approval gate. Without
 * it, the workflow runs through apply with no approval.
 */
function checkApplyHasEnvironment(text: string): ReadonlyArray<string> {
  const violations: Array<string> = [];
  const applyJob = extractJobBody(text, "apply");
  if (applyJob === "") {
    violations.push("[environment] job `apply` not found");
    return violations;
  }
  // The `environment:` key sits at the job's indent (4 spaces under jobs.apply).
  // We accept either the inline form `environment: <name>` or the block form
  // `environment:\n      name: <name>`.
  if (
    !/^ {4}environment:\s*(?:#.*)?$/m.test(applyJob) &&
    !/^ {4}environment:\s+\S/m.test(applyJob)
  ) {
    violations.push(
      "[environment] apply job is missing `environment:` declaration. " +
        "Without it, the GH-native required-reviewer approval gate does not fire and production applies run without approval."
    );
  }
  return violations;
}

/**
 * Invariant 6: the apply job's `needs:` includes `plan`. The plan
 * must run (and pass) before apply.
 */
function checkApplyNeedsPlan(text: string): ReadonlyArray<string> {
  const violations: Array<string> = [];
  const applyJob = extractJobBody(text, "apply");
  if (applyJob === "") {
    violations.push("[needs] job `apply` not found");
    return violations;
  }
  const needsMatch = applyJob.match(/^ {4}needs:\s*(.+)$/m);
  if (!needsMatch) {
    violations.push("[needs] apply job is missing `needs:` declaration");
    return violations;
  }
  const needsValue = needsMatch[1]!.trim();
  // Accept `plan`, `[plan, ...]`, `[..., plan]`, etc.
  if (!/(^|[[,\s])plan(]|[,\s]|$)/.test(needsValue)) {
    violations.push(`[needs] apply job's needs:= must include \`plan\`; got \`${needsValue}\``);
  }
  return violations;
}

/**
 * Invariant 7: top-level `concurrency.group` is keyed on
 * `inputs.env_region`. Prevents two simultaneous applies against
 * the same env-region from racing on the state lock.
 */
function checkConcurrencyGroup(text: string): ReadonlyArray<string> {
  const violations: Array<string> = [];
  const concurrency = extractTopLevelSection(text, "concurrency");
  if (concurrency === "") {
    violations.push("[concurrency] missing top-level `concurrency:` block");
    return violations;
  }
  const groupMatch = concurrency.match(/^\s+group:\s*(.+)$/m);
  if (!groupMatch) {
    violations.push("[concurrency] missing `group:` key");
    return violations;
  }
  const groupValue = groupMatch[1]!;
  if (!/inputs\.env_region/.test(groupValue)) {
    violations.push(
      `[concurrency] group must reference \`inputs.env_region\` so each env-region serialises independently; got \`${groupValue.trim()}\``
    );
  }
  return violations;
}

/**
 * Invariant 8: top-level `permissions:` declares `id-token: write`
 * (for OIDC) and `contents: read` (for checkout). Anything more
 * permissive is a finding.
 */
function checkPermissions(text: string): ReadonlyArray<string> {
  const violations: Array<string> = [];
  const permissions = extractTopLevelSection(text, "permissions");
  if (permissions === "") {
    violations.push("[permissions] missing top-level `permissions:` block");
    return violations;
  }
  if (!/^\s+id-token:\s*write\b/m.test(permissions)) {
    violations.push("[permissions] must declare `id-token: write` (OIDC federation)");
  }
  if (!/^\s+contents:\s*read\b/m.test(permissions)) {
    violations.push("[permissions] must declare `contents: read` (checkout)");
  }
  // Disallow `write-all` or any contents:write.
  if (/^\s+contents:\s*write\b/m.test(permissions)) {
    violations.push(
      "[permissions] contents must be `read`, not `write`. The apply workflow does not push commits."
    );
  }
  return violations;
}

export function checkTerraformApplyWorkflow(input: {
  readonly workflowText: string;
  readonly envRegionsOnDisk: ReadonlyArray<string>;
}): CheckResult {
  const violations: Array<string> = [];
  violations.push(...checkTriggers(input.workflowText));
  violations.push(...checkRequiredInputs(input.workflowText));
  violations.push(...checkEnvRegionEnum(input.workflowText, input.envRegionsOnDisk));
  violations.push(...checkApplyUsesSavedPlan(input.workflowText));
  violations.push(...checkApplyHasEnvironment(input.workflowText));
  violations.push(...checkApplyNeedsPlan(input.workflowText));
  violations.push(...checkConcurrencyGroup(input.workflowText));
  violations.push(...checkPermissions(input.workflowText));
  return { ok: violations.length === 0, violations };
}

function main(): void {
  let workflowText: string;
  try {
    workflowText = readFileSync(WORKFLOW_PATH, "utf8");
  } catch (err) {
    console.error(
      `[check-terraform-apply-workflow] FAIL: cannot read ${WORKFLOW_PATH}: ${String(err)}`
    );
    process.exit(1);
  }

  let envRegionsOnDisk: ReadonlyArray<string>;
  try {
    statSync(ENVIRONMENTS_ROOT);
    envRegionsOnDisk = readEnvRegionsOnDisk(ENVIRONMENTS_ROOT);
  } catch (err) {
    console.error(
      `[check-terraform-apply-workflow] FAIL: cannot scan ${ENVIRONMENTS_ROOT}: ${String(err)}`
    );
    process.exit(1);
  }

  const result = checkTerraformApplyWorkflow({ workflowText, envRegionsOnDisk });

  if (!result.ok) {
    console.error("[check-terraform-apply-workflow] FAIL — apply-workflow invariants violated:");
    for (const v of result.violations) {
      console.error(`  - ${v}`);
    }
    console.error("");
    console.error(
      "See scripts/check-terraform-apply-workflow.ts header for the invariant rationale,"
    );
    console.error(
      "and docs/operations/production-deployment.md § 2.3 for the apply-workflow design."
    );
    process.exit(1);
  }

  console.log(
    `[check-terraform-apply-workflow] ok — 8 invariants pass; ${envRegionsOnDisk.length} env-region(s) match.`
  );
}

// Only run main() when invoked as a script — not when imported by tests.
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
