// AWS S3 client port for the manifest publisher.
//
// Like `KmsAsymmetricSigningClient`, this is a narrow port over the
// AWS SDK so:
//
//   - The publisher unit tests inject a fake without pulling
//     `@aws-sdk/client-s3` into Vitest.
//   - The production composition root constructs `S3Client` once and
//     hands it in.
//   - Refusing-to-overwrite is the publisher's invariant, not the
//     SDK's; the port exposes the minimum AWS surface the publisher
//     needs to enforce that invariant deterministically.
//
// The port intentionally types only the AWS fields the publisher uses
// (Bucket, Key, Body, ContentType, retention/encryption knobs,
// `IfNoneMatch`). Adding more fields here means adding them on the
// publisher contract as well — keep the surface narrow.

export interface S3PutObjectInput {
  readonly Bucket: string;
  readonly Key: string;
  readonly Body: Buffer | string;
  readonly ContentType: string;
  readonly ContentLength?: number;
  readonly ChecksumSHA256?: string;
  readonly ServerSideEncryption: "aws:kms";
  readonly SSEKMSKeyId: string;
  readonly ObjectLockMode: "COMPLIANCE" | "GOVERNANCE";
  readonly ObjectLockRetainUntilDate: Date;
  readonly ObjectLockLegalHoldStatus?: "ON" | "OFF";
  /**
   * S3 conditional-write contract: setting `IfNoneMatch: "*"` rejects
   * the PUT (412 PreconditionFailed) when an object already exists
   * at the key. Combined with Object Lock COMPLIANCE this gives us
   * a *belt-and-braces* refuse-overwrite: the conditional rejects
   * cleanly with no S3 charge, and the lock blocks any sneak path.
   */
  readonly IfNoneMatch?: "*";
  readonly Metadata?: Record<string, string>;
}

export interface S3PutObjectOutput {
  readonly ETag?: string;
  readonly VersionId?: string;
}

export interface S3HeadObjectInput {
  readonly Bucket: string;
  readonly Key: string;
}

export interface S3HeadObjectOutput {
  readonly ETag?: string;
  readonly VersionId?: string;
  readonly ContentLength?: number;
  readonly LastModified?: Date;
  readonly ObjectLockMode?: string;
  readonly ObjectLockRetainUntilDate?: Date;
}

export interface S3GetObjectInput {
  readonly Bucket: string;
  readonly Key: string;
  readonly VersionId?: string;
}

export interface S3GetObjectOutput {
  readonly Body: Buffer;
  readonly ETag?: string;
  readonly VersionId?: string;
  readonly ContentType?: string;
  readonly LastModified?: Date;
}

/** Narrow port over `@aws-sdk/client-s3` used by `S3ObjectLockPublisher`. */
export interface S3ObjectLockClient {
  putObject(input: S3PutObjectInput): Promise<S3PutObjectOutput>;
  headObject(input: S3HeadObjectInput): Promise<S3HeadObjectOutput | null>;
  getObject(input: S3GetObjectInput): Promise<S3GetObjectOutput | null>;
}

/**
 * Production adapter around the AWS SDK v3 `S3Client`. The composition
 * root passes in the SDK client; we adapt to the narrow port. SDK
 * import is lazy so the `@pharmax/security` test suite does not
 * resolve `@aws-sdk/client-s3`.
 */
// `send` is declared as the narrowest universally-callable shape we can
// adapt against the AWS SDK v3 `S3Client.send` generic. We intentionally
// use a wide param type here because the SDK's send signature is a
// generic overload set keyed to internal `Command<>` brand types we do
// not want to depend on; in practice the call sites below pass concrete
// `*Command` instances and the SDK's runtime ignores the surrounding
// adapter type.
//
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- AWS SDK boundary.
type AwsSdkClientLike = { send: (command: any, options?: any) => Promise<any> };

