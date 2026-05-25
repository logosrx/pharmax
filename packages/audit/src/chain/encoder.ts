// Canonical encoder for audit_log entries.
//
// The byte sequence produced by `canonicalEncodeAuditEntry` is the
// EXACT input to SHA-256 for the chain hash. The verifier re-encodes
// each row from its persisted fields and checks the resulting hash
// against the stored `entryHash`. Any divergence between writer and
// verifier breaks the chain — therefore this encoder is held under
// the same SOC-2-grade change control as schema migrations.
//
// Format (TLV-style, all integers big-endian):
//
//   uint8   field_tag       — see TAG_* constants below
//   uint32  field_length    — byte length of the value (max 2^32-1)
//   bytes   field_value     — value bytes
//
// Fields are emitted in the order declared in CANONICAL_FIELD_ORDER.
// NULL/undefined values are emitted as TAG with length=0xFFFFFFFF
// (sentinel) — distinguishable from an empty value (length=0).
//
// Strings are UTF-8 encoded. BigInt seq is encoded as a fixed 8-byte
// big-endian unsigned. Timestamps are encoded as an ISO-8601 string
// (millisecond precision, UTC, no trailing zeros) — chosen over
// epoch-ms so a human-readable verifier output is possible.
//
// JSON columns (`scope`, `metadata`) are canonicalized: object keys
// sorted lexicographically (UTF-16 code unit), null/undefined values
// retained (sorted last), arrays preserved in declared order. This
// matches @pharmax/command-bus's `canonicalStringify` semantics.

import { createHash } from "node:crypto";

/** Field-tag bytes. NEVER renumber; ALWAYS append. */
export const TAG_PREV_HASH = 0x01;
export const TAG_ORGANIZATION_ID = 0x02;
export const TAG_SEQ = 0x03;
export const TAG_ACTION = 0x04;
export const TAG_RESOURCE_TYPE = 0x05;
export const TAG_RESOURCE_ID = 0x06;
export const TAG_ACTOR_USER_ID = 0x07;
export const TAG_SCOPE_JSON = 0x08;
export const TAG_METADATA_JSON = 0x09;
export const TAG_OCCURRED_AT = 0x0a;

/**
 * The canonical input to the encoder. Every field is required (use
 * `null` for absent values — the encoder distinguishes "field
 * present but null" from "field omitted"; omitting is not allowed).
 */
export interface CanonicalAuditEntry {
  readonly prevHash: Uint8Array | null;
  readonly organizationId: string;
  readonly seq: bigint;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly actorUserId: string | null;
  readonly scope: unknown;
  readonly metadata: unknown;
  /** Must be a real Date (the writer normalizes server-side `now()`). */
  readonly occurredAt: Date;
}

/** Length sentinel for NULL-valued fields. Distinguishable from 0. */
const NULL_LENGTH = 0xffffffff;

/**
 * Produce the canonical byte encoding of an audit entry. Pure, no
 * I/O. The verifier must call this with the same inputs and compare
 * SHA-256 outputs.
 */
export function canonicalEncodeAuditEntry(entry: CanonicalAuditEntry): Uint8Array {
  const chunks: Uint8Array[] = [];

  appendBytes(chunks, TAG_PREV_HASH, entry.prevHash);
  appendString(chunks, TAG_ORGANIZATION_ID, entry.organizationId);
  appendBigIntU64(chunks, TAG_SEQ, entry.seq);
  appendString(chunks, TAG_ACTION, entry.action);
  appendString(chunks, TAG_RESOURCE_TYPE, entry.resourceType);
  appendString(chunks, TAG_RESOURCE_ID, entry.resourceId);
  appendString(chunks, TAG_ACTOR_USER_ID, entry.actorUserId);
  appendJson(chunks, TAG_SCOPE_JSON, entry.scope);
  appendJson(chunks, TAG_METADATA_JSON, entry.metadata);
  appendString(chunks, TAG_OCCURRED_AT, entry.occurredAt.toISOString());

  return concat(chunks);
}

/**
 * Convenience: encode + SHA-256. Returns a 32-byte Uint8Array
 * suitable for storage in `audit_log.entryHash`.
 */
export function computeAuditEntryHash(entry: CanonicalAuditEntry): Uint8Array {
  const encoded = canonicalEncodeAuditEntry(entry);
  return new Uint8Array(createHash("sha256").update(encoded).digest());
}

// ---------------------------------------------------------------------
// Internal field appenders.
// ---------------------------------------------------------------------

function appendBytes(chunks: Uint8Array[], tag: number, value: Uint8Array | null): void {
  const header = new Uint8Array(5);
  header[0] = tag;
  const length = value === null ? NULL_LENGTH : value.length;
  writeU32BE(header, 1, length);
  chunks.push(header);
  if (value !== null && value.length > 0) chunks.push(value);
}

function appendString(chunks: Uint8Array[], tag: number, value: string | null): void {
  if (value === null) {
    appendBytes(chunks, tag, null);
    return;
  }
  appendBytes(chunks, tag, new TextEncoder().encode(value));
}

function appendBigIntU64(chunks: Uint8Array[], tag: number, value: bigint): void {
  if (value < 0n || value > 0xffffffffffffffffn) {
    throw new RangeError(`canonicalEncodeAuditEntry: seq out of uint64 range: ${value}`);
  }
  const buf = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) {
    buf[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  appendBytes(chunks, tag, buf);
}

function appendJson(chunks: Uint8Array[], tag: number, value: unknown): void {
  if (value === undefined || value === null) {
    appendBytes(chunks, tag, null);
    return;
  }
  const canonical = canonicalJsonStringify(value);
  appendBytes(chunks, tag, new TextEncoder().encode(canonical));
}

function writeU32BE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

function concat(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * Canonical JSON encoding. Keys are emitted in sorted order; arrays
 * preserve declared order; numbers use JSON.stringify formatting;
 * BigInt is rejected (callers must encode it explicitly as a string
 * BEFORE handing it to the encoder). Matches the contract of
 * @pharmax/command-bus's hash.ts encoder.
 */
function canonicalJsonStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "bigint") {
    throw new TypeError(
      "canonicalJsonStringify: bigint is not JSON-serializable; encode as string first."
    );
  }
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJsonStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalJsonStringify(obj[k])}`);
  return `{${parts.join(",")}}`;
}
