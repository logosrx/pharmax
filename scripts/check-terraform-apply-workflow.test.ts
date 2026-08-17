// scripts/check-terraform-apply-workflow.test.ts
//
// Table-driven invariants for the apply-workflow checker. Each test
// builds a synthetic workflow text that violates exactly one
// invariant, then asserts the checker emits the matching violation —
// and that the real workflow text passes cleanly.
//
// Why table-driven: the eight invariants are independent and the
// failure modes are easy to confuse ("did the regex match the env_region
// enum mismatch, or did it match the destroyed protected resource?").
// Synthesizing a minimal valid baseline and mutating it per test
// gives one-line-per-invariant coverage.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  checkTerraformApplyWorkflow,
  readEnvRegionsOnDisk,
  readPlanTimeArtifactDirs,
} from "./check-terraform-apply-workflow";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REAL_WORKFLOW = resolve(REPO_ROOT, ".github/workflows/terraform-apply.yml");
const REAL_ENV_ROOT = resolve(REPO_ROOT, "infra/terraform/environments");
const REAL_MODULES_ROOT = resolve(REPO_ROOT, "infra/terraform/modules");

// -----------------------------------------------------------------
// Baseline: a minimal valid workflow text that passes every check.
// Each test mutates this baseline to violate one invariant.
// -----------------------------------------------------------------

const VALID_ENV_REGIONS: ReadonlyArray<string> = ["staging-ue1", "prod-ue1", "prod-uw2"];

function buildBaselineWorkflow(): string {
  return `name: terraform-apply

on:
  workflow_dispatch:
    inputs:
      env_region:
        description: "Target env-region"
        type: choice
        required: true
        options:
          - staging-ue1
          - prod-ue1
          - prod-uw2
      reason:
        description: "Justification"
        type: string
        required: true
      expected_changes:
        description: "Predicted plan summary"
        type: string
        required: true

permissions:
  contents: read
  id-token: write

concurrency:
  group: terraform-apply-\${{ inputs.env_region }}
  cancel-in-progress: false

jobs:
  preflight:
    name: Preflight
    runs-on: ubuntu-latest
    steps:
      - run: echo "ok"

  plan:
    name: Plan
    needs: preflight
    runs-on: ubuntu-latest
    steps:
      - run: terraform plan -out=tfplan

  apply:
    name: Apply
    needs: [preflight, plan]
    runs-on: ubuntu-latest
    environment:
      name: terraform-apply-\${{ inputs.env_region }}
    steps:
      - name: terraform apply tfplan
        run: |
          terraform apply \\
            -input=false \\
            -lock-timeout=2m \\
            -no-color \\
            tfplan
`;
}

// -----------------------------------------------------------------
// Baseline sanity: the synthetic baseline must itself pass the checker
// (otherwise downstream tests measure the wrong thing).
// -----------------------------------------------------------------

