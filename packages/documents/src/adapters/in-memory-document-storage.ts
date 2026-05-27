// In-memory DocumentStorage adapter.
//
// Used by tests and ephemeral dev. Stores documents in a
// per-instance Map keyed by `documentId`. PHI documents go through
// `@pharmax/crypto::encryptField` with the supplied AAD binding;
// the encrypted envelope is what lives in the Map. This exercises
// the crypto contract end-to-end so a production adapter (S3 +
// KMS) inherits a proven shape — swap the storage backend, keep
// the crypto wrapper.
//
// NOT suitable for production:
//
//   - No persistence (process restart loses every document).
//   - The signed URL is a `data:` URL that decodes the stored
//     bytes inline. Useful for tests; not what a real adapter
//     should return.
//   - No expiry on stored documents; the Map grows unbounded.
//     Tests should construct a fresh adapter per case or call
//     `clear()`.
//
// Production composition will wire `S3DocumentStorage` (with
// SSE-KMS at rest, per-classification bucket policies, presigned
// PUT for client-side upload, presigned GET for client-side
// download with the TTL ceilings from `classification.ts`).

import { createHash, randomUUID } from "node:crypto";

import { decryptField, encryptField, type CiphertextEnvelope } from "@pharmax/crypto";
import { errors } from "@pharmax/platform-core";

import {
  isDocumentClassification,
  maxSignedUrlTtlSeconds,
  requiresAadBinding,
  type DocumentClassification,
} from "../classification.js";
import {
  DOCUMENT_AAD_BINDING_REQUIRED,
  DOCUMENT_AAD_BINDING_UNEXPECTED,
  DOCUMENT_NOT_FOUND,
  DOCUMENT_TENANT_MISMATCH,
  DOCUMENT_TRANSPORT_ERROR,
  DOCUMENT_TTL_EXCEEDED,
  DOCUMENT_VALIDATION,
  type AadBinding,
  type DocumentDeleteOptions,
  type DocumentGetOptions,
  type DocumentGetResult,
  type DocumentPutInput,
  type DocumentPutResult,
  type DocumentSignUrlOptions,
  type DocumentSignUrlResult,
  type DocumentStorage,
} from "../ports/document-storage.js";

/** Constructor options. */
export interface InMemoryDocumentStorageOptions {
  /** Bucket name reported on `put`. Defaults to
   *  `"pharmax-documents-inmemory"`. */
  readonly bucket?: string;
  /** Optional clock injection for deterministic `expiresAt`. */
  readonly now?: () => Date;
}

/** Per-document entry. PHI rows carry the ENCRYPTED envelope plus
 *  the binding's recordId for read-side mismatch detection. */
interface InMemoryEntry {
  readonly documentId: string;
  readonly tenantId: string;
  readonly classification: DocumentClassification;
  readonly contentType: string;
  readonly bucket: string;
  readonly key: string;
  readonly sha256: string;
  readonly fileSize: number;
  /** For PHI: the ciphertext envelope. For non-PHI: undefined. */
  readonly encryptedEnvelope?: CiphertextEnvelope;
  /** For non-PHI: the raw bytes. For PHI: undefined. */
  readonly plaintextBytes?: Uint8Array;
  readonly metadata: Readonly<Record<string, string>>;
}

interface FailureSpec {
  readonly code: string;
  readonly message: string;
}

export class InMemoryDocumentStorage implements DocumentStorage {
  private readonly entries = new Map<string, InMemoryEntry>();
  private readonly bucket: string;
  private readonly now: () => Date;
  private pendingFailure: FailureSpec | null = null;

  constructor(options: InMemoryDocumentStorageOptions = {}) {
    this.bucket = options.bucket ?? "pharmax-documents-inmemory";
    this.now = options.now ?? (() => new Date());
  }

