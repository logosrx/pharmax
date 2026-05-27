#!/usr/bin/env tsx
// scripts/security/sign-daily-merkle-root.ts
//
// Sign-and-publish the daily Merkle manifest for one or all
// organizations and one UTC day. Operates as:
//
//   - A daily cron lookalike. Out of the box it signs YESTERDAY's
//     window for every org, matching the worker's nightly loop. Use
//     `--date=YYYY-MM-DD` to back-fill a missed window.
//
//   - A surgical re-run. `--org-id=<uuid>` limits to one org; the
//     S3 Object Lock publisher is idempotent so re-running a day
//     that already shipped returns the existing manifest's
//     metadata WITHOUT touching the bucket.
//
// Modes:
//
//   default (dev/test): `LocalEd25519Signer` with optional
//     deterministic seed from `PHARMAX_AUDIT_SIGNING_SEED`, and the
//     `InMemoryManifestPublisher` (manifests are discarded on exit).
//
//   `--prod` (or `MERKLE_SIGNER_KMS_KEY_ID` + `AUDIT_ARCHIVE_S3_BUCKET`
//     present): `KmsAsymmetricSigner` against AWS KMS, and
//     `S3ObjectLockPublisher` against the audit-archive bucket. The
//     application process holds ONLY `kms:Sign` + `kms:GetPublicKey`
//     on the signing key and `s3:PutObject` on the archive bucket.
//
// Idempotency: the S3 publisher refuses overwrite via Object Lock
// COMPLIANCE + `IfNoneMatch: *`. A second run for the same org+day
// returns the existing manifest's URI without a second PUT. That
// makes this script safe to retry from a cron or on-call alert.
//
// Usage:
//   pnpm tsx scripts/security/sign-daily-merkle-root.ts \
//     [--org-id=<organization-uuid|all>] \
//     [--date=YYYY-MM-DD] \
//     [--prod] \
//     [--dry-run]

import { parseArgs } from "node:util";

import { configureCrypto, LocalKmsAdapter } from "@pharmax/crypto";
import { prisma } from "@pharmax/database";
import { errors, logger as loggerNs } from "@pharmax/platform-core";
import {
  InMemoryManifestPublisher,
  KmsAsymmetricSigner,
  LocalEd25519Signer,
  S3ObjectLockPublisher,
  SIGNING_DOMAIN_TAG,
  adaptAwsKmsSdkClientForSigning,
  adaptAwsS3SdkClient,
  buildSignedMerkleManifest,
  computeDailyMerkleRoot,
  createPrismaAuditChainSource,
  type ManifestPublisher,
  type MerkleRootSigner,
} from "@pharmax/security";
import { withSystemContext } from "@pharmax/tenancy";

const USAGE = `
Usage: pnpm tsx scripts/security/sign-daily-merkle-root.ts \\
  [--org-id=<organization-uuid|all>] \\
  [--date=YYYY-MM-DD] \\
  [--prod] \\
  [--dry-run]

Required env:
  DATABASE_URL                       Postgres connection string.
  PHARMAX_LOCAL_KMS_SEED              >=32 chars (envelope encryption seed for dev).

Dev/test (default) env:
  PHARMAX_AUDIT_SIGNING_SEED          Hex 32-byte seed; deterministic Ed25519.

Production (--prod) env:
  AWS_REGION                          AWS region of the KMS + S3 keys.
  MERKLE_SIGNER_KMS_KEY_ID            Asymmetric KMS key ARN (ECC_NIST_P256, SIGN_VERIFY).
  AUDIT_ARCHIVE_S3_BUCKET             Object Lock COMPLIANCE bucket name.
  AUDIT_ARCHIVE_S3_KMS_KEY_ID         Customer KMS key for SSE-KMS on the bucket.
  AUDIT_ARCHIVE_RETENTION_YEARS       (optional) Default 7.
`.trim();

interface ParsedArgs {
  readonly orgId: string | null;
  readonly all: boolean;
  readonly dateUtc: Date;
  readonly prod: boolean;
  readonly dryRun: boolean;
}

function parseCliArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      "org-id": { type: "string" },
      // legacy alias for --org-id
      org: { type: "string" },
      date: { type: "string" },
      prod: { type: "boolean", default: false },
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

  const orgId = (values["org-id"] ?? values.org) as string | undefined;
  const all = typeof orgId === "string" && orgId.toLowerCase() === "all";

  const dateUtc =
    typeof values.date === "string" && values.date.length > 0
      ? parseUtcDate(values.date)
      : yesterdayUtc(new Date());

  return {
    orgId: typeof orgId === "string" && !all && orgId.length > 0 ? orgId : null,
    all,
    dateUtc,
    prod: values.prod === true,
    dryRun: values["dry-run"] === true,
  };
}

function parseUtcDate(raw: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (match === null) {
    process.stderr.write(`Invalid --date "${raw}"; expected YYYY-MM-DD.\n`);
    process.exit(1);
  }
  const [, yyyy, mm, dd] = match;
  return new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), 0, 0, 0));
}

function yesterdayUtc(now: Date): Date {
  const utcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(utcMidnight - 86_400_000);
}

async function buildSigner(args: ParsedArgs): Promise<MerkleRootSigner> {
  if (args.prod) {
    const arn = process.env["MERKLE_SIGNER_KMS_KEY_ID"];
    const region = process.env["AWS_REGION"];
    if (typeof arn !== "string" || arn.length === 0) {
      process.stderr.write("MERKLE_SIGNER_KMS_KEY_ID is required with --prod.\n");
      process.exit(1);
    }
    if (typeof region !== "string" || region.length === 0) {
      process.stderr.write("AWS_REGION is required with --prod.\n");
      process.exit(1);
    }
    // Lazy SDK import — keeps the dev/test code path SDK-free even
    // when this script is loaded by a typecheck-only run.
    const { KMSClient } = await import("@aws-sdk/client-kms");
    return new KmsAsymmetricSigner({
      keyArn: arn,
      kmsClient: adaptAwsKmsSdkClientForSigning(new KMSClient({ region })),
    });
  }
  const seedHex = process.env["PHARMAX_AUDIT_SIGNING_SEED"];
  if (typeof seedHex === "string" && seedHex.length > 0) {
    const seed = Buffer.from(seedHex, "hex");
    if (seed.length !== 32) {
      process.stderr.write("PHARMAX_AUDIT_SIGNING_SEED must decode to exactly 32 bytes.\n");
      process.exit(1);
    }
    return new LocalEd25519Signer({ seed });
  }
  return new LocalEd25519Signer();
}

async function buildPublisher(args: ParsedArgs): Promise<ManifestPublisher> {
  if (!args.prod) return new InMemoryManifestPublisher();
  const bucket = process.env["AUDIT_ARCHIVE_S3_BUCKET"];
  const kmsKeyId = process.env["AUDIT_ARCHIVE_S3_KMS_KEY_ID"];
  const region = process.env["AWS_REGION"];
  const retentionYears = Number(process.env["AUDIT_ARCHIVE_RETENTION_YEARS"] ?? "7");
  if (typeof bucket !== "string" || bucket.length === 0) {
    process.stderr.write("AUDIT_ARCHIVE_S3_BUCKET is required with --prod.\n");
    process.exit(1);
  }
  if (typeof kmsKeyId !== "string" || kmsKeyId.length === 0) {
    process.stderr.write("AUDIT_ARCHIVE_S3_KMS_KEY_ID is required with --prod.\n");
    process.exit(1);
  }
  if (typeof region !== "string" || region.length === 0) {
    process.stderr.write("AWS_REGION is required with --prod.\n");
    process.exit(1);
  }
  if (!Number.isFinite(retentionYears) || retentionYears < 1) {
    process.stderr.write("AUDIT_ARCHIVE_RETENTION_YEARS must be a positive integer.\n");
    process.exit(1);
  }
  const { S3Client } = await import("@aws-sdk/client-s3");
  return new S3ObjectLockPublisher({
    bucket,
    region,
    retentionDays: retentionYears * 365,
    kmsKeyId,
    s3Client: adaptAwsS3SdkClient(new S3Client({ region })),
  });
}

