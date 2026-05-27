// In-memory PackagePhotoStorage adapter.
//
// Used by tests and ephemeral local dev. Stores uploads in a
// per-instance Map keyed by `uploadToken`. NOT suitable for
// production:
//
//   - No persistence (process restart loses everything).
//   - No expiry (token Map grows unbounded; tests should construct
//     a fresh adapter per test or call `clear()`).
//   - No signed URLs (callers receive the bytes back via
//     `getBytesByKey` for assertion convenience).
//
// The adapter is `final`-ish in spirit: the production S3 adapter
// will live in a sibling file and be wired at boot. Both
// implement the same `PackagePhotoStorage` interface.

import { createHash, randomUUID } from "node:crypto";

import type {
  PackagePhotoStorage,
  PackagePhotoUploadInput,
  PackagePhotoUploadResult,
  ResolvedPackagePhotoUpload,
} from "./package-photo-storage.js";

/**
 * Storage entry recorded by `beginUpload`. Tests can read these
 * back via the public accessors below to assert on what the
 * adapter saw.
 */
interface InMemoryEntry {
  readonly uploadToken: string;
  readonly organizationId: string;
  readonly bucket: string;
  readonly key: string;
  readonly contentType: string;
  readonly sha256: string;
  readonly fileSize: number;
  readonly bytes: Uint8Array;
}

/** Constructor options. The bucket name is shared across uploads
 *  (one logical bucket per environment); the test default is
 *  `"pharmax-package-photos-inmemory"`. */
export interface InMemoryPackagePhotoStorageOptions {
  readonly bucket?: string;
}

export class InMemoryPackagePhotoStorage implements PackagePhotoStorage {
  // Token → entry. The map is the source of truth; the byKey
  // index below is a secondary view for retrieval-by-key access.
  private readonly byToken = new Map<string, InMemoryEntry>();
  private readonly byKey = new Map<string, InMemoryEntry>();
  private readonly bucket: string;

  constructor(options?: InMemoryPackagePhotoStorageOptions) {
    this.bucket = options?.bucket ?? "pharmax-package-photos-inmemory";
  }

  async beginUpload(input: PackagePhotoUploadInput): Promise<PackagePhotoUploadResult> {
    const sha256 = sha256Hex(input.bytes);
    // The key shape mirrors the prod convention: org-prefixed +
    // sha-prefixed for path-safety + dedup-friendly listing.
    const key = `org/${input.organizationId}/photo/${sha256}`;
    const uploadToken = randomUUID();

    const entry: InMemoryEntry = {
      uploadToken,
      organizationId: input.organizationId,
      bucket: this.bucket,
      key,
      contentType: input.contentType,
      sha256,
      fileSize: input.bytes.byteLength,
      bytes: input.bytes,
    };
    this.byToken.set(uploadToken, entry);
    // If two callers upload the same bytes, the LATER call wins
    // the byKey slot. That's fine: the bytes are identical, the
    // sha256 is identical, and the command's
    // `(organizationId, sha256)` unique index will dedupe at the
    // DB layer. Tests that care about token identity should keep
    // their own reference returned from `beginUpload`.
    this.byKey.set(key, entry);

    return {
      uploadToken,
      bucket: entry.bucket,
      key: entry.key,
      sha256: entry.sha256,
      fileSize: entry.fileSize,
      contentType: entry.contentType,
    };
  }

  async resolveUploadToken(token: string): Promise<ResolvedPackagePhotoUpload | null> {
    const entry = this.byToken.get(token);
    if (entry === undefined) return null;
    return {
      bucket: entry.bucket,
      key: entry.key,
      sha256: entry.sha256,
      fileSize: entry.fileSize,
      contentType: entry.contentType,
      organizationId: entry.organizationId,
    };
  }

  /** Read-out for tests. Returns the raw bytes uploaded against a
   *  storage key, or undefined if none exist. */
  getBytesByKey(key: string): Uint8Array | undefined {
    return this.byKey.get(key)?.bytes;
  }

  /** Read-out for tests. Returns the number of upload entries
   *  recorded so far. */
  size(): number {
    return this.byToken.size;
  }

  /** Drop all entries. Useful between tests. */
  clear(): void {
    this.byToken.clear();
    this.byKey.clear();
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