  async put(input: DocumentPutInput): Promise<DocumentPutResult> {
    this.consumePendingFailureForCall();
    this.validatePutInput(input);

    const sha256 = sha256Hex(input.bytes);
    const documentId = randomUUID();
    const key = `tenant/${input.tenantId}/${input.classification.toLowerCase()}/${sha256}/${documentId}`;

    let encryptedEnvelope: CiphertextEnvelope | undefined;
    let plaintextBytes: Uint8Array | undefined;
    let storedSize: number;

    if (input.classification === "PHI") {
      // `input.aadBinding` is guaranteed by validatePutInput above.
      const binding = input.aadBinding!;
      encryptedEnvelope = await encryptField({
        plaintext: bytesToBase64(input.bytes),
        binding,
      });
      // Stored size is the encrypted envelope's serialized JSON
      // size — a faithful surrogate for "what the S3 object will
      // weigh" in production.
      storedSize = JSON.stringify(encryptedEnvelope).length;
    } else {
      // Defensive copy so callers can mutate their buffer without
      // poisoning the stored entry.
      plaintextBytes = new Uint8Array(input.bytes);
      storedSize = input.bytes.byteLength;
    }

    const entry: InMemoryEntry = {
      documentId,
      tenantId: input.tenantId,
      classification: input.classification,
      contentType: input.contentType,
      bucket: this.bucket,
      key,
      sha256,
      fileSize: storedSize,
      ...(encryptedEnvelope !== undefined ? { encryptedEnvelope } : {}),
      ...(plaintextBytes !== undefined ? { plaintextBytes } : {}),
      metadata: Object.freeze({ ...(input.metadata ?? {}) }),
    };
    this.entries.set(documentId, entry);

    return {
      documentId,
      sha256,
      bucket: entry.bucket,
      key: entry.key,
      fileSize: entry.fileSize,
    };
  }

  async get(documentId: string, options: DocumentGetOptions = {}): Promise<DocumentGetResult> {
    this.consumePendingFailureForCall();

    const entry = this.entries.get(documentId);
    if (entry === undefined) {
      throw new errors.NotFoundError({
        code: DOCUMENT_NOT_FOUND,
        message: `Document "${documentId}" not found.`,
        metadata: { documentId },
      });
    }

    if (requiresAadBinding(entry.classification)) {
      if (options.aadBinding === undefined) {
        throw new errors.AuthorizationError({
          code: DOCUMENT_AAD_BINDING_REQUIRED,
          message:
            "PHI document requires an aadBinding on get(). Caller must pass the same binding used at put time.",
          metadata: { documentId, classification: entry.classification },
        });
      }
      if (options.aadBinding.tenantId !== entry.tenantId) {
        throw new errors.AuthorizationError({
          code: DOCUMENT_TENANT_MISMATCH,
          message: "aadBinding.tenantId does not match the tenant the document was stored under.",
          metadata: {
            documentId,
            expectedTenantId: entry.tenantId,
            providedTenantId: options.aadBinding.tenantId,
          },
        });
      }
      // The crypto layer's tag verification IS the AAD mismatch
      // check. A wrong recordId / table / column under the same
      // tenant surfaces as `AAD_MISMATCH` from `decryptField`.
      const plaintext = await decryptField({
        envelope: entry.encryptedEnvelope!,
        binding: options.aadBinding,
      });
      return {
        bytes: base64ToBytes(plaintext),
        contentType: entry.contentType,
        classification: entry.classification,
      };
    }

    // Non-PHI: bytes are stored raw. Return a defensive copy so
    // callers can mutate freely.
    return {
      bytes: new Uint8Array(entry.plaintextBytes!),
      contentType: entry.contentType,
      classification: entry.classification,
    };
  }

  async signUrl(
    documentId: string,
    options: DocumentSignUrlOptions
  ): Promise<DocumentSignUrlResult> {
    this.consumePendingFailureForCall();

    const entry = this.entries.get(documentId);
    if (entry === undefined) {
      throw new errors.NotFoundError({
        code: DOCUMENT_NOT_FOUND,
        message: `Document "${documentId}" not found.`,
        metadata: { documentId },
      });
    }

    if (!Number.isInteger(options.ttlSeconds) || options.ttlSeconds <= 0) {
      throw new errors.ValidationError({
        code: DOCUMENT_VALIDATION,
        message: "ttlSeconds must be a positive integer.",
        issues: [{ path: ["ttlSeconds"], message: "positive integer required" }],
      });
    }

    const ceiling = maxSignedUrlTtlSeconds(entry.classification);
    if (options.ttlSeconds > ceiling) {
      throw new errors.ValidationError({
        code: DOCUMENT_TTL_EXCEEDED,
        message: `ttlSeconds ${options.ttlSeconds} exceeds ceiling ${ceiling} for classification ${entry.classification}.`,
        issues: [{ path: ["ttlSeconds"], message: "exceeds classification ceiling" }],
        metadata: {
          documentId,
          classification: entry.classification,
          requested: options.ttlSeconds,
          ceiling,
        },
      });
    }

    const expiresAt = new Date(this.now().getTime() + options.ttlSeconds * 1000);
    const filenameParam =
      options.downloadFilename !== undefined
        ? `;filename=${encodeURIComponent(options.downloadFilename)}`
        : "";
    // For test convenience, the in-memory signed URL is a stable
    // pseudo-URL that round-trips the documentId + expiry. Tests
    // assert on its shape; production adapters return a real
    // presigned URL from their bucket.
    const url = `memory://documents/${documentId}?expiresAt=${expiresAt.toISOString()}${filenameParam}`;
    return { url, expiresAt };
  }

