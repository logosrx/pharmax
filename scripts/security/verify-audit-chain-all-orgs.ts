#!/usr/bin/env tsx
// scripts/security/verify-audit-chain-all-orgs.ts
//
// CI / on-call workflow: for every organization, walk the audit
// chain via `verifyChain` (ADR-0006) AND verify that the most
// recent published Merkle manifest (ADR-0024) still matches the
// live chain. Print a table of (org, chain, merkle) results. Exit
// non-zero on any chain break or any unverifiable manifest.
//
// Why combine the two checks:
//
//   - The chain replay catches in-database tampering: rows whose
//     entryHash no longer matches their canonical content, gaps in
//     seq, or a broken prevHash link.
//
//   - The Merkle verifier catches a more sophisticated attack: a
//     consistent rewrite of the chain AND its head pointer. A
//     mismatch between the live chain's daily root and the signed
//     manifest's root proves the rewrite happened after the
//     manifest was signed.
//
// The two checks are complementary; SOC 2 CC7.2 / PI1.4 evidence
// pulls require both. Run with `--skip-merkle` only if the Merkle
// pipeline is not yet wired in the target environment.
//
// Usage:
//   pnpm tsx scripts/security/verify-audit-chain-all-orgs.ts \
//     [--org-id=<organization-uuid|all>] \
//     [--skip-merkle] \
//     [--public-key=<path>]            # required unless --skip-merkle
//     [--manifest-date=YYYY-MM-DD]     # optional override; defaults to yesterday
//     [--dry-run]
//
// Required env (chain only):
//   DATABASE_URL                Postgres connection string.
//   PHARMAX_LOCAL_KMS_SEED      >=32 chars (envelope encryption seed for dev).
//
// Additional env when --skip-merkle is NOT set:
//   AUDIT_ARCHIVE_S3_BUCKET     Object Lock bucket holding manifests.
//   AUDIT_ARCHIVE_S3_KMS_KEY_ID Bucket SSE-KMS key (required by S3 publisher ctor).
//   AWS_REGION                  Region for the AWS SDK clients.

import { readFileSync } from "node:fs";
import { createPublicKey } from "node:crypto";
import { parseArgs } from "node:util";

import { verifyChain } from "@pharmax/audit";
import { configureCrypto, LocalKmsAdapter } from "@pharmax/crypto";
import { prisma } from "@pharmax/database";
import { logger as loggerNs } from "@pharmax/platform-core";
import {
  EcdsaP256SignatureVerifier,
  LocalEd25519SignatureVerifier,
  MultiKidSignatureVerifier,
  S3ObjectLockPublisher,
  adaptAwsS3SdkClient,
  createPrismaAuditChainSource,
  manifestObjectKey,
  verifyMerkleManifest,
  type SignatureVerifier,
  type SignedMerkleManifest,
  type VerifyManifestResult,
} from "@pharmax/security";
import { withSystemContext } from "@pharmax/tenancy";

const USAGE = `
Usage: pnpm tsx scripts/security/verify-audit-chain-all-orgs.ts \\
  [--org-id=<organization-uuid|all>] \\
  [--skip-merkle] \\
  [--public-key=<path>]                  # required unless --skip-merkle
  [--manifest-date=YYYY-MM-DD]           # defaults to yesterday UTC
  [--dry-run]
`.trim();

interface ParsedArgs {
  readonly orgId: string | null;
  readonly skipMerkle: boolean;
  readonly publicKeyPath: string | null;
  readonly manifestDate: Date;
  readonly dryRun: boolean;
}

function parseCliArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      "org-id": { type: "string" },
      // legacy alias
      org: { type: "string" },
      "skip-merkle": { type: "boolean", default: false },
      "public-key": { type: "string" },
      "manifest-date": { type: "string" },
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
  const orgRaw = (values["org-id"] ?? values.org) as string | undefined;
  const all = typeof orgRaw === "string" && orgRaw.toLowerCase() === "all";
  return {
    orgId: typeof orgRaw === "string" && !all && orgRaw.length > 0 ? orgRaw : null,
    skipMerkle: values["skip-merkle"] === true,
    publicKeyPath:
      typeof values["public-key"] === "string" && values["public-key"].length > 0
        ? values["public-key"]
        : null,
    manifestDate:
      typeof values["manifest-date"] === "string" && values["manifest-date"].length > 0
        ? parseUtcDate(values["manifest-date"])
        : yesterdayUtc(new Date()),
    dryRun: values["dry-run"] === true,
  };
}

