// S3PackagePhotoStorage — production adapter for the
// `PackagePhotoStorage` port.
//
// Responsibilities:
//
//   1. `beginUpload(...)` — write the photo bytes to S3 under
//      SSE-KMS, then persist a row in `package_photo_upload_token`
//      so the dispatch step can resolve the opaque token back to
//      its storage tuple.
//
//   2. `resolveUploadToken(token)` — read the token row, gate on
//      `expiresAt`, return the storage tuple. The command then
//      cross-checks `organizationId` against the active tenancy
//      (defense-in-depth — see CapturePackagePhoto).
//
// Why two storage layers (S3 + Postgres row):
//
//   The port's `resolveUploadToken(token)` contract takes ONLY
//   the opaque token. The web tier is multi-instance; the upload
//   and dispatch may land on different nodes. A Postgres row is
//   the only mechanism that gives us (a) cross-instance
//   visibility, (b) crash-safe durability, (c) tenant-isolated
//   reads via RLS, and (d) a clean TTL story for janitor cleanup.
//   In-memory Maps cannot do any of these.
//
// AWS surface dependency:
//
//   This file ONLY imports the narrow `S3UploadClient` port
//   defined below. The composition root in apps/web instantiates
//   a real `@aws-sdk/client-s3` `S3Client` and adapts it to this
//   port at boot. Tests inject a fake. The package-capture
//   package therefore does NOT depend on `@aws-sdk/client-s3` —
//   same pattern @pharmax/security uses for its
//   `S3ObjectLockClient` port.
//
// Tenancy / RLS contract:
//
//   - `beginUpload` must run inside `withTenancyContext(...)`. It
//     reads `requireCurrentContext()` for `actor.userId` (audit
//     anchor for the token row) and the optional `siteId` /
//     `clinicId`. It then opens its own short Prisma transaction
//     and applies the tenancy GUC keyed on `input.organizationId`
//     — the RLS WITH CHECK clause ensures the inserted row's
//     `organizationId` matches the GUC, so a buggy caller passing
//     a different org than the active session would be rejected
//     by the database.
//
//   - `resolveUploadToken` opens its own short tx with the SYSTEM
//     context. The token is a UUID v4 (cryptographically
//     unguessable), the lookup is by primary key, and the command
//     ALWAYS cross-checks the returned `organizationId` against
//     `ctx.organizationId` — those three together make the
//     system-context read safe. We deliberately do NOT take the
//     org as an input to `resolveUploadToken` because the port
//     does not (and changing the port would force every adapter
//     to take it, even the in-memory test adapter).
//
// PHI rule:
//
//   - Photo bytes themselves are NOT classified PHI in Pharmax's
//     threat model. They are encrypted at rest with SSE-KMS using
//     the same KMS key the rest of `@pharmax/crypto` uses.
//   - Operator notes (which may be PHI-adjacent) DO NOT live in
//     S3 — they're written to `package_photo.notesEnc` by the
//     command. The token row carries only structural fields
//     (storage pointer, sha256, size, content type, expiry).

import { createHash, randomUUID } from "node:crypto";

import type { PrismaClient } from "@pharmax/database";
import {
  applySystemSessionGuc,
  applyTenancySessionGuc,
  requireCurrentContext,
  type TenancyContext,
} from "@pharmax/tenancy";

import type {
  PackagePhotoStorage,
  PackagePhotoUploadInput,
  PackagePhotoUploadResult,
  ResolvedPackagePhotoUpload,
} from "./package-photo-storage.js";

// ---------------------------------------------------------------------------
// Narrow port over @aws-sdk/client-s3.
//
// Mirrors `@pharmax/security`'s `S3ObjectLockClient`: types only
// the AWS fields this adapter uses; the composition root adapts a
// real `S3Client` to this surface. Adding fields here means
// adding them to the bootstrap adapter too — keep the surface
// narrow on purpose.
// ---------------------------------------------------------------------------

export interface S3UploadClient {
  putObject(input: S3PutObjectInput): Promise<S3PutObjectOutput>;
}

export interface S3PutObjectInput {
  readonly Bucket: string;
  readonly Key: string;
  /** The photo bytes. AWS SDK accepts `Uint8Array` directly. */
  readonly Body: Uint8Array;
  readonly ContentType: string;
  readonly ContentLength: number;
  /**
   * Base64-encoded SHA-256 of the body. AWS validates this on
   * upload and rejects on mismatch — gives us free integrity
   * checking without a second client-side hash pass.
   */
  readonly ChecksumSHA256: string;
  /** Must be `"aws:kms"` — SSE-S3 is rejected for this bucket. */
  readonly ServerSideEncryption: "aws:kms";
  /** KMS key ARN or alias used to wrap the data key. */
  readonly SSEKMSKeyId: string;
  /**
   * User-metadata stored on the object. We echo the hash + org
   * here so future GetObject readers can self-describe without
   * needing the token table.
   *
   * AWS lowercases metadata keys; we emit them lowercased
   * up-front to keep round-trips deterministic.
   */
  readonly Metadata: Record<string, string>;
}

