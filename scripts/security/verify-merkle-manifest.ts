#!/usr/bin/env tsx
// scripts/security/verify-merkle-manifest.ts
//
// Auditor / on-call workflow: given a signed Merkle manifest pulled
// from S3 (or a local file copy), re-derive the Merkle root from
// the live audit_log rows and verify the signature against the
// signing identity named in the manifest's `signerKid`.
//
// What this script proves:
//
//   - The audit_log rows in [periodStart, periodEnd) for the org
//     produce the SAME Merkle root that was signed.
//   - The signature is a valid signature OVER the canonical
//     preimage (domain tag || rootHash || orgId || periodStart ||
//     periodEnd) under the public key the operator provides.
//   - The manifest carries the expected domain tag and is within
//     any bounds the auditor supplies.
//
// What this script does NOT prove:
//
//   - That the audit_log chain itself is internally consistent.
//     Use `verify-audit-chain-all-orgs.ts` for the chain replay.
//
// Key material:
//
//   - For ECDSA-P256 manifests (production), pass the SPKI-PEM
//     public key via `--public-key=<path>`. The key SHOULD be the
//     same one `aws kms get-public-key` reports for the signing
//     CMK. Storing the PEM offline (e.g. on the auditor's USB
//     evidence drive) lets them verify without AWS credentials —
//     that's the load-bearing offline-verification property of the
//     decision.
//
//   - For Ed25519 manifests (dev/test), the PEM is what
//     `LocalEd25519Signer.exportPublicMaterial().publicKeyPem`
//     produced when the manifest was signed.
//
// Usage:
//   pnpm tsx scripts/security/verify-merkle-manifest.ts \
//     --manifest=<path|s3-uri> \
//     --public-key=<path-to-pem> \
//     [--period-start-after=YYYY-MM-DD] \
//     [--period-end-before=YYYY-MM-DD]
//
// Exits 0 on a valid manifest, non-zero with a structured reason
// otherwise.

import { readFileSync } from "node:fs";
import { createPublicKey } from "node:crypto";
import { parseArgs } from "node:util";

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
  verifyMerkleManifest,
  type SignedMerkleManifest,
  type SignatureVerifier,
  type VerifierBounds,
} from "@pharmax/security";
import { withSystemContext } from "@pharmax/tenancy";

const USAGE = `
Usage: pnpm tsx scripts/security/verify-merkle-manifest.ts \\
  --manifest=<path|s3://bucket/key> \\
  --public-key=<path-to-pem> \\
  [--period-start-after=YYYY-MM-DD] \\
  [--period-end-before=YYYY-MM-DD]

Required env:
  DATABASE_URL                Postgres connection string.
  PHARMAX_LOCAL_KMS_SEED      >=32 chars.

When --manifest is an s3:// URI, the script reads it via
S3ObjectLockPublisher.fetch(). Required env:
  AWS_REGION                  AWS region of the audit-archive bucket.
  AUDIT_ARCHIVE_S3_BUCKET     Must match the bucket in the URI.
  AUDIT_ARCHIVE_S3_KMS_KEY_ID Required by the publisher constructor.

Exit codes:
  0   manifest valid
  1   manifest invalid (reason printed to stderr)
  2   script-level error (bad args, IO, etc.)
`.trim();

interface ParsedArgs {
  readonly manifestRef: string;
  readonly publicKeyPath: string;
  readonly periodStartAfter?: Date;
  readonly periodEndBefore?: Date;
}

function parseCliArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      manifest: { type: "string" },
      "public-key": { type: "string" },
      "period-start-after": { type: "string" },
      "period-end-before": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help === true) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }

  if (typeof values.manifest !== "string" || values.manifest.length === 0) {
    process.stderr.write("--manifest is required.\n");
    process.exit(2);
  }
  if (typeof values["public-key"] !== "string" || values["public-key"].length === 0) {
    process.stderr.write("--public-key is required.\n");
    process.exit(2);
  }
  const out: ParsedArgs = {
    manifestRef: values.manifest,
    publicKeyPath: values["public-key"],
  };
  return {
    ...out,
    ...(typeof values["period-start-after"] === "string"
      ? { periodStartAfter: parseUtcDate(values["period-start-after"]) }
      : {}),
    ...(typeof values["period-end-before"] === "string"
      ? { periodEndBefore: parseUtcDate(values["period-end-before"]) }
      : {}),
  };
}

function parseUtcDate(raw: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (match === null) {
    process.stderr.write(`Invalid date "${raw}"; expected YYYY-MM-DD.\n`);
    process.exit(2);
  }
  const [, yyyy, mm, dd] = match;
  return new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), 0, 0, 0));
}

