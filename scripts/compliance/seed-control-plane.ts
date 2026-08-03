#!/usr/bin/env tsx
// scripts/compliance/seed-control-plane.ts
//
// Loads the compliance control plane from the documents that already
// describe it:
//
//   docs/soc2/controls-inventory.md            → controls + criteria
//   docs/soc2/trust-service-criteria-mapping.md → criterion titles
//   @pharmax/compliance check registry          → automated checks
//
// The markdown stays the human-editable source of truth. This script
// makes the database agree with it, so a status flip is edited in one
// place and the monitoring plane follows.
//
// Idempotent: every write is an upsert keyed on a stable business
// code, so running it twice changes nothing. Safe to run on every
// deploy.
//
// What this script will NOT do:
//
//   - Delete. A control removed from the markdown is REPORTED, not
//     dropped. Deleting compliance rows on the strength of a document
//     edit would silently discard the check runs and sign-offs
//     attached to them; retiring a control is a deliberate act
//     (status → DEPRECATED) with a successor recorded.
//
//   - Overwrite human decisions. `lastSignedOffAt` /
//     `lastSignedOffByUserId` are never touched, and an existing
//     check's `enabled` flag and interval are left alone: an operator
//     who disabled a noisy probe or slowed its cadence does not want
//     the next deploy to quietly re-enable it.
//
//   - Invent criterion text. `requirementText` is left NULL — the
//     AICPA TSC wording is copyrighted and must be transcribed by a
//     human who holds the license, not generated to fill a column.
//
// Usage:
//   pnpm exec tsx scripts/compliance/seed-control-plane.ts [--dry-run]
//
// Required env:
//   DATABASE_URL              Postgres connection string.
//   PHARMAX_LOCAL_KMS_SEED    >=32 chars (required at boot by
//                             @pharmax/crypto; nothing here encrypts).
//
// Exits:
//   0  Seed applied (or previewed with --dry-run).
//   1  Parse failure, or a control/criterion drift that needs a human.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  COMPLIANCE_CHECKS,
  parseControlsInventory,
  parseCriteriaFamilies,
  resolveCriterionTitle,
  type ParsedControl,
} from "@pharmax/compliance";
import { configureCrypto, LocalKmsAdapter } from "@pharmax/crypto";
import { prisma } from "@pharmax/database";
import { withSystemContext } from "@pharmax/tenancy";

const USAGE = `
Usage: pnpm exec tsx scripts/compliance/seed-control-plane.ts [--dry-run]

Seeds compliance_criterion, compliance_control, compliance_check and
their crosswalks from docs/soc2/ plus the code check registry.
Idempotent; never deletes.
`.trim();

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const INVENTORY_PATH = resolve(REPO_ROOT, "docs/soc2/controls-inventory.md");
const MAPPING_PATH = resolve(REPO_ROOT, "docs/soc2/trust-service-criteria-mapping.md");

interface Tally {
  criteriaCreated: number;
  criteriaUpdated: number;
  controlsCreated: number;
  controlsUpdated: number;
  mappingsCreated: number;
  checksCreated: number;
  checksUpdated: number;
  checkControlLinks: number;
  orphanedControls: string[];
  unmappedCheckControls: string[];
}

/**
 * Compose the control's notes column. Preserves the inventory note
 * verbatim and appends the original cadence text when the cell held
 * more than one term, since the enum column can only carry one.
 */
