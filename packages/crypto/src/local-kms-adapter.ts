// LocalKmsAdapter — deterministic, in-process KMS for dev and test.
//
// **NEVER ship this to production.** It holds key material in process
// memory and derives KEKs from a single seed. Its purpose is to make
// the encryption layer work identically to production without
// requiring a real KMS service for local development and the test
// suite.
//
// Design:
//
//   - The adapter is constructed with a 32-byte master seed (UTF-8
//     string is accepted for ergonomics and hashed to 32 bytes).
//   - For every `(tenantId, kekVersion)`, we derive a 32-byte KEK
//     via HKDF-SHA256 with `info = "kek:" + tenantId + ":v" + n`.
//     Determinism: same seed + same inputs always produces the same
//     KEK, which is essential for tests that need stable ciphertexts.
//   - KEK rotation: `rotateKek(tenantId)` bumps an in-memory version
//     counter for that tenant. Subsequent `generateDataKey` calls
//     use the new KEK; old wrapped DEKs continue to unwrap using the
//     old version, looked up via the `kid` carried in the envelope.
//   - Search keys: separate HKDF derivation with `info =
//     "search:" + tenantId + ":" + purpose`. Independent of KEKs so
//     KEK rotation does not invalidate the blind indexes (those
//     have their own rotation lifecycle).
//   - KEK-wrap uses AES-256-GCM with a fresh IV every wrap; the IV
//     + tag are prepended to the wrapped DEK bytes:
//
//         wrappedDek = [iv:12][tag:16][ciphertext:32] = 60 bytes
//
// AWS KMS analog: production's `generateDataKey` returns a wrapped
// DEK as opaque bytes; we mirror that interface. The exact wrap
// algorithm differs — AWS uses CMK-bound asymmetric wrapping — but
// the adapter interface hides it from the caller.

