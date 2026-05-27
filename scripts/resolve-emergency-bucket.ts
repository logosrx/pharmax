#!/usr/bin/env tsx
// scripts/resolve-emergency-bucket.ts
//
// Operator CLI for dispositioning an order OUT of the EMERGENCY
// bucket after a shipping clerk has triaged the underlying carrier
// exception. The CLI is the canonical operational interface until
// the web operator console lands (Phase 5 frontend slice); the
// future UI will dispatch the same command through an authenticated
// HTTP route.
//
// Usage:
//   pnpm resolve:emergency -- \
//     --order-id=<uuid> \
//     --as-user=<email>            # operator's email (must exist in the org) \
//     --disposition=RETURN_TO_SHIPPING|RETURN_TO_FILL|KEEP_IN_EMERGENCY \
//     [--reason="brief operator note"]
//
// Required env:
//   DATABASE_URL              Postgres connection string.
//   PHARMAX_LOCAL_KMS_SEED    >=32 chars; must match apps/web + apps/worker.
//
// Exits:
//   0  command applied (or already-resolved / no-op).
//   1  validation / RBAC / conflict / unexpected error.
//
// Notes:
//   - Runs inside the standard command bus — same RBAC, audit,
//     outbox, and idempotency guarantees as the production HTTP
//     route that will replace this. The operator's email is
//     resolved to a user row in system context; from there the
//     command runs inside that user's tenancy.
//   - Idempotency key is derived from `(orderId, disposition,
//     timestamp-bucketed-to-the-minute)`. Re-running the CLI with
//     the same args inside the same minute is a no-op (short-circuited
//     by the bus). Re-running after a minute boundary will replay
//     the command — the command's own "already in EMERGENCY" guard
//     catches double-disposition for the bucket-move modes.
//   - PHI: `--reason` may contain operator notes. The command
//     redacts it from `command_log.requestPayload` and surfaces
//     only a boolean `hasReasonText` flag in audit + outbox.

import { parseArgs } from "node:util";

import { configureCommandBus, executeCommand } from "@pharmax/command-bus";
import { configureCrypto, LocalKmsAdapter } from "@pharmax/crypto";
import { prisma } from "@pharmax/database";
import { clock, errors, logger as loggerNs } from "@pharmax/platform-core";
import { ids } from "@pharmax/platform-core";
import {
  ESCALATION_DISPOSITIONS,
  ResolveOrderEscalation,
  type EscalationDisposition,
} from "@pharmax/shipping";
import { buildTenancyContext, withSystemContext, withTenancyContext } from "@pharmax/tenancy";

const USAGE = `
Usage: pnpm resolve:emergency -- \\
  --order-id=<uuid> \\
  --as-user=<email> \\
  --disposition=${ESCALATION_DISPOSITIONS.join("|")} \\
  [--reason="brief operator note"]

Required env:
  DATABASE_URL              Postgres connection string.
  PHARMAX_LOCAL_KMS_SEED    >=32 chars; must match apps/web + apps/worker.
`.trim();

interface ParsedArgs {
  readonly orderId: string;
  readonly asUserEmail: string;
  readonly disposition: EscalationDisposition;
  readonly reasonText?: string;
}

function parseCliArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      "order-id": { type: "string" },
      "as-user": { type: "string" },
      disposition: { type: "string" },
      reason: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help === true) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }

  const missing: string[] = [];
  if (typeof values["order-id"] !== "string" || values["order-id"].length === 0)
    missing.push("--order-id");
  if (typeof values["as-user"] !== "string" || values["as-user"].length === 0)
    missing.push("--as-user");
  if (typeof values.disposition !== "string" || values.disposition.length === 0)
    missing.push("--disposition");
  if (missing.length > 0) {
    process.stderr.write(`Missing required argument(s): ${missing.join(", ")}\n\n${USAGE}\n`);
    process.exit(1);
  }

  const disposition = values.disposition as string;
  if (!ESCALATION_DISPOSITIONS.includes(disposition as EscalationDisposition)) {
    process.stderr.write(
      `--disposition must be one of: ${ESCALATION_DISPOSITIONS.join(", ")} (got "${disposition}").\n`
    );
    process.exit(1);
  }

  const reason = values.reason;
  return {
    orderId: values["order-id"] as string,
    asUserEmail: values["as-user"] as string,
    disposition: disposition as EscalationDisposition,
    ...(typeof reason === "string" && reason.length > 0 ? { reasonText: reason } : {}),
  };
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));

  if (typeof process.env["DATABASE_URL"] !== "string") {
    process.stderr.write("DATABASE_URL is required.\n");
    process.exit(1);
  }
  const kmsSeed = process.env["PHARMAX_LOCAL_KMS_SEED"];
  if (typeof kmsSeed !== "string" || kmsSeed.length < 32) {
    process.stderr.write("PHARMAX_LOCAL_KMS_SEED is required (>=32 chars). See .env.example.\n");
    process.exit(1);
  }

  const logger = loggerNs.createPinoLogger({
    service: "resolve-emergency-bucket",
    level: "info",
  });

  // Crypto first — ResolveOrderEscalation itself does not touch
  // PHI, but configuring the bus without crypto wired is a
  // strictly worse failure mode if any chained-future command does.
  configureCrypto({ kms: new LocalKmsAdapter({ seed: kmsSeed }) });
  configureCommandBus({
    prisma,
    clock: clock.systemClock,
    logger,
  });

  // Resolve operator email → (userId, organizationId) in system
  // context. We need the org id to enter tenancy and the user id
  // to populate `ctx.actor.userId` on the command.
  const target = await withSystemContext("resolve-emergency:user-lookup", async () => {
    const user = await prisma.user.findFirst({
      where: { email: args.asUserEmail },
      select: { id: true, organizationId: true, status: true },
    });
    return user;
  });
  if (target === null) {
    process.stderr.write(
      `No user found with email "${args.asUserEmail}". Pass the operator's full email.\n`
    );
    process.exit(1);
  }
  if (target.status !== "ACTIVE") {
    process.stderr.write(
      `User "${args.asUserEmail}" is not ACTIVE (status=${target.status}). Aborting.\n`
    );
    process.exit(1);
  }

  // Minute-bucketed idempotency key: re-running the CLI with the
  // same args within a 60s window is a no-op. Cross-minute repeats
  // still hit the command's "not in emergency" guard.
  const minuteBucket = Math.floor(Date.now() / 60_000);
  const idempotencyKey = `cli:resolve:${args.orderId}:${args.disposition}:${minuteBucket}`;

  const tenancy = buildTenancyContext({
    organizationId: target.organizationId,
    actor: { userId: target.id, correlationId: ids.generateUlid() },
  });

  logger.info("resolve.start", {
    orderId: args.orderId,
    disposition: args.disposition,
    asUserId: target.id,
  });

  try {
    const result = await withTenancyContext(tenancy, () =>
      executeCommand(
        ResolveOrderEscalation,
        {
          orderId: args.orderId,
          disposition: args.disposition,
          ...(args.reasonText !== undefined ? { reasonText: args.reasonText } : {}),
        },
        { idempotencyKey }
      )
    );

    logger.info("resolve.success", {
      orderId: result.orderId,
      disposition: result.disposition,
      previousBucketId: result.previousBucketId,
      newBucketId: result.newBucketId,
      bucketUnchanged: result.bucketUnchanged,
      version: result.version,
    });

    const lines: string[] = [
      "",
      "Order escalation resolved:",
      `  orderId:          ${result.orderId}`,
      `  disposition:      ${result.disposition}`,
      `  bucketUnchanged:  ${result.bucketUnchanged}`,
      `  previousBucketId: ${result.previousBucketId}`,
      `  newBucketId:      ${result.newBucketId}`,
      `  version:          ${result.version}`,
    ];
    process.stdout.write(`${lines.join("\n")}\n`);

    await prisma.$disconnect();
    process.exit(0);
  } catch (cause: unknown) {
    if (cause instanceof errors.PharmaxError) {
      logger.error("resolve.failed", {
        code: cause.code,
        category: cause.category,
        message: cause.message,
        metadata: cause.metadata,
      });
      process.stderr.write(`\n[${cause.code}] ${cause.message}\n`);
    } else {
      logger.error("resolve.failed.unknown", {
        errorName: cause instanceof Error ? cause.name : "Unknown",
        errorMessage: cause instanceof Error ? cause.message : String(cause),
      });
      process.stderr.write(`\nUnexpected error.\n`);
    }
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  }
}

main();
