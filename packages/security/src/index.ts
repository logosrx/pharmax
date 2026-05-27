// Public surface of @pharmax/security.
//
// Tier-3 audit-window security primitives that operate on top of the
// PHI envelope encryption (@pharmax/crypto), hash-chained audit log
// (@pharmax/audit), and per-tenant RLS isolation (@pharmax/tenancy)
// already provided by the Pharmax modular monolith.
//
// Domains exposed:
//
//   - break-glass: open and close `pharmax_system`-role sessions for
//     forensic / repair work. Distinct from the per-permission
//     break-glass grant in @pharmax/rbac.
//
//   - access-review: SOC 2 CC6.2 quarterly access review reports.
//
//   - merkle: per-tenant daily Merkle root over audit_log + KMS-
//     asymmetric signing + Object Lock manifest publication +
//     re-verification.
//
//   - security-digest: nightly aggregated security status email body
//     composer.

export {
  BREAK_GLASS_SESSION_DEFAULT_DURATION_MINUTES,
  BREAK_GLASS_SESSION_MAX_DURATION_MINUTES,
  closeBreakGlassSession,
  openBreakGlassSession,
  type BreakGlassActionRecord,
  type BreakGlassClient,
  type BreakGlassSessionHandle,
  type BreakGlassSessionInput,
  type BreakGlassSessionRecord,
  type PrismaSystemContextTx,
} from "./break-glass/break-glass-session.js";

export {
  BREAK_GLASS_SESSION_ALREADY_CLOSED,
  BREAK_GLASS_SESSION_EXPIRED,
  BREAK_GLASS_SESSION_REASON_REQUIRED,
  BREAK_GLASS_SESSION_TICKET_REQUIRED,
  breakGlassSessionAlreadyClosedError,
  breakGlassSessionExpiredError,
} from "./break-glass/errors.js";

export {
  ELEVATED_ROLE_CODES,
  INACTIVE_USER_THRESHOLD_DAYS,
  OrganizationNotFoundForAccessReviewError,
  STALE_ASSIGNMENT_THRESHOLD_DAYS,
  generateAccessReview,
  type AccessReviewAssignment,
  type AccessReviewClient,
  type AccessReviewPrincipal,
  type AccessReviewReport,
  type AccessReviewSummary,
  type GenerateAccessReviewInput,
} from "./access-review/generate-access-review.js";

export {
  MERKLE_LEAF_TAG,
  MERKLE_NODE_TAG,
  computeDailyMerkleRoot,
  computeMerkleRootFromLeaves,
  createPrismaAuditChainSource,
  type ComputeDailyMerkleRootInput,
  type DailyMerkleRoot,
  type PrismaAuditChainSourceClient,
} from "./merkle/compute-daily-merkle-root.js";

export {
  KmsAsymmetricSigner,
  LocalEd25519Signer,
  MERKLE_PUBLIC_KEY_FETCH_FAILED,
  MERKLE_SIGN_FAILED,
  SECURITY_SIGNER_UNAVAILABLE,
  SIGNING_DOMAIN_TAG,
  buildKmsAsymmetricSignerKid,
  buildSigningPreimage,
  type KmsAsymmetricSignerOptions,
  type LocalEd25519SignerOptions,
  type LocalEd25519SignerPublicMaterial,
  type MerkleRootSigner,
  type SigningAlgorithm,
  type SigningInput,
  type SigningOutput,
} from "./merkle/sign-merkle-root.js";

export {
  adaptAwsKmsSdkClientForSigning,
  type KmsAsymmetricSigningClient,
  type KmsGetPublicKeyInput,
  type KmsGetPublicKeyOutput,
  type KmsSignInput,
  type KmsSignOutput,
} from "./merkle/kms-signing-client.js";

export {
  InMemoryManifestPublisher,
  MANIFEST_SCHEMA_VERSION,
  MERKLE_MANIFEST_OVERWRITE_REFUSED,
  MERKLE_PUBLISH_FAILED,
  MIN_RETENTION_DAYS,
  S3ObjectLockPublisher,
  SECURITY_MANIFEST_PUBLISH_FAILED,
  buildSignedMerkleManifest,
  manifestObjectKey,
  type ManifestPublisher,
  type PublishManifestOutput,
  type S3ObjectLockPublisherOptions,
  type SignedMerkleManifest,
} from "./merkle/publish-merkle-manifest.js";

export {
  adaptAwsS3SdkClient,
  type S3GetObjectInput,
  type S3GetObjectOutput,
  type S3HeadObjectInput,
  type S3HeadObjectOutput,
  type S3ObjectLockClient,
  type S3PutObjectInput,
  type S3PutObjectOutput,
} from "./merkle/s3-object-lock-client.js";

export {
  EcdsaP256SignatureVerifier,
  LocalEd25519SignatureVerifier,
  MultiKidSignatureVerifier,
  verifyMerkleManifest,
  type SignatureVerifier,
  type VerifierBounds,
  type VerifyManifestFailureReason,
  type VerifyManifestResult,
  type VerifyMerkleManifestInput,
} from "./merkle/verify-merkle-manifest.js";

export {
  InMemoryDigestPublisher,
  composeNightlySecurityDigest,
  renderDigestAsText,
  type AccessReviewCalendarProbe,
  type AccessReviewDueEntry,
  type AuditChainStatus,
  type AuditChainStatusProbe,
  type BreakGlassSessionEntry,
  type BreakGlassSessionProbe,
  type ComposeDigestInput,
  type DigestPublisher,
  type FailedLoginProbe,
  type FailedLoginSpikeEntry,
  type OutboxStatusEntry,
  type OutboxStatusProbe,
  type SecurityDigest,
  type SentryStatusEntry,
  type SentryStatusProbe,
} from "./security-digest/compose-nightly-security-digest.js";