  async delete(documentId: string, options: DocumentDeleteOptions): Promise<void> {
    this.consumePendingFailureForCall();

    if (!this.entries.has(documentId)) {
      throw new errors.NotFoundError({
        code: DOCUMENT_NOT_FOUND,
        message: `Document "${documentId}" not found.`,
        metadata: { documentId, reason: options.reason },
      });
    }
    this.entries.delete(documentId);
  }

  // -------------------------------------------------------------------------
  // Test-only helpers.
  // -------------------------------------------------------------------------

  /** Enumerate every stored document (defensive snapshot). Tests
   *  assert on what's been put. */
  list(): ReadonlyArray<{
    readonly documentId: string;
    readonly tenantId: string;
    readonly classification: DocumentClassification;
    readonly sha256: string;
    readonly fileSize: number;
  }> {
    return Array.from(this.entries.values(), (e) => ({
      documentId: e.documentId,
      tenantId: e.tenantId,
      classification: e.classification,
      sha256: e.sha256,
      fileSize: e.fileSize,
    }));
  }

  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
    this.pendingFailure = null;
  }

  /**
   * Queue a one-shot transport failure for the NEXT adapter
   * method call (put / get / signUrl / delete). Surfaces as
   * `errors.InternalError` with `DOCUMENT_TRANSPORT_ERROR` by
   * default. Tests use this to verify caller-side error handling
   * without spinning a real failing backend.
   */
  failNext(spec?: { readonly code?: string; readonly message?: string }): void {
    this.pendingFailure = {
      code: spec?.code ?? DOCUMENT_TRANSPORT_ERROR,
      message:
        spec?.message ?? "Simulated downstream transport failure (in-memory adapter failNext()).",
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers.
  // -------------------------------------------------------------------------

  private consumePendingFailureForCall(): void {
    if (this.pendingFailure === null) return;
    const failure = this.pendingFailure;
    this.pendingFailure = null;
    throw new errors.InternalError({
      code: failure.code,
      message: failure.message,
    });
  }

  private validatePutInput(input: DocumentPutInput): void {
    if (typeof input.tenantId !== "string" || input.tenantId.length === 0) {
      throw new errors.ValidationError({
        code: DOCUMENT_VALIDATION,
        message: "tenantId must be a non-empty string.",
        issues: [{ path: ["tenantId"], message: "required" }],
      });
    }
    if (!isDocumentClassification(input.classification)) {
      throw new errors.ValidationError({
        code: DOCUMENT_VALIDATION,
        message: `Unknown classification "${String(input.classification)}".`,
        issues: [{ path: ["classification"], message: "must be PHI|CONFIDENTIAL|INTERNAL|PUBLIC" }],
      });
    }
    if (typeof input.contentType !== "string" || input.contentType.length === 0) {
      throw new errors.ValidationError({
        code: DOCUMENT_VALIDATION,
        message: "contentType must be a non-empty string.",
        issues: [{ path: ["contentType"], message: "required" }],
      });
    }
    if (!(input.bytes instanceof Uint8Array)) {
      throw new errors.ValidationError({
        code: DOCUMENT_VALIDATION,
        message: "bytes must be a Uint8Array.",
        issues: [{ path: ["bytes"], message: "Uint8Array required" }],
      });
    }

    if (requiresAadBinding(input.classification) && input.aadBinding === undefined) {
      throw new errors.ValidationError({
        code: DOCUMENT_AAD_BINDING_REQUIRED,
        message: "PHI documents require an aadBinding on put().",
        issues: [{ path: ["aadBinding"], message: "required for PHI" }],
      });
    }
    if (input.classification === "PUBLIC" && input.aadBinding !== undefined) {
      throw new errors.ValidationError({
        code: DOCUMENT_AAD_BINDING_UNEXPECTED,
        message: "PUBLIC documents must not carry an aadBinding.",
        issues: [{ path: ["aadBinding"], message: "forbidden for PUBLIC" }],
      });
    }
    if (input.aadBinding !== undefined) {
      assertBindingTenantMatches(input.tenantId, input.aadBinding);
    }
  }
}

function assertBindingTenantMatches(tenantId: string, binding: AadBinding): void {
  if (binding.tenantId !== tenantId) {
    throw new errors.ValidationError({
      code: DOCUMENT_TENANT_MISMATCH,
      message: "aadBinding.tenantId must equal the document's tenantId at put().",
      issues: [{ path: ["aadBinding", "tenantId"], message: "must match tenantId" }],
      metadata: {
        expectedTenantId: tenantId,
        providedTenantId: binding.tenantId,
      },
    });
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function base64ToBytes(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}
