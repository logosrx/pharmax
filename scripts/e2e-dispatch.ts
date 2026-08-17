#!/usr/bin/env tsx
// scripts/e2e-dispatch.ts
//
// Dispatch a single workflow command through the REAL command bus for
// the Playwright full-dispense suite. Exists because four commands
// have no ops-console surface — there is no /api/ops route (and no
// UI) for PlaceHold, ReleaseHold, or CancelOrder, and
// ConfirmVialLabelPrint is only ever issued by the print-agent daemon
// (apps/print-agent), which does not run in CI — and the workflow
// safety rules forbid faking those transitions with direct DB status
// writes. Everything here goes through executeCommand, so command_log,
// order_event, audit_log, and event_outbox rows are produced exactly
// as production would produce them.
//
// Actors:
//   - place-hold / release-hold / cancel-order run as the seeded E2E
//     pharmacist (e2e-pharmacist@acme.test): the Pharmacist role
//     template carries orders.place_hold, orders.release_hold, and
//     orders.cancel, so no extra grants are needed and RBAC is
//     exercised for real.
//   - confirm-vial-label-print runs as the seeded E2E tech
//     (e2e-tech@acme.test) at the demo workstation WS-01 — the
//     PharmacyTechnician template carries labels.confirm_print and
//     the command requires a workstation, exactly like the agent's
//     confirmation callback in production.
//
// Usage (spawned by e2e/tests/full-dispense.spec.ts):
//
//   pnpm tsx scripts/e2e-dispatch.ts place-hold   <orderId> <reason>
//   pnpm tsx scripts/e2e-dispatch.ts release-hold <orderId> <releaseReason>
//   pnpm tsx scripts/e2e-dispatch.ts cancel-order <orderId> <dispositionReason>
//   pnpm tsx scripts/e2e-dispatch.ts confirm-vial-label-print <orderId> COMPLETED
//
// Prints the command output as JSON on success; exits non-zero with
// the PharmaxError code on refusal.
//
// Required env: DATABASE_URL, PHARMAX_LOCAL_KMS_SEED (or the e2e
// defaults from e2e/env.ts apply).

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";

import { configureCommandBus, executeCommand } from "@pharmax/command-bus";
import { configureCrypto, LocalKmsAdapter } from "@pharmax/crypto";
import { prisma, PrintJobStatus } from "@pharmax/database";
import { ConfirmVialLabelPrint } from "@pharmax/labels";
import {
  CancelOrder,
  PlaceHold,
  ReleaseHold,
  type CancelOrderInput,
  type PlaceHoldInput,
  type ReleaseHoldInput,
} from "@pharmax/orders";
import { clock, errors, logger as loggerNs } from "@pharmax/platform-core";
import { configureRbac, PrismaPermissionLoader } from "@pharmax/rbac";
import { buildTenancyContext, withSystemContext, withTenancyContext } from "@pharmax/tenancy";

import {
  E2E_KMS_SEED,
  E2E_OPERATOR_EMAIL,
  E2E_STATE_FILE,
  E2E_TECH_EMAIL,
  type E2ESeedState,
} from "../e2e/env";

const ACTIONS = ["place-hold", "release-hold", "cancel-order", "confirm-vial-label-print"] as const;
type Action = (typeof ACTIONS)[number];

function isAction(value: string): value is Action {
  return (ACTIONS as ReadonlyArray<string>).includes(value);
}

