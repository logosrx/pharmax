// AWS KMS signing-client port.
//
// `KmsAsymmetricSigner` depends on AWS KMS via this narrow port (just
// `Sign` and `GetPublicKey`) so that:
//
//   - Unit tests inject a fake client with no SDK dependency.
//   - Production wires a real `@aws-sdk/client-kms` `KMSClient` once
//     in the composition root and hands it to the signer.
//   - The signer file remains independent from `@aws-sdk/client-kms`
//     types, which keeps the package's test surface small and the
//     SDK swappable.
//
// Why not reuse `AwsKmsClient` from `@pharmax/crypto`?
//
//   That wrapper exposes only the four ops used for envelope
//   encryption (`generateDataKey`, `decrypt`, `mac`, `describeKey`).
//   Signing requires `Sign` + `GetPublicKey`, which the wrapper does
//   not surface — and we are forbidden from extending the crypto
//   package. Defining a separate, signing-only port keeps the two
//   responsibilities isolated and IAM-scoped: the signer's IAM
//   principal needs `kms:Sign` + `kms:GetPublicKey` on ONE key, not
//   `kms:Decrypt` on the data-key.
//
// The shape is intentionally close to the AWS SDK v3 input/output
// types so the production adapter (built in the composition root) is
// a single-line `await kms.send(new SignCommand(input))` wrapper.

/** Input to AWS KMS `Sign`. RAW (KMS hashes), DIGEST (caller hashed). */
export interface KmsSignInput {
  readonly KeyId: string;
  readonly Message: Buffer;
  readonly MessageType: "RAW" | "DIGEST";
  /**
   * Stable algorithm identifier matching the AWS KMS contract. We
   * pin `ECDSA_SHA_256` for the audit-Merkle path; the union here
   * keeps future migrations (e.g. `RSASSA_PSS_SHA_256`) typeable
   * without expanding the port.
   */
  readonly SigningAlgorithm:
    | "ECDSA_SHA_256"
    | "ECDSA_SHA_384"
    | "ECDSA_SHA_512"
    | "RSASSA_PSS_SHA_256"
    | "RSASSA_PSS_SHA_384"
    | "RSASSA_PSS_SHA_512"
    | "RSASSA_PKCS1_V1_5_SHA_256";
}

export interface KmsSignOutput {
  /** DER-encoded ECDSA signature for ECC_NIST_P256 keys. */
  readonly Signature?: Uint8Array;
  /** Echoed key id from AWS. */
  readonly KeyId?: string;
  readonly SigningAlgorithm?: string;
}

export interface KmsGetPublicKeyInput {
  readonly KeyId: string;
}

export interface KmsGetPublicKeyOutput {
  /** SPKI-DER-encoded public key. */
  readonly PublicKey?: Uint8Array;
  readonly KeyId?: string;
  readonly KeyUsage?: string;
  readonly KeySpec?: string;
}

export interface KmsAsymmetricSigningClient {
  sign(input: KmsSignInput): Promise<KmsSignOutput>;
  getPublicKey(input: KmsGetPublicKeyInput): Promise<KmsGetPublicKeyOutput>;
}

/**
 * Thin adapter around the AWS SDK v3 `KMSClient`. Production wires
 * this once in `apps/worker/src/main.ts` and hands it to the signer.
 *
 * Why a function (not a class): the AWS SDK is loaded lazily so unit
 * tests of the security package do not pull `@aws-sdk/client-kms`
 * into Vitest. The SDK is only resolved when the production
 * composition root calls this factory.
 *
 * Reliability tuning is delegated to the caller-supplied SDK
 * `KMSClient` — the audit-Merkle signing path is a once-per-day per-
 * org call so we do not need the request-rate machinery the crypto
 * package's `createAwsKmsClient` adds for hot-path encrypt/decrypt.
 */
// See note in `s3-object-lock-client.ts#adaptAwsS3SdkClient`: AWS SDK's
// generic `send` overload set doesn't satisfy a narrow `(unknown) => unknown`
// param without a noisy cast at every call site. Loosen at the adapter
// boundary instead; the call sites below pass real `*Command` instances.
//
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- AWS SDK boundary.
type AwsSdkClientLike = { send: (command: any, options?: any) => Promise<any> };

export function adaptAwsKmsSdkClientForSigning(
  sdkClient: AwsSdkClientLike
): KmsAsymmetricSigningClient {
  return {
    async sign(input: KmsSignInput): Promise<KmsSignOutput> {
      // Import lazily so the security-package test suite does not
      // need to resolve `@aws-sdk/client-kms`. Production calls this
      // exactly once per signer construction; the import cost is
      // amortized.
      const { SignCommand } = await import("@aws-sdk/client-kms");
      const out = (await sdkClient.send(
        new SignCommand({
          KeyId: input.KeyId,
          Message: input.Message,
          MessageType: input.MessageType,
          SigningAlgorithm: input.SigningAlgorithm,
        })
      )) as { Signature?: Uint8Array; KeyId?: string; SigningAlgorithm?: string };
      return {
        ...(out.Signature !== undefined ? { Signature: out.Signature } : {}),
        ...(out.KeyId !== undefined ? { KeyId: out.KeyId } : {}),
        ...(out.SigningAlgorithm !== undefined ? { SigningAlgorithm: out.SigningAlgorithm } : {}),
      };
    },
    async getPublicKey(input: KmsGetPublicKeyInput): Promise<KmsGetPublicKeyOutput> {
      const { GetPublicKeyCommand } = await import("@aws-sdk/client-kms");
      const out = (await sdkClient.send(new GetPublicKeyCommand({ KeyId: input.KeyId }))) as {
        PublicKey?: Uint8Array;
        KeyId?: string;
        KeyUsage?: string;
        KeySpec?: string;
      };
      return {
        ...(out.PublicKey !== undefined ? { PublicKey: out.PublicKey } : {}),
        ...(out.KeyId !== undefined ? { KeyId: out.KeyId } : {}),
        ...(out.KeyUsage !== undefined ? { KeyUsage: out.KeyUsage } : {}),
        ...(out.KeySpec !== undefined ? { KeySpec: out.KeySpec } : {}),
      };
    },
  };
}
