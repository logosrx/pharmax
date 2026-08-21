#!/usr/bin/env tsx
// scripts/check-compliance-controls.ts
//
// Verifies that the compliance control plane's DOCUMENTED claims agree
// with the CODE, and fails CI when they drift.
//
// WHY THIS EXISTS
//
// A HIPAA audit on 2026-08-20 found two controls that were documented
// and absent, and concluded that the gap was systemic rather than
// incidental: the control matrix, the risk register and the policy
// bundle all assert properties of the implementation, and nothing
// verified those assertions as they aged. The register already names
// the pattern as R-027, "a documented guarantee the code does not
// keep", and did not catch either instance.
//
// `scripts/check-kms-inventory.ts` already proves the remedy works —
// it parses a markdown document and fails CI when it diverges from
// Terraform. This is the same idea pointed at the control plane.
//
// WHAT THIS DOES NOT DO
//
// It does not verify that a control is genuinely satisfied. No script
// can read `docs/soc2/controls-inventory.md` and confirm that, say,
// backups are actually restorable. What it CAN do is confirm the
// machine-checkable links between documents and code, which is where
// drift starts:
//
//   1. Every `controlCodes` entry declared by a registered compliance
//      probe resolves to a real control in the inventory. A probe
//      claiming to monitor a control that does not exist is evidence
//      pointing at nothing.
//
//   2. Every file path a control cites as its implementation exists on
//      disk. This is the direction that catches rot: a control pointing
//      at a module that was renamed or deleted still reads as satisfied,
//      and the citation is what a reviewer follows instead of the code.
//
// A NOTE ON WHAT WAS TRIED AND REJECTED
//
// The first version of check 2 asserted that every control with a
// CONTINUOUS cadence had a probe declaring it. That is wrong, and it
// produced 24 false positives on the first run. The cadence column
// records how often the CONTROL operates, not whether a probe watches
// it — CC6.1-3 (tenant isolation via RLS) is continuous because
// Postgres evaluates it on every query, and no probe is required or
// appropriate. Conflating "operates continuously" with "is monitored
// continuously" would have made the gate demand probes for controls
// that are enforced structurally.
//
// Deliberately DB-free, unlike `scripts/compliance/seed-control-plane.ts`,
// which reconciles the database against the same document and therefore
// cannot run in CI.
//
// Exits 0 when consistent, 1 when it finds drift.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { COMPLIANCE_CHECKS, parseControlsInventory } from "@pharmax/compliance";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INVENTORY = join(ROOT, "docs/soc2/controls-inventory.md");

interface Issue {
  readonly kind: string;
  readonly detail: string;
  readonly remedy: string;
}

/**
 * Directories a citation must start with to be treated as a repository
 * path worth resolving. Anything else mined out of the Notes cell —
 * an ADR id, a table name, a env var, a prose phrase in backticks — is
 * not a path and must not be failed on.
 */
const REPO_PREFIXES: ReadonlyArray<string> = [
  "packages/",
  "apps/",
  "scripts/",
  "prisma/",
  "infra/",
  "docs/",
  ".github/",
];

/**
 * A citation is a checkable path when it points into the repository and
 * carries a file extension or a trailing slash. `packages/tenancy` on
 * its own is a package name in prose; `packages/tenancy/src/als.ts` is
 * a claim about a file.
 */
function isCheckablePath(ref: string): boolean {
  if (!REPO_PREFIXES.some((p) => ref.startsWith(p))) return false;
  if (ref.includes(" ") || ref.includes("`")) return false;
  return /\.[a-z]{2,5}$/.test(ref) || ref.endsWith("/");
}

function main(): number {
  const controls = parseControlsInventory(readFileSync(INVENTORY, "utf8"));
  const byCode = new Map(controls.map((c) => [c.code, c]));
  const issues: Issue[] = [];

  // ---- Direction 1: probe -> control -------------------------------
  //
  // A probe naming a control that does not exist writes evidence rows
  // linked to nothing. The failure is silent: the probe runs, passes,
  // and satisfies no control anyone can find.
  const monitored = new Set<string>();
  for (const check of COMPLIANCE_CHECKS) {
    for (const code of check.controlCodes) {
      monitored.add(code);
      if (!byCode.has(code)) {
        issues.push({
          kind: "probe cites a control that does not exist",
          detail: `check \`${check.code}\` declares controlCode \`${code}\`, which is not in controls-inventory.md`,
          remedy: `add \`${code}\` to the inventory, or correct the controlCodes on that check`,
        });
      }
    }
  }

  // ---- Direction 2: control -> implementation ----------------------
  //
  // A control citing a file that no longer exists still reads as
  // satisfied. The citation is what a reviewer follows instead of
  // reading the code, so a stale one actively misleads.
  let pathsChecked = 0;
  for (const control of controls) {
    for (const ref of control.implementationRefs) {
      if (!isCheckablePath(ref)) continue;
      pathsChecked += 1;
      if (existsSync(join(ROOT, ref))) continue;
      issues.push({
        kind: "control cites an implementation that does not exist",
        detail: `\`${control.code}\` (${control.title}) cites \`${ref}\`, which is not on disk`,
        remedy: `update the citation to the current path, or remove it if the implementation is gone and the control's status should change`,
      });
    }
  }

  // ---- Report ------------------------------------------------------
  const coverage = controls.filter((c) => monitored.has(c.code)).length;
  process.stdout.write(
    `[check-compliance-controls] ${String(controls.length)} controls, ` +
      `${String(COMPLIANCE_CHECKS.length)} probes, ` +
      `${String(coverage)} with probe coverage, ${String(pathsChecked)} cited paths verified\n`
  );

  if (issues.length === 0) {
    process.stdout.write("[check-compliance-controls] no drift\n");
    return 0;
  }

  process.stderr.write(`\n[check-compliance-controls] ${String(issues.length)} issue(s)\n\n`);
  for (const issue of issues) {
    process.stderr.write(`  ${issue.kind}\n    ${issue.detail}\n    remedy: ${issue.remedy}\n\n`);
  }
  return 1;
}

process.exit(main());