describe("baseline", () => {
  it("synthetic valid baseline passes all 8 invariants", () => {
    const result = checkTerraformApplyWorkflow({
      workflowText: buildBaselineWorkflow(),
      envRegionsOnDisk: VALID_ENV_REGIONS,
    });
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

// -----------------------------------------------------------------
// Invariant 1: triggers — workflow_dispatch only.
// -----------------------------------------------------------------

describe("invariant 1: triggers", () => {
  it("flags a `push:` trigger", () => {
    const text = buildBaselineWorkflow().replace(
      "on:\n  workflow_dispatch:",
      "on:\n  push:\n    branches: [main]\n  workflow_dispatch:"
    );
    const result = checkTerraformApplyWorkflow({
      workflowText: text,
      envRegionsOnDisk: VALID_ENV_REGIONS,
    });
    expect(result.violations).toContainEqual(expect.stringMatching(/forbidden trigger.*push/));
    expect(result.ok).toBe(false);
  });

  it("flags a `pull_request:` trigger", () => {
    const text = buildBaselineWorkflow().replace(
      "on:\n  workflow_dispatch:",
      "on:\n  pull_request:\n    paths: ['infra/**']\n  workflow_dispatch:"
    );
    const result = checkTerraformApplyWorkflow({
      workflowText: text,
      envRegionsOnDisk: VALID_ENV_REGIONS,
    });
    expect(result.violations).toContainEqual(
      expect.stringMatching(/forbidden trigger.*pull_request/)
    );
  });

  it("flags a `schedule:` trigger", () => {
    const text = buildBaselineWorkflow().replace(
      "on:\n  workflow_dispatch:",
      "on:\n  schedule:\n    - cron: '0 8 * * *'\n  workflow_dispatch:"
    );
    const result = checkTerraformApplyWorkflow({
      workflowText: text,
      envRegionsOnDisk: VALID_ENV_REGIONS,
    });
    expect(result.violations).toContainEqual(expect.stringMatching(/forbidden trigger.*schedule/));
  });

  it("flags missing workflow_dispatch", () => {
    const text = buildBaselineWorkflow().replace(
      "on:\n  workflow_dispatch:",
      "on:\n  workflow_call:"
    );
    const result = checkTerraformApplyWorkflow({
      workflowText: text,
      envRegionsOnDisk: VALID_ENV_REGIONS,
    });
    expect(result.violations).toContainEqual(
      expect.stringMatching(/must declare `workflow_dispatch:`/)
    );
  });
});

// -----------------------------------------------------------------
// Invariant 2: required inputs.
// -----------------------------------------------------------------

describe("invariant 2: required inputs", () => {
  it("flags missing `reason` input", () => {
    const text = buildBaselineWorkflow().replace(/ {6}reason:[\s\S]+?required: true\n/, "");
    const result = checkTerraformApplyWorkflow({
      workflowText: text,
      envRegionsOnDisk: VALID_ENV_REGIONS,
    });
    expect(result.violations).toContainEqual(expect.stringMatching(/`reason` not declared/));
  });

  it("flags `expected_changes` without required:true", () => {
    const text = buildBaselineWorkflow().replace(
      `      expected_changes:
        description: "Predicted plan summary"
        type: string
        required: true`,
      `      expected_changes:
        description: "Predicted plan summary"
        type: string
        required: false`
    );
    const result = checkTerraformApplyWorkflow({
      workflowText: text,
      envRegionsOnDisk: VALID_ENV_REGIONS,
    });
    expect(result.violations).toContainEqual(
      expect.stringMatching(/`expected_changes` is missing `required: true`/)
    );
  });

  it("flags env_region without required:true", () => {
    const text = buildBaselineWorkflow().replace(
      `      env_region:
        description: "Target env-region"
        type: choice
        required: true
        options:`,
      `      env_region:
        description: "Target env-region"
        type: choice
        required: false
        options:`
    );
    const result = checkTerraformApplyWorkflow({
      workflowText: text,
      envRegionsOnDisk: VALID_ENV_REGIONS,
    });
    expect(result.violations).toContainEqual(
      expect.stringMatching(/`env_region` is missing `required: true`/)
    );
  });
});

// -----------------------------------------------------------------
// Invariant 3: env_region enum ↔ filesystem.
// -----------------------------------------------------------------

describe("invariant 3: env_region enum", () => {
  it("flags an on-disk env-region missing from the workflow enum", () => {
    const result = checkTerraformApplyWorkflow({
      workflowText: buildBaselineWorkflow(),
      envRegionsOnDisk: [...VALID_ENV_REGIONS, "prod-euw1"], // disk has an env-region the workflow doesn't expose
    });
    expect(result.violations).toContainEqual(
      expect.stringMatching(/missing on-disk env-regions: prod-euw1/)
    );
  });

  it("flags a workflow option that doesn't exist on disk", () => {
    const result = checkTerraformApplyWorkflow({
      workflowText: buildBaselineWorkflow(),
      envRegionsOnDisk: ["prod-ue1", "prod-uw2"], // disk lost staging-ue1; workflow still references it
    });
    expect(result.violations).toContainEqual(
      expect.stringMatching(/non-existent env-regions: staging-ue1/)
    );
  });

  it("passes when enum and disk match exactly", () => {
    const result = checkTerraformApplyWorkflow({
      workflowText: buildBaselineWorkflow(),
      envRegionsOnDisk: VALID_ENV_REGIONS,
    });
    expect(result.violations.filter((v) => v.includes("[enum]"))).toEqual([]);
  });
});

// -----------------------------------------------------------------
// Invariant 4: apply uses the saved plan (positional tfplan, no -auto-approve).
// -----------------------------------------------------------------

describe("invariant 4: apply uses saved plan", () => {
  it("flags `terraform apply -auto-approve` (no positional plan file)", () => {
    const text = buildBaselineWorkflow().replace(
      `          terraform apply \\
            -input=false \\
            -lock-timeout=2m \\
            -no-color \\
            tfplan`,
      `          terraform apply -auto-approve -input=false`
    );
    const result = checkTerraformApplyWorkflow({
      workflowText: text,
      envRegionsOnDisk: VALID_ENV_REGIONS,
    });
    expect(result.violations).toContainEqual(expect.stringMatching(/uses `-auto-approve`/));
  });

  it("flags `terraform apply` without positional tfplan", () => {
    const text = buildBaselineWorkflow().replace(
      `          terraform apply \\
            -input=false \\
            -lock-timeout=2m \\
            -no-color \\
            tfplan`,
      `          terraform apply -input=false`
    );
    const result = checkTerraformApplyWorkflow({
      workflowText: text,
      envRegionsOnDisk: VALID_ENV_REGIONS,
    });
    expect(result.violations).toContainEqual(expect.stringMatching(/missing positional `tfplan`/));
  });

  it("ignores comments and error-message strings that contain 'terraform apply'", () => {
    const text = buildBaselineWorkflow().replace(
      `      - name: terraform apply tfplan
        run: |
          terraform apply \\
            -input=false \\
            -lock-timeout=2m \\
            -no-color \\
            tfplan`,
      `      - name: terraform apply tfplan
        run: |
          # DO NOT change to terraform apply -auto-approve
          echo "::error::terraform apply failed"
          terraform apply \\
            -input=false \\
            tfplan`
    );
    const result = checkTerraformApplyWorkflow({
      workflowText: text,
      envRegionsOnDisk: VALID_ENV_REGIONS,
    });
    // Should pass invariant 4 (the comment + error line are not real invocations)
    expect(result.violations.filter((v) => v.includes("[apply]"))).toEqual([]);
  });

  it("flags a single-line apply that has no plan file", () => {
    const text = buildBaselineWorkflow().replace(
      `          terraform apply \\
            -input=false \\
            -lock-timeout=2m \\
            -no-color \\
            tfplan`,
      `          terraform apply`
    );
    const result = checkTerraformApplyWorkflow({
      workflowText: text,
      envRegionsOnDisk: VALID_ENV_REGIONS,
    });
    expect(result.violations).toContainEqual(expect.stringMatching(/missing positional `tfplan`/));
  });
});

// -----------------------------------------------------------------
// Invariant 5: apply job declares `environment:`.
// -----------------------------------------------------------------

describe("invariant 5: apply job environment", () => {
  it("flags apply job without `environment:`", () => {
    const text = buildBaselineWorkflow().replace(
      `    environment:
      name: terraform-apply-\${{ inputs.env_region }}
`,
      ""
    );
    const result = checkTerraformApplyWorkflow({
      workflowText: text,
      envRegionsOnDisk: VALID_ENV_REGIONS,
    });
    expect(result.violations).toContainEqual(
      expect.stringMatching(/missing `environment:` declaration/)
    );
  });

  it("accepts the inline form `environment: <name>`", () => {
    const text = buildBaselineWorkflow().replace(
      `    environment:
      name: terraform-apply-\${{ inputs.env_region }}`,
      `    environment: terraform-apply-\${{ inputs.env_region }}`
    );
    const result = checkTerraformApplyWorkflow({
      workflowText: text,
      envRegionsOnDisk: VALID_ENV_REGIONS,
    });
    expect(result.violations.filter((v) => v.includes("[environment]"))).toEqual([]);
  });
});

// -----------------------------------------------------------------
// Invariant 6: apply needs plan.
// -----------------------------------------------------------------

describe("invariant 6: apply needs plan", () => {
  it("flags apply job whose needs: omits plan", () => {
    const text = buildBaselineWorkflow().replace(
      "    needs: [preflight, plan]",
      "    needs: [preflight]"
    );
    const result = checkTerraformApplyWorkflow({
      workflowText: text,
      envRegionsOnDisk: VALID_ENV_REGIONS,
    });
    expect(result.violations).toContainEqual(expect.stringMatching(/needs.*must include `plan`/));
  });

  it("flags apply job with no needs: at all", () => {
    const text = buildBaselineWorkflow().replace("    needs: [preflight, plan]\n", "");
    const result = checkTerraformApplyWorkflow({
      workflowText: text,
      envRegionsOnDisk: VALID_ENV_REGIONS,
    });
    expect(result.violations).toContainEqual(expect.stringMatching(/missing `needs:` declaration/));
  });

  it("accepts a single-string needs (needs: plan)", () => {
    const text = buildBaselineWorkflow().replace("    needs: [preflight, plan]", "    needs: plan");
    const result = checkTerraformApplyWorkflow({
      workflowText: text,
      envRegionsOnDisk: VALID_ENV_REGIONS,
    });
    expect(result.violations.filter((v) => v.includes("[needs]"))).toEqual([]);
  });
});

// -----------------------------------------------------------------
// Invariant 7: concurrency.group keyed on inputs.env_region.
// -----------------------------------------------------------------

describe("invariant 7: concurrency group", () => {
  it("flags a concurrency group that doesn't reference inputs.env_region", () => {
    const text = buildBaselineWorkflow().replace(
      "  group: terraform-apply-${{ inputs.env_region }}",
      "  group: terraform-apply-global"
    );
    const result = checkTerraformApplyWorkflow({
      workflowText: text,
      envRegionsOnDisk: VALID_ENV_REGIONS,
    });
    expect(result.violations).toContainEqual(
      expect.stringMatching(/must reference `inputs\.env_region`/)
    );
  });

  it("flags missing concurrency block", () => {
    const text = buildBaselineWorkflow().replace(
      `concurrency:
  group: terraform-apply-\${{ inputs.env_region }}
  cancel-in-progress: false

`,
      ""
    );
    const result = checkTerraformApplyWorkflow({
      workflowText: text,
      envRegionsOnDisk: VALID_ENV_REGIONS,
    });
    expect(result.violations).toContainEqual(
      expect.stringMatching(/missing top-level `concurrency:` block/)
    );
  });
});

// -----------------------------------------------------------------
// Invariant 8: permissions.
// -----------------------------------------------------------------

describe("invariant 8: permissions", () => {
  it("flags missing id-token: write", () => {
    const text = buildBaselineWorkflow().replace("  id-token: write\n", "");
    const result = checkTerraformApplyWorkflow({
      workflowText: text,
      envRegionsOnDisk: VALID_ENV_REGIONS,
    });
    expect(result.violations).toContainEqual(
      expect.stringMatching(/must declare `id-token: write`/)
    );
  });

  it("flags missing contents: read", () => {
    const text = buildBaselineWorkflow().replace("  contents: read\n", "");
    const result = checkTerraformApplyWorkflow({
      workflowText: text,
      envRegionsOnDisk: VALID_ENV_REGIONS,
    });
    expect(result.violations).toContainEqual(
      expect.stringMatching(/must declare `contents: read`/)
    );
  });

  it("flags contents: write (over-permissive)", () => {
    const text = buildBaselineWorkflow().replace("  contents: read", "  contents: write");
    const result = checkTerraformApplyWorkflow({
      workflowText: text,
      envRegionsOnDisk: VALID_ENV_REGIONS,
    });
    expect(result.violations).toContainEqual(expect.stringMatching(/contents must be `read`/));
  });
});

// -----------------------------------------------------------------
// Filesystem helper.
// -----------------------------------------------------------------

describe("readEnvRegionsOnDisk", () => {
  it("returns staging-ue1, prod-ue1, prod-uw2 (excludes dev) against the real repo", () => {
    const regions = readEnvRegionsOnDisk(REAL_ENV_ROOT);
    expect(regions).toEqual(expect.arrayContaining(["staging-ue1", "prod-ue1", "prod-uw2"]));
    expect(regions).not.toContain("dev-ue1");
  });
});

// -----------------------------------------------------------------
// End-to-end: the real workflow passes every invariant.
// This is the load-bearing assertion that catches regressions
// when someone edits the real workflow file in a future PR.
// -----------------------------------------------------------------

describe("real workflow", () => {
  it("passes all 9 invariants against the real .github/workflows/terraform-apply.yml", () => {
    const workflowText = readFileSync(REAL_WORKFLOW, "utf8");
    const envRegionsOnDisk = readEnvRegionsOnDisk(REAL_ENV_ROOT);
    const result = checkTerraformApplyWorkflow({
      workflowText,
      envRegionsOnDisk,
      planTimeArtifactDirs: readPlanTimeArtifactDirs(REAL_MODULES_ROOT),
      repoRoot: REPO_ROOT,
    });
    if (!result.ok) {
      console.error("Real workflow violations:", result.violations);
    }
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

// -----------------------------------------------------------------
// Invariant 9: plan-time archives reach the apply runner.
//
// This is the invariant with a production incident behind it: the
// 2026-08-17 prod-ue1 apply created the synthetics bucket and IAM role
// and then died on `open ...heartbeat-<md5>.zip: no such file or
// directory`, because the archive existed only on the plan runner.
// -----------------------------------------------------------------

describe("invariant 9: plan-time archives reach apply", () => {
  const ARCHIVE_DIR = resolve(REPO_ROOT, "infra/terraform/modules/synthetics/.build");

  /** Baseline + the artifact round-trip the real workflow performs. */
  function withArtifactCarry(options: {
    readonly upload: boolean;
    readonly download: boolean;
    readonly includeHiddenFiles?: boolean;
  }): string {
    const hidden =
      options.includeHiddenFiles === false ? "" : "\n          include-hidden-files: true";
    const upload = options.upload
      ? `
      - name: Upload canary bundle
        uses: actions/upload-artifact@v4
        with:
          name: canary-bundle
          path: \${{ env.CANARY_BUNDLE_DIR }}/*.zip${hidden}`
      : "";
    const download = options.download
      ? `
      - name: Download canary bundle
        uses: actions/download-artifact@v8
        with:
          name: canary-bundle
          path: \${{ env.CANARY_BUNDLE_DIR }}`
      : "";
    return buildBaselineWorkflow()
      .replace(
        "concurrency:",
        `env:
  CANARY_BUNDLE_DIR: "infra/terraform/modules/synthetics/.build"

concurrency:`
      )
      .replace(
        "      - run: terraform plan -out=tfplan",
        `      - run: terraform plan -out=tfplan${upload}`
      )
      .replace(
        "      - name: terraform apply tfplan",
        `${download}
      - name: terraform apply tfplan`
      );
  }

  function check(workflowText: string) {
    return checkTerraformApplyWorkflow({
      workflowText,
      envRegionsOnDisk: VALID_ENV_REGIONS,
      planTimeArtifactDirs: [ARCHIVE_DIR],
      repoRoot: REPO_ROOT,
    });
  }

  it("passes when the plan uploads the archive and the apply downloads it", () => {
    const result = check(withArtifactCarry({ upload: true, download: true }));
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("flags an archive the plan never uploads", () => {
    const result = check(withArtifactCarry({ upload: false, download: true }));
    expect(result.violations).toContainEqual(expect.stringMatching(/plan job never uploads/));
    expect(result.ok).toBe(false);
  });

  it("flags an archive the apply never downloads", () => {
    const result = check(withArtifactCarry({ upload: true, download: false }));
    expect(result.violations).toContainEqual(expect.stringMatching(/apply job never downloads/));
    expect(result.ok).toBe(false);
  });

  it("flags a workflow that carries nothing at all (the 2026-08-17 shape)", () => {
    const result = check(withArtifactCarry({ upload: false, download: false }));
    expect(result.violations).toHaveLength(2);
    expect(result.ok).toBe(false);
  });

  // The shape merged as #181: both steps present, workflow green, and
  // the artifact silently EMPTY because `.build` is a dot-directory.
  it("flags a hidden archive dir uploaded without include-hidden-files", () => {
    const result = check(
      withArtifactCarry({ upload: true, download: true, includeHiddenFiles: false })
    );
    expect(result.violations).toContainEqual(expect.stringMatching(/include-hidden-files: true/));
    expect(result.ok).toBe(false);
  });

  it("discovers the synthetics canary bundle dir in the real terraform tree", () => {
    expect(readPlanTimeArtifactDirs(REAL_MODULES_ROOT)).toContain(ARCHIVE_DIR);
  });
});