function composeNotes(control: ParsedControl): string | null {
  const parts: string[] = [];
  if (control.notes !== null) parts.push(control.notes);
  if (control.cadenceRaw.includes(",")) {
    parts.push(`Review cadence (as documented): ${control.cadenceRaw}.`);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help === true) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const dryRun = values["dry-run"] === true;

  if (typeof process.env["DATABASE_URL"] !== "string") {
    process.stderr.write("DATABASE_URL is required.\n");
    process.exit(1);
  }
  // @pharmax/crypto refuses to boot unconfigured; nothing here
  // encrypts, but importing @pharmax/database pulls it in.
  const kmsSeed = process.env["PHARMAX_LOCAL_KMS_SEED"];
  if (typeof kmsSeed !== "string" || kmsSeed.length < 32) {
    process.stderr.write("PHARMAX_LOCAL_KMS_SEED is required (>=32 chars).\n");
    process.exit(1);
  }
  configureCrypto({ kms: new LocalKmsAdapter({ seed: kmsSeed }) });

  const controls = parseControlsInventory(readFileSync(INVENTORY_PATH, "utf8"));
  const families = parseCriteriaFamilies(readFileSync(MAPPING_PATH, "utf8"));

  const tally: Tally = {
    criteriaCreated: 0,
    criteriaUpdated: 0,
    controlsCreated: 0,
    controlsUpdated: 0,
    mappingsCreated: 0,
    checksCreated: 0,
    checksUpdated: 0,
    checkControlLinks: 0,
    orphanedControls: [],
    unmappedCheckControls: [],
  };

  // Distinct criteria, in first-seen order.
  const criteria = new Map<string, { code: string; category: string }>();
  for (const control of controls) {
    if (!criteria.has(control.criterionCode)) {
      criteria.set(control.criterionCode, {
        code: control.criterionCode,
        category: control.category,
      });
    }
  }

  process.stdout.write(
    `Parsed ${controls.length} controls across ${criteria.size} criteria ` +
      `from docs/soc2/controls-inventory.md.\n` +
      `Registered probes in code: ${COMPLIANCE_CHECKS.length}.\n` +
      `${dryRun ? "DRY RUN — no writes.\n" : ""}\n`
  );

  if (dryRun) {
    for (const control of controls) {
      process.stdout.write(
        `  ${control.code.padEnd(10)} ${control.status.padEnd(15)} ` +
          `${control.cadence.padEnd(11)} ${control.ownerRole}\n`
      );
    }
    await reportDrift(controls, tally);
    printTally(tally, dryRun);
    return;
  }

  await withSystemContext("script:compliance:seed-control-plane", async () => {
    const criterionIdByCode = new Map<string, string>();

    for (const criterion of criteria.values()) {
      const existing = await prisma.complianceCriterion.findUnique({
        where: { framework_code: { framework: "SOC2_TSC", code: criterion.code } },
        select: { id: true },
      });
      const row = await prisma.complianceCriterion.upsert({
        where: { framework_code: { framework: "SOC2_TSC", code: criterion.code } },
        create: {
          framework: "SOC2_TSC",
          code: criterion.code,
          title: resolveCriterionTitle(criterion.code, families),
          category: criterion.category,
          // requirementText intentionally omitted — see header.
        },
        update: {
          title: resolveCriterionTitle(criterion.code, families),
          category: criterion.category,
        },
        select: { id: true },
      });
      criterionIdByCode.set(criterion.code, row.id);
      if (existing === null) tally.criteriaCreated += 1;
      else tally.criteriaUpdated += 1;
    }

    const controlIdByCode = new Map<string, string>();

    for (const control of controls) {
      const existing = await prisma.complianceControl.findUnique({
        where: { code: control.code },
        select: { id: true },
      });
      const row = await prisma.complianceControl.upsert({
        where: { code: control.code },
        create: {
          code: control.code,
          title: control.title,
          // The inventory carries one prose column. Rather than
          // fabricate a longer narrative, description starts equal to
          // the title; a fuller one is authored later through the UI.
          description: control.title,
          ownerRole: control.ownerRole,
          status: control.status,
          cadence: control.cadence,
          notes: composeNotes(control),
          implementationRefs: [...control.implementationRefs],
        },
        update: {
          title: control.title,
          ownerRole: control.ownerRole,
          status: control.status,
          cadence: control.cadence,
          notes: composeNotes(control),
          implementationRefs: [...control.implementationRefs],
          // description, lastSignedOffAt, lastSignedOffByUserId and
          // replacedByControlId are deliberately NOT updated: they
          // hold human-authored or human-attested state that the
          // document does not carry.
        },
        select: { id: true },
      });
      controlIdByCode.set(control.code, row.id);
      if (existing === null) tally.controlsCreated += 1;
      else tally.controlsUpdated += 1;

      const criterionId = criterionIdByCode.get(control.criterionCode);
      if (criterionId !== undefined) {
        const link = await prisma.complianceControlCriterion.findUnique({
          where: { controlId_criterionId: { controlId: row.id, criterionId } },
          select: { id: true },
        });
        if (link === null) {
          await prisma.complianceControlCriterion.create({
            data: { controlId: row.id, criterionId },
          });
          tally.mappingsCreated += 1;
        }
      }
    }

    // Checks come from the code registry, never from the markdown —
    // a probe is executable logic, so its definition ships with the
    // deploy that contains the implementation.
    for (const check of COMPLIANCE_CHECKS) {
      const existing = await prisma.complianceCheck.findUnique({
        where: { code: check.code },
        select: { id: true },
      });
      const row = await prisma.complianceCheck.upsert({
        where: { code: check.code },
        create: {
          code: check.code,
          title: check.title,
          description: check.description,
          severity: check.severity,
          cadence: check.cadence,
          intervalMinutes: check.intervalMinutes,
          automated: true,
        },
        update: {
          title: check.title,
          description: check.description,
          severity: check.severity,
          cadence: check.cadence,
          // `intervalMinutes` and `enabled` are NOT updated. Both are
          // operator dials; the code value seeds them and then the
          // operator owns them. Re-asserting the code default here
          // would silently undo "we turned this down because it was
          // noisy at 3am" on the next deploy.
        },
        select: { id: true },
      });
      if (existing === null) tally.checksCreated += 1;
      else tally.checksUpdated += 1;

      for (const controlCode of check.controlCodes) {
        const controlId = controlIdByCode.get(controlCode);
        if (controlId === undefined) {
          tally.unmappedCheckControls.push(`${check.code} → ${controlCode}`);
          continue;
        }
        const link = await prisma.complianceCheckControl.findUnique({
          where: { checkId_controlId: { checkId: row.id, controlId } },
          select: { id: true },
        });
        if (link === null) {
          await prisma.complianceCheckControl.create({
            data: { checkId: row.id, controlId },
          });
          tally.checkControlLinks += 1;
        }
      }
    }

    await reportDrift(controls, tally);
  });

  printTally(tally, dryRun);

  // A check pointing at a control code that does not exist means the
  // probe is producing evidence for nothing. Fail the run so it is
  // fixed in the same change that introduced it.
  if (tally.unmappedCheckControls.length > 0) {
    process.exitCode = 1;
  }
}