export interface S3PutObjectOutput {
  readonly ETag?: string;
  readonly VersionId?: string;
}

// ---------------------------------------------------------------------------
// Error codes.
// ---------------------------------------------------------------------------

/** Thrown if `beginUpload` is called outside `withTenancyContext`. */
export const S3_PACKAGE_PHOTO_STORAGE_NO_TENANCY = "S3_PACKAGE_PHOTO_STORAGE_NO_TENANCY";

/**
 * Thrown when `input.organizationId` does not match the active
 * tenancy frame's `organizationId`. Always a programming error
 * (the route should pass the session's org); we fail loudly
 * rather than silently letting the GUC + RLS WITH CHECK do the
 * rejection — the error message is more actionable here.
 */
export const S3_PACKAGE_PHOTO_STORAGE_TENANCY_MISMATCH =
  "S3_PACKAGE_PHOTO_STORAGE_TENANCY_MISMATCH";

// ---------------------------------------------------------------------------
// Adapter options.
// ---------------------------------------------------------------------------

export const PACKAGE_PHOTO_UPLOAD_TTL_MS = 60 * 60 * 1000;

export interface S3PackagePhotoStorageOptions {
  readonly s3: S3UploadClient;
  readonly prisma: PrismaClient;
  readonly bucket: string;
  /** KMS key ARN/id used for SSE-KMS. REQUIRED. */
  readonly kmsKeyId: string;
  /**
   * TTL applied to token rows. Defaults to 1 hour. The dispatch
   * step typically follows the upload within seconds; an hour is
   * a generous window for slow / interrupted connections.
   */
  readonly tokenTtlMs?: number;
  /** Clock override for tests. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

// ---------------------------------------------------------------------------
// Internal: resolves the actor + optional site/clinic context from
// the active tenancy frame. Falls back to throwing a clear error
// when the frame is missing — never silently writes a token row
// with a sentinel user id.
// ---------------------------------------------------------------------------

interface ResolvedUploadContext {
  readonly tenancy: TenancyContext;
  readonly organizationId: string;
  readonly uploadedByUserId: string;
  readonly siteId: string | undefined;
  readonly clinicId: string | undefined;
}

function readCurrentUploadContext(): ResolvedUploadContext {
  const ctx = requireCurrentContext();
  return {
    tenancy: ctx,
    organizationId: ctx.organizationId,
    uploadedByUserId: ctx.actor.userId,
    siteId: ctx.siteId ?? undefined,
    clinicId: ctx.clinicId ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Adapter.
// ---------------------------------------------------------------------------

export class S3PackagePhotoStorage implements PackagePhotoStorage {
  private readonly s3: S3UploadClient;
  private readonly prisma: PrismaClient;
  private readonly bucket: string;
  private readonly kmsKeyId: string;
  private readonly tokenTtlMs: number;
  private readonly now: () => Date;

  constructor(options: S3PackagePhotoStorageOptions) {
    this.s3 = options.s3;
    this.prisma = options.prisma;
    this.bucket = options.bucket;
    this.kmsKeyId = options.kmsKeyId;
    this.tokenTtlMs = options.tokenTtlMs ?? PACKAGE_PHOTO_UPLOAD_TTL_MS;
    this.now = options.now ?? (() => new Date());
  }

  async beginUpload(input: PackagePhotoUploadInput): Promise<PackagePhotoUploadResult> {
    // -----------------------------------------------------------
    // 1. Resolve the actor + capture-context from the active
    //    tenancy frame. Fails loudly if the caller forgot
    //    `withTenancyContext(...)` (which would also trip the
    //    later RLS write, but the error message is opaque from
    //    Postgres' perspective; we'd rather catch it here).
    // -----------------------------------------------------------
    let context: ResolvedUploadContext;
    try {
      context = readCurrentUploadContext();
    } catch (cause) {
      throw new Error(
        `${S3_PACKAGE_PHOTO_STORAGE_NO_TENANCY}: beginUpload must be called inside withTenancyContext(...). ` +
          `Original error: ${cause instanceof Error ? cause.message : String(cause)}`
      );
    }

    if (input.organizationId !== context.organizationId) {
      throw new Error(
        `${S3_PACKAGE_PHOTO_STORAGE_TENANCY_MISMATCH}: input.organizationId (${input.organizationId}) ` +
          `does not match the active tenancy frame (${context.organizationId}). Pass the session's organizationId.`
      );
    }

    // -----------------------------------------------------------
    // 2. Compute the hash + reserve a token + storage key.
    //
    //    The key shape includes the token (not the sha) so the
    //    janitor can find orphans deterministically by listing
    //    `org/{orgId}/photo/upload/*` and joining against the
    //    token table. Sha-based keys would collide between
    //    different uploads of identical bytes; the token suffix
    //    keeps each upload addressable.
    // -----------------------------------------------------------
    const sha256Bin = createHash("sha256").update(input.bytes).digest();
    const sha256HexStr = sha256Bin.toString("hex");
    const sha256B64 = sha256Bin.toString("base64");

    const uploadToken = randomUUID();
    const key = `org/${input.organizationId}/photo/upload/${uploadToken}`;

    // -----------------------------------------------------------
    // 3. PutObject FIRST.
    //
    //    Failure mode if S3 succeeds but the DB INSERT fails:
    //    the object is orphaned in S3 with no token row. The
    //    janitor sweeps orphans by listing keys older than the
    //    TTL window with no corresponding token row.
    //
    //    Failure mode if S3 fails: client can retry cleanly with
    //    a fresh request; no DB state to roll back.
    // -----------------------------------------------------------
    await this.s3.putObject({
      Bucket: this.bucket,
      Key: key,
      Body: input.bytes,
      ContentType: input.contentType,
      ContentLength: input.bytes.byteLength,
      ChecksumSHA256: sha256B64,
      ServerSideEncryption: "aws:kms",
      SSEKMSKeyId: this.kmsKeyId,
      Metadata: {
        sha256: sha256HexStr,
        organizationid: input.organizationId,
        contenttype: input.contentType,
        uploadedbyuserid: context.uploadedByUserId,
      },
    });

    // -----------------------------------------------------------
    // 4. Persist the token row inside a short tx that applies the
    //    tenancy GUC. The RLS WITH CHECK clause double-validates
    //    that the row's `organizationId` matches the active org
    //    (belt-and-braces against any future caller that passes a
    //    different org through the input).
    // -----------------------------------------------------------
    const issuedAt = this.now();
    const expiresAt = new Date(issuedAt.getTime() + this.tokenTtlMs);

    // Reuse the active tenancy context for the GUC apply — its
    // `organizationId` already equals `input.organizationId`
    // (verified above), and `applyTenancySessionGuc` only reads
    // the `organizationId` field.
    await this.prisma.$transaction(async (tx) => {
      await applyTenancySessionGuc(tx, context.tenancy);
      await tx.packagePhotoUploadToken.create({
        data: {
          token: uploadToken,
          organizationId: input.organizationId,
          uploadedByUserId: context.uploadedByUserId,
          ...(context.siteId !== undefined ? { siteId: context.siteId } : {}),
          ...(context.clinicId !== undefined ? { clinicId: context.clinicId } : {}),
          storageBucket: this.bucket,
          storageKey: key,
          sha256: sha256HexStr,
          fileSize: input.bytes.byteLength,
          contentType: input.contentType,
          expiresAt,
        },
      });
    });

    return {
      uploadToken,
      bucket: this.bucket,
      key,
      sha256: sha256HexStr,
      fileSize: input.bytes.byteLength,
      contentType: input.contentType,
    };
  }

  async resolveUploadToken(token: string): Promise<ResolvedPackagePhotoUpload | null> {
    // System-context read is safe because:
    //   1. The token is a UUID v4 (cryptographically unguessable).
    //   2. The lookup is by primary key.
    //   3. The CapturePackagePhoto command ALWAYS cross-checks
    //      `upload.organizationId === ctx.organizationId` and
    //      throws PACKAGE_PHOTO_UPLOAD_TOKEN_TENANT_MISMATCH on
    //      mismatch.
    // The reason string is recorded in the system-context audit
    // GUC so a SOC 2 reviewer can grep all system-context reads.
    const row = await this.prisma.$transaction(async (tx) => {
      await applySystemSessionGuc(tx, "package-photo:resolve-upload-token");
      return tx.packagePhotoUploadToken.findUnique({
        where: { token },
      });
    });

    if (row === null) return null;
    if (row.expiresAt.getTime() <= this.now().getTime()) return null;

    return {
      bucket: row.storageBucket,
      key: row.storageKey,
      sha256: row.sha256,
      fileSize: row.fileSize,
      contentType: row.contentType,
      organizationId: row.organizationId,
    };
  }
}