async function main(): Promise<void> {
  const [, , action, orderId, reason] = process.argv;
  if (action === undefined || !isAction(action) || orderId === undefined || reason === undefined) {
    process.stderr.write(
      `Usage: e2e-dispatch.ts <${ACTIONS.join("|")}> <orderId> <reason>\n` +
        "Run scripts/e2e-seed.ts first (e2e/setup.ts does)."
    );
    process.exit(2);
  }

  const kmsSeed = process.env["PHARMAX_LOCAL_KMS_SEED"] ?? E2E_KMS_SEED;
  const logger = loggerNs.createPinoLogger({ service: "e2e-dispatch", level: "warn" });
  configureCrypto({ kms: new LocalKmsAdapter({ seed: kmsSeed }) });
  configureRbac({ loader: new PrismaPermissionLoader(prisma) });
  configureCommandBus({ prisma, clock: clock.systemClock, logger });

  const state = JSON.parse(readFileSync(E2E_STATE_FILE, "utf8")) as E2ESeedState;

  const actorEmail = action === "confirm-vial-label-print" ? E2E_TECH_EMAIL : E2E_OPERATOR_EMAIL;

  const { actorUserId, workstationId } = await withSystemContext(
    "scripts:e2e-dispatch:resolve-actor",
    async () => {
      const user = await prisma.user.findUnique({
        where: {
          organizationId_email: {
            organizationId: state.organizationId,
            email: actorEmail,
          },
        },
        select: { id: true },
      });
      if (user === null) {
        throw new Error(`${actorEmail} not found — run scripts/e2e-seed.ts first.`);
      }
      if (action !== "confirm-vial-label-print") {
        return { actorUserId: user.id, workstationId: undefined };
      }
      // ConfirmVialLabelPrint requires a workstation-bound context, the
      // same as the print-agent's confirmation in production. WS-01 is
      // the demo workstation prisma/seed.ts creates at the demo site.
      const workstation = await prisma.workstation.findUnique({
        where: { siteId_code: { siteId: state.siteId, code: "WS-01" } },
        select: { id: true },
      });
      if (workstation === null) {
        throw new Error("Workstation WS-01 not found — run pnpm db:seed first.");
      }
      return { actorUserId: user.id, workstationId: workstation.id };
    }
  );

  const ctx = buildTenancyContext({
    organizationId: state.organizationId,
    siteId: state.siteId,
    clinicId: state.clinicId,
    ...(workstationId === undefined ? {} : { workstationId }),
    actor: { userId: actorUserId, correlationId: randomUUID() },
  });

  const output = await withTenancyContext(ctx, async (): Promise<unknown> => {
    const opts = { idempotencyKey: `e2e-dispatch:${action}:${orderId}:${randomUUID()}` };
    // The casts narrow the CLI string to each command's reason enum;
    // the command's Zod schema still validates the actual value and
    // refuses anything outside the registry.
    switch (action) {
      case "place-hold":
        return executeCommand(
          PlaceHold,
          { orderId, reason: reason as PlaceHoldInput["reason"] },
          opts
        );
      case "release-hold":
        return executeCommand(
          ReleaseHold,
          { orderId, releaseReason: reason as ReleaseHoldInput["releaseReason"] },
          opts
        );
      case "cancel-order":
        return executeCommand(
          CancelOrder,
          { orderId, dispositionReason: reason as CancelOrderInput["dispositionReason"] },
          opts
        );
      case "confirm-vial-label-print": {
        if (reason !== "COMPLETED") {
          throw new Error("confirm-vial-label-print only supports status COMPLETED in e2e.");
        }
        // Resolve the order's active (PENDING/SENT) vial-label print
        // job — the one PrintVialLabel just queued from the workbench.
        const printJob = await prisma.printJob.findFirst({
          where: {
            organizationId: state.organizationId,
            orderId,
            status: { in: [PrintJobStatus.PENDING, PrintJobStatus.SENT] },
          },
          orderBy: { createdAt: "desc" },
          select: { id: true },
        });
        if (printJob === null) {
          throw new Error(`No PENDING/SENT print job found for order ${orderId}.`);
        }
        return executeCommand(
          ConfirmVialLabelPrint,
          { printJobId: printJob.id, status: "COMPLETED" },
          opts
        );
      }
      default: {
        const exhaustive: never = action;
        throw new Error(`Unhandled action: ${String(exhaustive)}`);
      }
    }
  });

  process.stdout.write(`${JSON.stringify(output)}\n`);
  await prisma.$disconnect();
}

main().catch(async (cause: unknown) => {
  if (cause instanceof errors.PharmaxError) {
    process.stderr.write(`[${cause.code}] ${cause.message}\n`);
  } else {
    process.stderr.write(
      `${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}\n`
    );
  }
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