async function listOrganizations(
  args: ParsedArgs
): Promise<ReadonlyArray<{ id: string; slug: string }>> {
  if (args.orgId !== null) {
    const row = await prisma.organization.findUnique({
      where: { id: args.orgId },
      select: { id: true, slug: true },
    });
    return row === null ? [] : [row];
  }
  return prisma.organization.findMany({
    select: { id: true, slug: true },
    orderBy: { slug: "asc" },
  });
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
    service: "sign-daily-merkle-root",
    level: "info",
  });

  const signer = await buildSigner(args);
  const publisher = await buildPublisher(args);
  const periodStart = args.dateUtc;
  const periodEnd = new Date(periodStart.getTime() + 86_400_000);
  const orgs = await withSystemContext("security:list-orgs-for-signing", () =>
    listOrganizations(args)
  );

  if (orgs.length === 0) {
    process.stderr.write("No organizations matched the filter.\n");
    await prisma.$disconnect();
    process.exit(1);
  }

  logger.info("merkle.run.start", {
    mode: args.prod ? "prod" : "dev",
    dryRun: args.dryRun,
    organizationCount: orgs.length,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
  });

  const source = createPrismaAuditChainSource(prisma);
  let failures = 0;
  let signed = 0;
  let idempotent = 0;

  for (const org of orgs) {
    try {
      const root = await withSystemContext("security:compute-merkle-root", () =>
        computeDailyMerkleRoot({
          organizationId: org.id,
          periodStart,
          periodEnd,
          source,
        })
      );
      const signedOut = await signer.sign({
        rootHash: root.rootHash,
        organizationId: org.id,
        periodStart,
        periodEnd,
      });
      const manifest = buildSignedMerkleManifest({
        organizationId: org.id,
        periodStart,
        periodEnd,
        computedAt: root.computedAt,
        signedAt: signedOut.signedAt,
        leafCount: root.leafCount,
        firstSeq: root.firstSeq,
        lastSeq: root.lastSeq,
        rootHash: root.rootHash,
        signature: signedOut.signature,
        signerKid: signedOut.signerKid,
        algorithm: signedOut.algorithm,
        signingDomainTag: SIGNING_DOMAIN_TAG,
      });

      if (args.dryRun) {
        process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
        logger.info("merkle.dry_run", {
          organizationId: org.id,
          slug: org.slug,
          leafCount: root.leafCount,
        });
        continue;
      }
      const publishResult = await publisher.publish(manifest);
      if (publishResult.idempotent === true) {
        idempotent += 1;
        process.stdout.write(
          `${org.slug}\tIDEMPOTENT\t${publishResult.uri}\tleafCount=${root.leafCount}\n`
        );
      } else {
        signed += 1;
        process.stdout.write(
          `${org.slug}\tSIGNED\t${publishResult.uri}\tleafCount=${root.leafCount}\teTag=${publishResult.eTag ?? "-"}\n`
        );
      }
      logger.info("merkle.published", {
        organizationId: org.id,
        slug: org.slug,
        uri: publishResult.uri,
        eTag: publishResult.eTag ?? null,
        versionId: publishResult.versionId ?? null,
        retainUntil: publishResult.retainUntilDate?.toISOString() ?? null,
        leafCount: root.leafCount,
        firstSeq: root.firstSeq?.toString() ?? null,
        lastSeq: root.lastSeq?.toString() ?? null,
        signerKid: signedOut.signerKid,
        idempotent: publishResult.idempotent === true,
      });
    } catch (cause) {
      failures += 1;
      const code = cause instanceof errors.PharmaxError ? cause.code : "MERKLE_RUN_UNKNOWN";
      const message = cause instanceof Error ? cause.message : "unknown";
      logger.error("merkle.failed", {
        organizationId: org.id,
        slug: org.slug,
        code,
        errorMessage: message,
      });
      process.stderr.write(`[${org.slug}] FAILED [${code}]: ${message}\n`);
    }
  }

  logger.info("merkle.run.complete", {
    organizationCount: orgs.length,
    signed,
    idempotent,
    failures,
  });

  await prisma.$disconnect();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((cause: unknown) => {
  process.stderr.write(`\nFATAL: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exit(1);
});