function parseUtcDate(raw: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (match === null) {
    process.stderr.write(`Invalid date "${raw}"; expected YYYY-MM-DD.\n`);
    process.exit(1);
  }
  const [, yyyy, mm, dd] = match;
  return new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), 0, 0, 0));
}

function yesterdayUtc(now: Date): Date {
  const utcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(utcMidnight - 86_400_000);
}

interface VerifyRow {
  readonly slug: string;
  readonly organizationId: string;
  readonly chainValid: boolean;
  readonly chainVerifiedRows: number;
  readonly chainLastSeq: string | null;
  readonly chainReason: string | null;
  readonly merkleValid: boolean | null;
  readonly merkleReason: string | null;
  readonly merkleUri: string | null;
}

function formatTable(rows: ReadonlyArray<VerifyRow>): string {
  const lines: string[] = [];
  lines.push(
    [
      "chain",
      "merkle",
      "verifiedRows",
      "lastSeq",
      "slug",
      "organizationId",
      "merkleUri",
      "reason",
    ].join("\t")
  );
  for (const row of rows) {
    const merkleStr = row.merkleValid === null ? "SKIP" : row.merkleValid ? "OK" : "BROKEN";
    const reason = [row.chainReason, row.merkleReason].filter((r) => r !== null).join(" | ");
    lines.push(
      [
        row.chainValid ? "OK" : "BROKEN",
        merkleStr,
        row.chainVerifiedRows.toString(),
        row.chainLastSeq ?? "-",
        row.slug,
        row.organizationId,
        row.merkleUri ?? "-",
        reason,
      ].join("\t")
    );
  }
  return lines.join("\n");
}

function buildVerifierFromPem(args: {
  readonly pemPath: string;
  readonly manifest: SignedMerkleManifest;
}): SignatureVerifier {
  const pem = readFileSync(args.pemPath, "utf8");
  const publicKey = createPublicKey(pem);
  switch (args.manifest.algorithm) {
    case "ed25519":
      return new LocalEd25519SignatureVerifier({
        publicKey,
        signerKid: args.manifest.signerKid,
      });
    case "ecdsa_sha_256":
      return new EcdsaP256SignatureVerifier({
        publicKey,
        signerKid: args.manifest.signerKid,
      });
    case "rsassa_pss_sha_256":
    default:
      throw new Error(`Algorithm not supported by verifier: ${args.manifest.algorithm}`);
  }
}

async function fetchManifestForOrg(args: {
  readonly publisher: S3ObjectLockPublisher;
  readonly bucket: string;
  readonly organizationId: string;
  readonly date: Date;
}): Promise<SignedMerkleManifest | null> {
  const key = manifestObjectKey({
    organizationId: args.organizationId,
    periodStart: args.date,
  });
  const uri = `s3://${args.bucket}/${key}`;
  return args.publisher.fetch(uri);
}

