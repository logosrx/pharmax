// Public surface of @pharmax/crypto.
//
// Two import styles supported:
//
//     // Named:
//     import { encryptField, decryptField, configureCrypto } from "@pharmax/crypto";
//     await encryptField({ plaintext, binding });
//
//     // Namespaced:
//     import { crypto as pharmaxCrypto } from "@pharmax/crypto";
//     await pharmaxCrypto.encryptField({ ... });

export { AAD_VERSION, bindingsEqual, encodeAad, type RecordBinding } from "./aad.js";

export {
  ENVELOPE_VERSION,
  isEnvelope,
  parseEnvelope,
  serializeEnvelope,
  type CiphertextEnvelope,
} from "./envelope.js";

export {
  AUDIT_MERKLE_SIGNING_DOMAIN_TAG,
  buildAuditMerkleSigningPreimage,
  type DeriveSearchKeyInput,
  type GenerateDataKeyResult,
  type KmsAdapter,
  type SignatureAlgorithm,
  type SignRootInput,
  type SignRootOutput,
  type UnwrapDataKeyInput,
  type VerifyRootInput,
} from "./kms-adapter.js";

export {
  LocalKmsAdapter,
  hmacSha256,
  timingSafeEqualBuffers,
  type LocalKmsAdapterOptions,
} from "./local-kms-adapter.js";

export {
  AwsKmsAdapter,
  sanitizeKeyIdForLabel,
  type AwsKmsAdapterOptions,
  type AwsKmsClient,
  type AwsKmsDecryptInput,
  type AwsKmsDecryptOutput,
  type AwsKmsDescribeKeyInput,
  type AwsKmsDescribeKeyOutput,
  type AwsKmsGenerateDataKeyInput,
  type AwsKmsGenerateDataKeyOutput,
  type AwsKmsMacInput,
  type AwsKmsMacOutput,
} from "./aws-kms-adapter.js";

export { createAwsKmsClient, type CreateAwsKmsClientOptions } from "./aws-kms-client.js";

export { decryptField, encryptField } from "./encrypt.js";

export {
  blindIndex,
  normalizeForBlindIndex,
  normalizePhoneForBlindIndex,
  type BlindIndexInput,
} from "./blind-index.js";

export {
  CRYPTO_SHRED_REASONS,
  planCryptoShred,
  type CryptoShredPlan,
  type CryptoShredReason,
} from "./shred.js";

export {
  configureCrypto,
  getCryptoConfiguration,
  resetCryptoConfigurationForTests,
  type CryptoConfiguration,
} from "./configure.js";

export {
  AAD_MISMATCH,
  CRYPTO_NOT_CONFIGURED,
  CRYPTO_VALIDATION,
  DECRYPT_FAILED,
  ENVELOPE_MALFORMED,
  KMS_KEY_NOT_FOUND,
  aadMismatchError,
  cryptoNotConfiguredError,
  cryptoValidationError,
  decryptFailedError,
  envelopeMalformedError,
  kmsKeyNotFoundError,
} from "./errors.js";

import * as aadModule from "./aad.js";
import * as awsKmsModule from "./aws-kms-adapter.js";
import * as awsKmsClientModule from "./aws-kms-client.js";
import * as blindIndexModule from "./blind-index.js";
import * as configureModule from "./configure.js";
import * as encryptModule from "./encrypt.js";
import * as envelopeModule from "./envelope.js";
import * as errorsModule from "./errors.js";
import * as kmsAdapterModule from "./kms-adapter.js";
import * as localKmsModule from "./local-kms-adapter.js";
import * as shredModule from "./shred.js";

export const crypto = {
  ...aadModule,
  ...envelopeModule,
  ...kmsAdapterModule,
  ...localKmsModule,
  ...awsKmsModule,
  ...awsKmsClientModule,
  ...encryptModule,
  ...blindIndexModule,
  ...shredModule,
  ...configureModule,
  ...errorsModule,
} as const;