import {
  createHmac,
  hkdfSync,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from "node:crypto";

import { cryptoValidationError, kmsKeyNotFoundError } from "./errors.js";
import type {
  DeriveSearchKeyInput,
  GenerateDataKeyResult,
  KmsAdapter,
  UnwrapDataKeyInput,
} from "./kms-adapter.js";

const KEK_BYTES = 32;
const DEK_BYTES = 32;
const WRAP_IV_BYTES = 12;
const WRAP_TAG_BYTES = 16;

interface TenantState {
  /** Latest KEK version for this tenant. Starts at 1. */
  version: number;
}

export interface LocalKmsAdapterOptions {
  /**
   * Master seed. Accepts either a Buffer (>= 32 bytes recommended)
   * or a UTF-8 string (hashed to 32 bytes via HKDF). The seed MUST
   * be the same across processes that need to interop (e.g. apps/web
   * and apps/worker in the same dev environment).
   *
   * In tests, prefer a fixed string like `"test-kms-seed"`. In dev,
   * supply via `PHARMAX_LOCAL_KMS_SEED` env var.
   */
  readonly seed: Buffer | string;
}

export class LocalKmsAdapter implements KmsAdapter {
  private readonly seed: Buffer;
  private readonly tenants = new Map<string, TenantState>();

  public constructor(options: LocalKmsAdapterOptions) {
    const raw = typeof options.seed === "string" ? Buffer.from(options.seed, "utf8") : options.seed;
    if (raw.length === 0) {
      throw cryptoValidationError({ field: "seed", reason: "must be non-empty" });
    }
    // Normalize to 32 bytes via HKDF expand so the seed length doesn't matter.
    this.seed = Buffer.from(
      hkdfSync(
        "sha256",
        raw,
        Buffer.alloc(0),
        Buffer.from("pharmax.local-kms.master.v1", "utf8"),
        32
      )
    );
  }

  /**
   * Test-only: replace the current KEK version for a tenant. Bumping
   * is the production flow; setting to a specific version is the
   * shortcut for "decrypt this old envelope" tests.
   */
  public rotateKek(input: { readonly tenantId: string }): { readonly kid: string } {
    requireTenantId(input.tenantId);
    const state = this.tenants.get(input.tenantId) ?? { version: 1 };
    state.version += 1;
    this.tenants.set(input.tenantId, state);
    return { kid: this.kidFor(input.tenantId, state.version) };
  }

  public async currentKid(input: { readonly tenantId: string }): Promise<string> {
    requireTenantId(input.tenantId);
    const state = this.ensureTenant(input.tenantId);
    return this.kidFor(input.tenantId, state.version);
  }

  public async generateDataKey(input: {
    readonly tenantId: string;
  }): Promise<GenerateDataKeyResult> {
    requireTenantId(input.tenantId);
    const state = this.ensureTenant(input.tenantId);
    const kid = this.kidFor(input.tenantId, state.version);
    const kek = this.deriveKek(input.tenantId, state.version);

    const plaintextDek = randomBytes(DEK_BYTES);
    const wrappedDek = wrap(kek, plaintextDek);

    return { kid, plaintextDek, wrappedDek };
  }

  public async unwrapDataKey(input: UnwrapDataKeyInput): Promise<Buffer> {
    requireTenantId(input.tenantId);
    const parsed = parseKid(input.kid);
    if (parsed === null || parsed.tenantId !== input.tenantId) {
      throw kmsKeyNotFoundError({ tenantId: input.tenantId, kid: input.kid });
    }
    const kek = this.deriveKek(parsed.tenantId, parsed.version);
    return unwrap(kek, input.wrappedDek);
  }

  public async deriveSearchKey(input: DeriveSearchKeyInput): Promise<Buffer> {
    requireTenantId(input.tenantId);
    if (typeof input.purpose !== "string" || input.purpose.length === 0) {
      throw cryptoValidationError({ field: "purpose", reason: "must be non-empty" });
    }
    const info = Buffer.from(`pharmax.search.v1.${input.tenantId}.${input.purpose}`, "utf8");
    return Buffer.from(hkdfSync("sha256", this.seed, Buffer.alloc(0), info, 32));
  }

  // ---- private helpers ----

  private ensureTenant(tenantId: string): TenantState {
    let state = this.tenants.get(tenantId);
    if (state === undefined) {
      state = { version: 1 };
      this.tenants.set(tenantId, state);
    }
    return state;
  }

  private kidFor(tenantId: string, version: number): string {
    return `kek:${tenantId}:v${version}`;
  }

  private deriveKek(tenantId: string, version: number): Buffer {
    const info = Buffer.from(`pharmax.kek.v1.${tenantId}.v${version}`, "utf8");
    return Buffer.from(hkdfSync("sha256", this.seed, Buffer.alloc(0), info, KEK_BYTES));
  }
}

// ---------------------------------------------------------------------------
// Wrap / unwrap helpers (AES-256-GCM, no AAD on the wrap step).
// ---------------------------------------------------------------------------

function wrap(kek: Buffer, plaintextDek: Buffer): Buffer {
  const iv = randomBytes(WRAP_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", kek, iv);
  const ct = Buffer.concat([cipher.update(plaintextDek), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

function unwrap(kek: Buffer, wrapped: Buffer): Buffer {
  if (wrapped.length !== WRAP_IV_BYTES + WRAP_TAG_BYTES + DEK_BYTES) {
    throw cryptoValidationError({
      field: "wrappedDek",
      reason: `unexpected length ${wrapped.length}`,
    });
  }
  const iv = wrapped.subarray(0, WRAP_IV_BYTES);
  const tag = wrapped.subarray(WRAP_IV_BYTES, WRAP_IV_BYTES + WRAP_TAG_BYTES);
  const ct = wrapped.subarray(WRAP_IV_BYTES + WRAP_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", kek, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

// ---------------------------------------------------------------------------
// kid parsing.
// ---------------------------------------------------------------------------

const KID_RE = /^kek:([^:]+):v(\d+)$/;

interface ParsedKid {
  readonly tenantId: string;
  readonly version: number;
}

function parseKid(kid: string): ParsedKid | null {
  const m = KID_RE.exec(kid);
  if (m === null) return null;
  const tenantId = m[1];
  const versionStr = m[2];
  if (tenantId === undefined || versionStr === undefined) return null;
  const version = Number.parseInt(versionStr, 10);
  if (!Number.isFinite(version) || version < 1) return null;
  return { tenantId, version };
}

function requireTenantId(tenantId: string): void {
  if (typeof tenantId !== "string" || tenantId.length === 0) {
    throw cryptoValidationError({ field: "tenantId", reason: "must be non-empty" });
  }
}

// ---------------------------------------------------------------------------
// Time-safe equality helper, exported for test ergonomics. Not part
// of the public surface beyond the package; used internally if we
// want to compare derived keys.
// ---------------------------------------------------------------------------

export function timingSafeEqualBuffers(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Re-export HMAC for callers that want to assemble a per-purpose
// keyed HMAC without going through `blindIndex` (rare; mostly for
// the test suite to verify the derived key actually works).
export function hmacSha256(key: Buffer, data: Buffer): Buffer {
  return createHmac("sha256", key).update(data).digest();
}
