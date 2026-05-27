// Public surface of @pharmax/documents.
//
// What lives here:
//   - The `DocumentStorage` port that every adapter satisfies.
//   - The `DocumentClassification` enum + helpers
//     (`requiresAadBinding`, `maxSignedUrlTtlSeconds`).
//   - The boot-time `configureDocumentStorage` singleton.
//   - The `InMemoryDocumentStorage` adapter (which wires
//     `@pharmax/crypto::encryptField` for PHI so the contract is
//     exercised end-to-end against the in-memory backend).
//   - The dictionary of typed error codes the port / adapters may
//     throw.
//
// What does NOT live here (intentional follow-up slices):
//   - Production adapters (S3 + KMS, GCS, etc.). Each ships its
//     own slice with bucket provisioning, KMS key wiring, and
//     observability.
//   - A Prisma model that anchors document ids to domain rows
//     (e.g. `prescription.image_document_id`). The first domain
//     that needs it ships the migration + model; this layer stays
//     storage-agnostic.
//   - A refactor of `@pharmax/package-capture::PackagePhotoStorage`
//     onto this port. The shape here is a strict superset; the
//     follow-up reduces `PackagePhotoStorage` to a thin wrapper
//     around `put({ classification: "INTERNAL", ... })`. Doing
//     that refactor now would churn every existing call site for
//     no day-one benefit; the path is clear and documented in
//     ADR-0021.

export {
  configureDocumentStorage,
  getDocumentStorage,
  resetDocumentStorageConfigurationForTests,
  DOCUMENTS_NOT_CONFIGURED,
  type DocumentStorageConfiguration,
} from "./configure.js";

export {
  DOCUMENT_CLASSIFICATIONS,
  isDocumentClassification,
  maxSignedUrlTtlSeconds,
  requiresAadBinding,
  type DocumentClassification,
} from "./classification.js";

export {
  DOCUMENT_AAD_BINDING_REQUIRED,
  DOCUMENT_AAD_BINDING_UNEXPECTED,
  DOCUMENT_DELETE_REASONS,
  DOCUMENT_NOT_FOUND,
  DOCUMENT_TENANT_MISMATCH,
  DOCUMENT_TRANSPORT_ERROR,
  DOCUMENT_TTL_EXCEEDED,
  DOCUMENT_VALIDATION,
  type AadBinding,
  type DocumentDeleteOptions,
  type DocumentDeleteReason,
  type DocumentGetOptions,
  type DocumentGetResult,
  type DocumentPutInput,
  type DocumentPutResult,
  type DocumentSignUrlOptions,
  type DocumentSignUrlResult,
  type DocumentStorage,
} from "./ports/document-storage.js";

export {
  InMemoryDocumentStorage,
  type InMemoryDocumentStorageOptions,
} from "./adapters/in-memory-document-storage.js";

import * as adapterModule from "./adapters/in-memory-document-storage.js";
import * as classificationModule from "./classification.js";
import * as configureModule from "./configure.js";
import * as portModule from "./ports/document-storage.js";

/** Convenience namespace for the consuming code that prefers a
 *  namespaced import style. */
export const documents = {
  ...configureModule,
  ...classificationModule,
  ...portModule,
  ...adapterModule,
} as const;