async function verifyMerkleForOrg(args: {
  readonly publisher: S3ObjectLockPublisher;
  readonly bucket: string;
  readonly organizationId: string;
  readonly date: Date;
  readonly publicKeyPath: string;
}): Promise<{
  readonly valid: boolean | null;
  readonly reason: string | null;
  readonly uri: string | null;
}> {
  const key = manifestObjectKey({
    organizationId: args.organizationId,
    periodStart: args.date,
  });
  const uri = `s3://${args.bucket}/${key}`;
  const manifest = await fetchManifestForOrg(args);
  if (manifest === null) {
    return { valid: false, reason: "manifest-not-found", uri };
  }
  const verifier = new MultiKidSignatureVerifier([
    {
      signerKid: manifest.signerKid,
      verifier: buildVerifierFromPem({ pemPath: args.publicKeyPath, manifest }),
    },
  ]);
  const source = createPrismaAuditChainSource(prisma);
  const result: VerifyManifestResult = await withSystemContext(
    "security:verify-merkle-manifest",
    () =>
      verifyMerkleManifest({
        manifest,
        source,
        signatureVerifier: verifier,
      })
  );
  if (result.valid) return { valid: true, reason: null, uri };
  return { valid: false, reason: `${result.reason}: ${result.detail}`, uri };
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

  if (!args.skipMerkle && args.publicKeyPath === null) {
    process.stderr.write(
      "--public-key is required unless --skip-merkle is set. The manifest's signing identity must be verifiable.\n"
    );
    process.exit(1);
  }

  const logger = loggerNs.createPinoLogger({
    service: "verify-audit-chain-all-orgs",
    level: "info",
  });

  const orgs = await withSystemContext("security:list-orgs-for-verify", () =>
    args.orgId === null
      ? prisma.organization.findMany({ select: { id: true, slug: true }, orderBy: { slug: "asc" } })
      : prisma.organization
          .findUnique({ where: { id: args.orgId }, select: { id: true, slug: true } })
          .then((row) => (row === null ? [] : [row]))
  );

  if (orgs.length === 0) {
    process.stderr.write("No organizations matched the filter.\n");
    await prisma.$disconnect();
    process.exit(1);
  }

  // Lazy publisher construction — only built when Merkle verification
  // is requested AND the env is configured.
  let publisher: S3ObjectLockPublisher | null = null;
  let bucket: string | null = null;
  if (!args.skipMerkle) {
    bucket = process.env["AUDIT_ARCHIVE_S3_BUCKET"] ?? null;
    const kmsKeyId = process.env["AUDIT_ARCHIVE_S3_KMS_KEY_ID"];
    const region = process.env["AWS_REGION"];
    if (typeof bucket !== "string" || bucket.length === 0) {
      process.stderr.write("AUDIT_ARCHIVE_S3_BUCKET is required unless --skip-merkle is set.\n");
      process.exit(1);
    }
    if (typeof kmsKeyId !== "string" || kmsKeyId.length === 0) {
      process.stderr.write(
        "AUDIT_ARCHIVE_S3_KMS_KEY_ID is required unless --skip-merkle is set.\n"
      );
      process.exit(1);
    }
    if (typeof region !== "string" || region.length === 0) {
      process.stderr.write("AWS_REGION is required unless --skip-merkle is set.\n");
      process.exit(1);
    }
    const { S3Client } = await import("@aws-sdk/client-s3");
    publisher = new S3ObjectLockPublisher({
      bucket,
      region,
      retentionDays: 365, // unused for read-only fetch
      kmsKeyId,
      s3Client: adaptAwsS3SdkClient(new S3Client({ region })),
    });
  }

  const source = createPrismaAuditChainSource(prisma);
  const rows: VerifyRow[] = [];
  let chainFailures = 0;
  let merkleFailures = 0;

  for (const org of orgs) {
    let chainValid = false;
    let chainVerifiedRows = 0;
    let chainLastSeq: string | null = null;
    let chainReason: string | null = null;
    try {
      const result = await withSystemContext("security:verify-chain", () =>
        verifyChain(source, { organizationId: org.id })
      );
      chainValid = true;
      chainVerifiedRows = result.verifiedRows;
      chainLastSeq = result.lastSeq === null ? null : result.lastSeq.toString();
    } catch (cause) {
      chainFailures += 1;
      chainReason = cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown";
      logger.error("verify.chain.broken", { organizationId: org.id, reason: chainReason });
    }

    let merkleValid: boolean | null = null;
    let merkleReason: string | null = null;
    let merkleUri: string | null = null;
    if (!args.skipMerkle && publisher !== null && bucket !== null && args.publicKeyPath !== null) {
      try {
        const m = await verifyMerkleForOrg({
          publisher,
          bucket,
          organizationId: org.id,
          date: args.manifestDate,
          publicKeyPath: args.publicKeyPath,
        });
        merkleValid = m.valid;
        merkleReason = m.reason;
        merkleUri = m.uri;
        if (m.valid === false) {
          merkleFailures += 1;
          logger.error("verify.merkle.broken", {
            organizationId: org.id,
            reason: m.reason,
            uri: m.uri,
          });
        }
      } catch (cause) {
        merkleFailures += 1;
        merkleValid = false;
        merkleReason = cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown";
        logger.error("verify.merkle.errored", { organizationId: org.id, reason: merkleReason });
      }
    }

    rows.push({
      slug: org.slug,
      organizationId: org.id,
      chainValid,
      chainVerifiedRows,
      chainLastSeq,
      chainReason,
      merkleValid,
      merkleReason,
      merkleUri,
    });
  }

  process.stdout.write(`${formatTable(rows)}\n`);

  if (args.dryRun) {
    logger.info("verify.dry_run", {
      total: rows.length,
      chainFailures,
      merkleFailures,
    });
  }

  await prisma.$disconnect();
  process.exit(chainFailures + merkleFailures > 0 ? 1 : 0);
}

main().catch((cause: unknown) => {
  process.stderr.write(`\nFATAL: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exit(1);
});
