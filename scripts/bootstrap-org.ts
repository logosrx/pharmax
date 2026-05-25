#!/usr/bin/env tsx
// scripts/bootstrap-org.ts
//
// Operator CLI for the FIRST end-to-end command on the platform:
// `CreateOrganization`. Drives the bus, lets the handler do its
// transactional work, and prints the resulting ids.
//
//   pnpm bootstrap:org \
//     --slug=acme \
//     --name="Acme Pharmacy" \
//     --admin-email=owner@acme.test \
//     --admin-name="Acme Owner"
//
// Required env:
//   DATABASE_URL  Postgres connection string used by Prisma.
//   DIRECT_URL    Optional; used by Prisma for migrations only.
//
// Exits:
//   0  org created.
//   1  validation failure, slug collision, or unexpected error.
//
// Notes:
//   - Runs inside `withSystemContext("bootstrap:CreateOrganization")`
//     so the tenancy extension allows cross-org writes and audit
//     rows carry the system-context reason.
//   - Uses the singleton `prisma` from `@pharmax/database`. We do
//     NOT apply the tenancy Prisma extension here because the
//     command bus + system-context covers enforcement at the right
//     layer (see packages/tenancy/src/prisma-extension.ts).
//   - This script will NOT seed the system Permission rows. Run
//     `pnpm db:seed` (or a future `pnpm db:seed:permissions`)
//     beforehand on a fresh database.

import { parseArgs } from "node:util";

import { configureCommandBus, executeSystemCommand } from "@pharmax/command-bus";
import { configureCrypto, LocalKmsAdapter } from "@pharmax/crypto";
import { prisma } from "@pharmax/database";
import { CreateOrganization } from "@pharmax/orgs";
import { clock, errors, logger as loggerNs } from "@pharmax/platform-core";
import { withSystemContext } from "@pharmax/tenancy";

const USAGE = `
Usage: pnpm bootstrap:org -- \\
  --slug=<slug> \\
  --name=<display-name> \\
  --admin-email=<email> \\
  --admin-name=<display-name> \\
  [--site-code=<code> --site-name=<name> [--site-timezone=<tz>]]

Required env:
  DATABASE_URL              Postgres connection string.
  PHARMAX_LOCAL_KMS_SEED    >=32-char master seed for the dev KMS
                            adapter. Must match the value used by
                            apps/web and apps/worker — rows
                            encrypted under one seed are
                            undecryptable under another.

Notes:
  --site-code and --site-name MUST be provided together. When both
  are present, CreateOrganization will additionally create a
  PharmacySite row and provision the 7 canonical workflow buckets
  (INBOX, TYPING, PV1, FILL, FINAL, SHIPPING, EMERGENCY) for it —
  in the same transaction as the org create — so the resulting
  tenant can accept its first order immediately.

  Multi-site orgs should omit these flags and provision additional
  sites via the future CreateSite command (one site per call,
  with its own ProvisionDefaultBuckets pass).
`.trim();

interface ParsedArgs {
  readonly slug: string;
  readonly name: string;
  readonly adminEmail: string;
  readonly adminName: string;
  readonly initialSite?: {
    readonly code: string;
    readonly name: string;
    readonly timezone?: string;
  };
}

function parseCliArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      slug: { type: "string" },
      name: { type: "string" },
      "admin-email": { type: "string" },
      "admin-name": { type: "string" },
      "site-code": { type: "string" },
      "site-name": { type: "string" },
      "site-timezone": { type: "string" },
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
  if (typeof values.slug !== "string" || values.slug.length === 0) missing.push("--slug");
  if (typeof values.name !== "string" || values.name.length === 0) missing.push("--name");
  if (typeof values["admin-email"] !== "string" || values["admin-email"].length === 0)
    missing.push("--admin-email");
  if (typeof values["admin-name"] !== "string" || values["admin-name"].length === 0)
    missing.push("--admin-name");

  // --site-code and --site-name must be both-or-neither. Passing one
  // without the other is almost certainly an operator typo and
  // would silently fall back to "no site created" — we'd rather
  // exit non-zero so the operator notices.
  const hasSiteCode =
    typeof values["site-code"] === "string" && (values["site-code"] as string).length > 0;
  const hasSiteName =
    typeof values["site-name"] === "string" && (values["site-name"] as string).length > 0;
  if (hasSiteCode !== hasSiteName) {
    process.stderr.write(
      `--site-code and --site-name must be provided together (got one but not the other).\n\n${USAGE}\n`
    );
    process.exit(1);
  }
  // --site-timezone is meaningless without a site; reject it.
  if (
    typeof values["site-timezone"] === "string" &&
    (values["site-timezone"] as string).length > 0 &&
    !hasSiteCode
  ) {
    process.stderr.write(`--site-timezone requires --site-code and --site-name.\n\n${USAGE}\n`);
    process.exit(1);
  }

  if (missing.length > 0) {
    process.stderr.write(`Missing required argument(s): ${missing.join(", ")}\n\n${USAGE}\n`);
    process.exit(1);
  }

  const parsed: ParsedArgs = {
    slug: values.slug as string,
    name: values.name as string,
    adminEmail: values["admin-email"] as string,
    adminName: values["admin-name"] as string,
    ...(hasSiteCode && hasSiteName
      ? {
          initialSite: {
            code: values["site-code"] as string,
            name: values["site-name"] as string,
            ...(typeof values["site-timezone"] === "string" &&
            (values["site-timezone"] as string).length > 0
              ? { timezone: values["site-timezone"] as string }
              : {}),
          },
        }
      : {}),
  };

  return parsed;
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
    service: "bootstrap-org",
    level: "info",
  });

  // Configure crypto BEFORE the command bus. CreateOrganization
  // doesn't itself encrypt PHI, but future system commands chained
  // from this script (e.g. SeedPermissions, MigratePatient) will,
  // and a misconfigured KMS at command-time is a strictly worse
  // failure mode than at script-boot. Defense in depth.
  configureCrypto({ kms: new LocalKmsAdapter({ seed: kmsSeed }) });

  configureCommandBus({
    prisma,
    clock: clock.systemClock,
    logger,
  });

  logger.info("bootstrap.start", { slug: args.slug });

  try {
    const result = await withSystemContext("bootstrap:CreateOrganization", () =>
      executeSystemCommand(CreateOrganization, {
        slug: args.slug,
        name: args.name,
        initialAdmin: {
          email: args.adminEmail,
          displayName: args.adminName,
        },
        ...(args.initialSite !== undefined ? { initialSite: args.initialSite } : {}),
      })
    );

    logger.info("bootstrap.success", {
      organizationId: result.organizationId,
      adminUserId: result.adminUserId,
      roleCount: result.roleCount,
      initialSiteId: result.initialSiteId ?? null,
      bucketCount:
        result.initialBucketIdsByCode !== undefined
          ? Object.keys(result.initialBucketIdsByCode).length
          : 0,
    });

    // Operator-friendly summary on stdout (logger uses stderr-ish JSON).
    const lines: string[] = [
      "",
      "Organization created:",
      `  organizationId: ${result.organizationId}`,
      `  adminUserId:    ${result.adminUserId}`,
      `  roleCount:      ${result.roleCount}`,
    ];
    if (result.initialSiteId !== undefined) {
      lines.push(`  initialSiteId:  ${result.initialSiteId}`);
      if (result.initialBucketIdsByCode !== undefined) {
        lines.push(
          `  buckets:        ${Object.keys(result.initialBucketIdsByCode).length} provisioned`
        );
        for (const [code, id] of Object.entries(result.initialBucketIdsByCode)) {
          lines.push(`    ${code.padEnd(10, " ")} ${id}`);
        }
      }
    } else {
      lines.push(`  initialSite:    (none — pass --site-code/--site-name to bootstrap one)`);
    }
    process.stdout.write(`${lines.join("\n")}\n`);

    await prisma.$disconnect();
    process.exit(0);
  } catch (cause: unknown) {
    // Translate the structured error hierarchy to a useful CLI
    // message. PHI-safe: only the code / message / metadata that
    // platform-core errors already deem safe to surface.
    if (cause instanceof errors.PharmaxError) {
      logger.error("bootstrap.failed", {
        code: cause.code,
        category: cause.category,
        errorName: cause.name,
        message: cause.message,
        metadata: cause.metadata,
      });
      process.stderr.write(`\n[${cause.code}] ${cause.message}\n`);
    } else {
      logger.error("bootstrap.failed.unknown", {
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