async function readManifest(ref: string): Promise<SignedMerkleManifest> {
  if (ref.startsWith("s3://")) {
    const bucket = process.env["AUDIT_ARCHIVE_S3_BUCKET"];
    const region = process.env["AWS_REGION"];
    const kmsKeyId = process.env["AUDIT_ARCHIVE_S3_KMS_KEY_ID"];
    if (typeof bucket !== "string" || bucket.length === 0) {
      process.stderr.write("AUDIT_ARCHIVE_S3_BUCKET is required for s3:// manifests.\n");
      process.exit(2);
    }
    if (typeof region !== "string" || region.length === 0) {
      process.stderr.write("AWS_REGION is required for s3:// manifests.\n");
      process.exit(2);
    }
    if (typeof kmsKeyId !== "string" || kmsKeyId.length === 0) {
      process.stderr.write("AUDIT_ARCHIVE_S3_KMS_KEY_ID is required for s3:// manifests.\n");
      process.exit(2);
    }
    const { S3Client } = await import("@aws-sdk/client-s3");
    const publisher = new S3ObjectLockPublisher({
      bucket,
      region,
      retentionDays: 365, // unused for read-only fetch
      kmsKeyId,
      s3Client: adaptAwsS3SdkClient(new S3Client({ region })),
    });
    const manifest = await publisher.fetch(ref);
    if (manifest === null) {
      process.stderr.write(`Manifest not found at ${ref}.\n`);
      process.exit(2);
    }
    return manifest;
  }
  const raw = readFileSync(ref, "utf8");
  return JSON.parse(raw) as SignedMerkleManifest;
}

function buildVerifier(args: {
  readonly manifest: SignedMerkleManifest;
  readonly publicKeyPath: string;
}): SignatureVerifier {
  const pem = readFileSync(args.publicKeyPath, "utf8");
  const publicKey = createPublicKey(pem);
  const kid = args.manifest.signerKid;
  switch (args.manifest.algorithm) {
    case "ed25519":
      return new LocalEd25519SignatureVerifier({ publicKey, signerKid: kid });
    case "ecdsa_sha_256":
      return new EcdsaP256SignatureVerifier({ publicKey, signerKid: kid });
    case "rsassa_pss_sha_256":
      // Not yet wired: the production signer uses ECDSA today.
      process.stderr.write(
        `Algorithm ${args.manifest.algorithm} is not yet supported by this verifier.\n`
      );
      process.exit(2);

      throw new Error("unreachable");
    default: {
      const exhaustive: never = args.manifest.algorithm;
      throw new Error(`Unknown algorithm: ${String(exhaustive)}`);
    }
  }
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));

  if (typeof process.env["DATABASE_URL"] !== "string") {
    process.stderr.write("DATABASE_URL is required.\n");
    process.exit(2);
  }
  const seed = process.env["PHARMAX_LOCAL_KMS_SEED"];
  if (typeof seed !== "string" || seed.length < 32) {
    process.stderr.write("PHARMAX_LOCAL_KMS_SEED is required (>=32 chars).\n");
    process.exit(2);
  }
  configureCrypto({ kms: new LocalKmsAdapter({ seed }) });

  const logger = loggerNs.createPinoLogger({
    service: "verify-merkle-manifest",
    level: "info",
  });

  const manifest = await readManifest(args.manifestRef);
  const verifier = new MultiKidSignatureVerifier([
    {
      signerKid: manifest.signerKid,
      verifier: buildVerifier({ manifest, publicKeyPath: args.publicKeyPath }),
    },
  ]);

  const bounds: VerifierBounds = {
    ...(args.periodStartAfter !== undefined ? { periodStartAfter: args.periodStartAfter } : {}),
    ...(args.periodEndBefore !== undefined ? { periodEndBefore: args.periodEndBefore } : {}),
  };

  const source = createPrismaAuditChainSource(prisma);
  const result = await withSystemContext("security:verify-merkle-manifest", () =>
    verifyMerkleManifest({
      manifest,
      source,
      signatureVerifier: verifier,
      ...(Object.keys(bounds).length > 0 ? { bounds } : {}),
    })
  );

  if (result.valid) {
    process.stdout.write(
      JSON.stringify(
        {
          valid: true,
          organizationId: manifest.organizationId,
          periodStart: manifest.periodStart,
          periodEnd: manifest.periodEnd,
          leafCount: result.leafCount,
          signerKid: manifest.signerKid,
          algorithm: manifest.algorithm,
          rootHashHex: manifest.rootHashHex,
        },
        null,
        2
      ) + "\n"
    );
    logger.info("merkle.verify.ok", {
      organizationId: manifest.organizationId,
      leafCount: result.leafCount,
    });
    await prisma.$disconnect();
    process.exit(0);
  }

  process.stderr.write(
    JSON.stringify(
      {
        valid: false,
        reason: result.reason,
        detail: result.detail,
        organizationId: manifest.organizationId,
        periodStart: manifest.periodStart,
        periodEnd: manifest.periodEnd,
        signerKid: manifest.signerKid,
      },
      null,
      2
    ) + "\n"
  );
  logger.error("merkle.verify.failed", {
    organizationId: manifest.organizationId,
    reason: result.reason,
  });
  await prisma.$disconnect();
  process.exit(1);
}

main().catch((cause: unknown) => {
  process.stderr.write(`\nFATAL: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exit(2);
});