/**
 * Report controls that exist in the database but no longer appear in
 * the document. Never deletes them — see the header. This is the
 * signal that someone edited the inventory without going through the
 * deprecation path.
 */
async function reportDrift(controls: readonly ParsedControl[], tally: Tally): Promise<void> {
  const documented = new Set(controls.map((c) => c.code));
  const persisted = await prisma.complianceControl.findMany({
    select: { code: true, status: true },
  });
  for (const row of persisted) {
    if (!documented.has(row.code) && row.status !== "DEPRECATED") {
      tally.orphanedControls.push(row.code);
    }
  }
}

function printTally(tally: Tally, dryRun: boolean): void {
  if (dryRun) {
    process.stdout.write("\nDry run complete — no rows written.\n");
  } else {
    process.stdout.write(
      `\nCriteria:  ${tally.criteriaCreated} created, ${tally.criteriaUpdated} updated\n` +
        `Controls:  ${tally.controlsCreated} created, ${tally.controlsUpdated} updated\n` +
        `Mappings:  ${tally.mappingsCreated} created\n` +
        `Checks:    ${tally.checksCreated} created, ${tally.checksUpdated} updated\n` +
        `Check→control links: ${tally.checkControlLinks} created\n`
    );
  }

  if (tally.orphanedControls.length > 0) {
    process.stdout.write(
      `\nWARNING — ${tally.orphanedControls.length} control(s) exist in the database but ` +
        `not in the inventory:\n` +
        tally.orphanedControls.map((code) => `  ${code}\n`).join("") +
        `They were NOT deleted. Retire a control by setting its status to Deprecated in\n` +
        `docs/soc2/controls-inventory.md, which preserves its evidence history.\n`
    );
  }

  if (tally.unmappedCheckControls.length > 0) {
    process.stdout.write(
      `\nERROR — ${tally.unmappedCheckControls.length} check(s) reference a control code ` +
        `that does not exist:\n` +
        tally.unmappedCheckControls.map((entry) => `  ${entry}\n`).join("") +
        `The probe runs but its evidence attaches to nothing. Fix the controlCodes on the\n` +
        `check definition, or add the control to the inventory.\n`
    );
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    await prisma.$disconnect();
    process.exit(1);
  });
