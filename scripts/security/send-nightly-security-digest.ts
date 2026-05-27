#!/usr/bin/env tsx
// scripts/security/send-nightly-security-digest.ts
//
// Compose the nightly security digest and print the rendered text to
// stdout. The production transport (Resend or SES) is OUT OF SCOPE
// for this lane — the script wires the `InMemoryDigestPublisher`
// today so the digest's content can be reviewed before a real SMTP
// integration lands.
//
// Probes used today:
//   - Audit chain: per-org `verifyChain` over the configured
//     ChainSource.
//   - Break-glass sessions: stubbed (returns empty) until the
//     `break_glass_session` migration lands.
//   - Failed logins: stubbed (returns empty) until the Clerk
//     `clerk.session.failed.v1` outbox handler is wired.
//   - Outbox: counts of `OutboxStatus = "DEAD"` rows in the window.
//   - Sentry: stubbed (returns 0) until the Sentry API adapter lands.
//   - Access reviews: stubbed (returns empty) — production reads
//     last-modified time of `evidence/access-reviews/<period>/`
//     against a per-org schedule.
//
// Usage:
//   pnpm tsx scripts/security/send-nightly-security-digest.ts \
//     [--window-hours=24] \
//     [--dry-run]
//
// Exits 0 on success; non-zero only on probe failure.

import { parseArgs } from "node:util";

import { configureCrypto, LocalKmsAdapter } from "@pharmax/crypto";
import { prisma } from "@pharmax/database";
import { logger as loggerNs } from "@pharmax/platform-core";
import {
  composeNightlySecurityDigest,
  InMemoryDigestPublisher,
  renderDigestAsText,
} from "@pharmax/security";

import { verifyChainProbeFromPrisma } from "./security-digest-probes.js";

const USAGE = `
Usage: pnpm tsx scripts/security/send-nightly-security-digest.ts \\
  [--window-hours=24] \\
  [--dry-run]

Required env:
  DATABASE_URL              Postgres connection string.
  PHARMAX_LOCAL_KMS_SEED    >=32 chars.
`.trim();

interface ParsedArgs {
  readonly windowHours: number;
  readonly dryRun: boolean;
}

function parseCliArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      "window-hours": { type: "string", default: "24" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help === true) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  const windowHoursRaw = values["window-hours"];
  const windowHours = Number(typeof windowHoursRaw === "string" ? windowHoursRaw : 24);
  if (!Number.isFinite(windowHours) || windowHours <= 0) {
    process.stderr.write("--window-hours must be a positive number.\n");
    process.exit(1);
  }
  return { windowHours, dryRun: values["dry-run"] === true };
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));

  if (typeof process.env["DATABASE_URL"] !== "string") {
    process.stderr.write("DATABASE_URL is required.\n");
    process.exit(1);
  }
  const seed = process.env["PHARMAX_LOCAL_KMS_SEED"];
  if (typeof seed !== "string" || seed.length < 32) {
    process.stderr.write("PHARMAX_LOCAL_KMS_SEED is required (>=32 chars).\n");
    process.exit(1);
  }
  configureCrypto({ kms: new LocalKmsAdapter({ seed }) });

  const logger = loggerNs.createPinoLogger({
    service: "send-nightly-security-digest",
    level: "info",
  });

  const publisher = new InMemoryDigestPublisher();
  const digest = await composeNightlySecurityDigest({
    logger,
    now: new Date(),
    windowHours: args.windowHours,
    probes: {
      auditChain: verifyChainProbeFromPrisma(prisma),
      breakGlass: {
        async listOpenedInWindow() {
          return [];
        },
      },
      failedLogins: {
        async listSpikes() {
          return [];
        },
      },
      outbox: outboxStatusProbeFromPrisma(),
      sentry: {
        async fetchErrorVolume() {
          return { project: "pharmacy-os", errorCount: 0, windowHours: args.windowHours };
        },
      },
      accessReviewCalendar: {
        async listDueWithinDays() {
          return [];
        },
      },
    },
  });

  const text = renderDigestAsText(digest);
  if (args.dryRun) {
    process.stdout.write(`${text}\n`);
  } else {
    const publishResult = await publisher.publish(digest, text);
    process.stdout.write(`${text}\n`);
    process.stdout.write(`(captured: ${publishResult.transportId})\n`);
  }

  await prisma.$disconnect();
  process.exit(0);
}

function outboxStatusProbeFromPrisma(): {
  listDeadCounts(args: {
    readonly windowStart: Date;
    readonly windowEnd: Date;
  }): Promise<ReadonlyArray<{ readonly organizationId: string; readonly deadCount: number }>>;
} {
  return {
    async listDeadCounts(args) {
      const rows = await prisma.eventOutbox.groupBy({
        by: ["organizationId"],
        where: {
          status: "DEAD",
          createdAt: { gte: args.windowStart, lt: args.windowEnd },
        },
        _count: { _all: true },
      });
      return rows.map((row) => ({
        organizationId: row.organizationId,
        deadCount: row._count._all,
      }));
    },
  };
}

main().catch((cause: unknown) => {
  process.stderr.write(`\nFATAL: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exit(1);
});