export function adaptAwsS3SdkClient(sdkClient: AwsSdkClientLike): S3ObjectLockClient {
  return {
    async putObject(input: S3PutObjectInput): Promise<S3PutObjectOutput> {
      const { PutObjectCommand } = await import("@aws-sdk/client-s3");
      const out = (await sdkClient.send(
        new PutObjectCommand({
          Bucket: input.Bucket,
          Key: input.Key,
          Body: input.Body,
          ContentType: input.ContentType,
          ...(input.ContentLength !== undefined ? { ContentLength: input.ContentLength } : {}),
          ...(input.ChecksumSHA256 !== undefined ? { ChecksumSHA256: input.ChecksumSHA256 } : {}),
          ServerSideEncryption: input.ServerSideEncryption,
          SSEKMSKeyId: input.SSEKMSKeyId,
          ObjectLockMode: input.ObjectLockMode,
          ObjectLockRetainUntilDate: input.ObjectLockRetainUntilDate,
          ObjectLockLegalHoldStatus: input.ObjectLockLegalHoldStatus ?? "OFF",
          ...(input.IfNoneMatch !== undefined ? { IfNoneMatch: input.IfNoneMatch } : {}),
          ...(input.Metadata !== undefined ? { Metadata: input.Metadata } : {}),
        })
      )) as { ETag?: string; VersionId?: string };
      return {
        ...(out.ETag !== undefined ? { ETag: out.ETag } : {}),
        ...(out.VersionId !== undefined ? { VersionId: out.VersionId } : {}),
      };
    },

    async headObject(input: S3HeadObjectInput): Promise<S3HeadObjectOutput | null> {
      try {
        const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
        const out = (await sdkClient.send(
          new HeadObjectCommand({ Bucket: input.Bucket, Key: input.Key })
        )) as {
          ETag?: string;
          VersionId?: string;
          ContentLength?: number;
          LastModified?: Date;
          ObjectLockMode?: string;
          ObjectLockRetainUntilDate?: Date;
        };
        return {
          ...(out.ETag !== undefined ? { ETag: out.ETag } : {}),
          ...(out.VersionId !== undefined ? { VersionId: out.VersionId } : {}),
          ...(out.ContentLength !== undefined ? { ContentLength: out.ContentLength } : {}),
          ...(out.LastModified !== undefined ? { LastModified: out.LastModified } : {}),
          ...(out.ObjectLockMode !== undefined ? { ObjectLockMode: out.ObjectLockMode } : {}),
          ...(out.ObjectLockRetainUntilDate !== undefined
            ? { ObjectLockRetainUntilDate: out.ObjectLockRetainUntilDate }
            : {}),
        };
      } catch (cause) {
        if (isAwsS3NotFound(cause)) return null;
        throw cause;
      }
    },

    async getObject(input: S3GetObjectInput): Promise<S3GetObjectOutput | null> {
      try {
        const { GetObjectCommand } = await import("@aws-sdk/client-s3");
        const out = (await sdkClient.send(
          new GetObjectCommand({
            Bucket: input.Bucket,
            Key: input.Key,
            ...(input.VersionId !== undefined ? { VersionId: input.VersionId } : {}),
          })
        )) as {
          Body?: { transformToByteArray?: () => Promise<Uint8Array> };
          ETag?: string;
          VersionId?: string;
          ContentType?: string;
          LastModified?: Date;
        };
        if (out.Body === undefined || typeof out.Body.transformToByteArray !== "function") {
          throw new Error("S3 GetObject returned no Body or an unstreamable Body.");
        }
        const bytes = await out.Body.transformToByteArray();
        return {
          Body: Buffer.from(bytes),
          ...(out.ETag !== undefined ? { ETag: out.ETag } : {}),
          ...(out.VersionId !== undefined ? { VersionId: out.VersionId } : {}),
          ...(out.ContentType !== undefined ? { ContentType: out.ContentType } : {}),
          ...(out.LastModified !== undefined ? { LastModified: out.LastModified } : {}),
        };
      } catch (cause) {
        if (isAwsS3NotFound(cause)) return null;
        throw cause;
      }
    },
  };
}

/**
 * S3 returns either a `NotFound` error or a `NoSuchKey` error
 * depending on whether you HEAD'd or GET'd. Treat both as "not
 * present" so the head/get-then-put pattern stays clean. Other AWS
 * errors (AccessDenied, ServiceUnavailable) propagate.
 */
function isAwsS3NotFound(cause: unknown): boolean {
  if (cause === null || typeof cause !== "object") return false;
  const name = (cause as { name?: unknown }).name;
  if (name === "NotFound" || name === "NoSuchKey") return true;
  const statusCode = (cause as { $metadata?: { httpStatusCode?: unknown } }).$metadata
    ?.httpStatusCode;
  return statusCode === 404;
}
