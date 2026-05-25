import { describe, it, expect } from "vitest";

import {
  canonicalEncodeAuditEntry,
  computeAuditEntryHash,
  TAG_ACTION,
  TAG_ACTOR_USER_ID,
  TAG_METADATA_JSON,
  TAG_OCCURRED_AT,
  TAG_ORGANIZATION_ID,
  TAG_PREV_HASH,
  TAG_RESOURCE_ID,
  TAG_RESOURCE_TYPE,
  TAG_SCOPE_JSON,
  TAG_SEQ,
  type CanonicalAuditEntry,
} from "./encoder.js";

function baseEntry(overrides: Partial<CanonicalAuditEntry> = {}): CanonicalAuditEntry {
  return {
    prevHash: null,
    organizationId: "11111111-1111-7111-a111-111111111111",
    seq: 1n,
    action: "pv1.approved",
    resourceType: "Order",
    resourceId: "22222222-2222-7222-a222-222222222222",
    actorUserId: "33333333-3333-7333-a333-333333333333",
    scope: { siteId: "site-1" },
    metadata: { commandLogId: "log-1" },
    occurredAt: new Date("2026-05-22T19:00:00.000Z"),
    ...overrides,
  };
}

describe("canonicalEncodeAuditEntry — determinism", () => {
  it("two encodes of the same input produce identical bytes", () => {
    const a = canonicalEncodeAuditEntry(baseEntry());
    const b = canonicalEncodeAuditEntry(baseEntry());
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("key ORDER in scope/metadata does not affect the output (canonical sort)", () => {
    const a = canonicalEncodeAuditEntry(
      baseEntry({ scope: { a: 1, b: 2 }, metadata: { x: "y", z: "w" } })
    );
    const b = canonicalEncodeAuditEntry(
      baseEntry({ scope: { b: 2, a: 1 }, metadata: { z: "w", x: "y" } })
    );
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});

describe("canonicalEncodeAuditEntry — field uniqueness (different inputs ≠ same bytes)", () => {
  it("changing organizationId changes the encoding", () => {
    const a = canonicalEncodeAuditEntry(baseEntry());
    const b = canonicalEncodeAuditEntry(
      baseEntry({ organizationId: "44444444-4444-7444-a444-444444444444" })
    );
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it("changing seq changes the encoding", () => {
    const a = canonicalEncodeAuditEntry(baseEntry({ seq: 1n }));
    const b = canonicalEncodeAuditEntry(baseEntry({ seq: 2n }));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it("changing action changes the encoding", () => {
    const a = canonicalEncodeAuditEntry(baseEntry({ action: "pv1.approved" }));
    const b = canonicalEncodeAuditEntry(baseEntry({ action: "pv1.rejected" }));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it("changing occurredAt by 1ms changes the encoding", () => {
    const a = canonicalEncodeAuditEntry(
      baseEntry({ occurredAt: new Date("2026-05-22T19:00:00.000Z") })
    );
    const b = canonicalEncodeAuditEntry(
      baseEntry({ occurredAt: new Date("2026-05-22T19:00:00.001Z") })
    );
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it("a present-but-null resourceId differs from a non-null resourceId", () => {
    const a = canonicalEncodeAuditEntry(baseEntry({ resourceId: null }));
    const b = canonicalEncodeAuditEntry(baseEntry({ resourceId: "" }));
    // Length sentinel 0xFFFFFFFF vs length 0 with empty payload.
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});

describe("canonicalEncodeAuditEntry — TLV shape", () => {
  it("starts with the prevHash tag byte", () => {
    const bytes = canonicalEncodeAuditEntry(baseEntry({ prevHash: null }));
    expect(bytes[0]).toBe(TAG_PREV_HASH);
  });

  it("emits fields in CANONICAL_FIELD_ORDER (prevHash → organizationId → seq → action → resourceType → resourceId → actorUserId → scope → metadata → occurredAt)", () => {
    const bytes = canonicalEncodeAuditEntry(baseEntry());
    // Walk the TLV stream and collect tag bytes in order.
    // NOTE on the `>>> 0`: JS bitwise OR returns a SIGNED int32, so
    // 0xFFFFFFFF reads as -1. We force unsigned via `>>> 0` before
    // comparing to the NULL_LENGTH sentinel (0xFFFFFFFF).
    const tags: number[] = [];
    let i = 0;
    while (i < bytes.length) {
      const tag = bytes[i];
      if (tag === undefined) break;
      tags.push(tag);
      const len =
        (((bytes[i + 1] ?? 0) << 24) |
          ((bytes[i + 2] ?? 0) << 16) |
          ((bytes[i + 3] ?? 0) << 8) |
          (bytes[i + 4] ?? 0)) >>>
        0;
      const payloadLen = len === 0xffffffff ? 0 : len;
      i += 5 + payloadLen;
    }
    expect(tags).toEqual([
      TAG_PREV_HASH,
      TAG_ORGANIZATION_ID,
      TAG_SEQ,
      TAG_ACTION,
      TAG_RESOURCE_TYPE,
      TAG_RESOURCE_ID,
      TAG_ACTOR_USER_ID,
      TAG_SCOPE_JSON,
      TAG_METADATA_JSON,
      TAG_OCCURRED_AT,
    ]);
  });

  it("seq is encoded as exactly 8 big-endian bytes", () => {
    const bytes = canonicalEncodeAuditEntry(baseEntry({ seq: 1n }));
    // Locate the TAG_SEQ position by walking the TLV stream.
    // See the `>>> 0` note in the prior test.
    let i = 0;
    while (i < bytes.length) {
      if (bytes[i] === TAG_SEQ) break;
      const len =
        (((bytes[i + 1] ?? 0) << 24) |
          ((bytes[i + 2] ?? 0) << 16) |
          ((bytes[i + 3] ?? 0) << 8) |
          (bytes[i + 4] ?? 0)) >>>
        0;
      const payloadLen = len === 0xffffffff ? 0 : len;
      i += 5 + payloadLen;
    }
    const lenAtSeq =
      (((bytes[i + 1] ?? 0) << 24) |
        ((bytes[i + 2] ?? 0) << 16) |
        ((bytes[i + 3] ?? 0) << 8) |
        (bytes[i + 4] ?? 0)) >>>
      0;
    expect(lenAtSeq).toBe(8);
    // The 8-byte payload should encode 1 in big-endian (7 zero bytes + 0x01).
    expect(bytes.slice(i + 5, i + 13)).toEqual(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]));
  });
});

describe("canonicalEncodeAuditEntry — JSON canonicalization", () => {
  it("rejects bigint inside scope/metadata (must be encoded as string first)", () => {
    expect(() =>
      canonicalEncodeAuditEntry(baseEntry({ scope: { id: 1n } as unknown as object }))
    ).toThrow(/bigint/i);
  });

  it("treats undefined and null scope identically (both → NULL sentinel)", () => {
    const a = canonicalEncodeAuditEntry(baseEntry({ scope: undefined }));
    const b = canonicalEncodeAuditEntry(baseEntry({ scope: null }));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("preserves array order (arrays are NOT sorted)", () => {
    const a = canonicalEncodeAuditEntry(baseEntry({ metadata: { items: [1, 2, 3] } }));
    const b = canonicalEncodeAuditEntry(baseEntry({ metadata: { items: [3, 2, 1] } }));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});

describe("canonicalEncodeAuditEntry — bounds", () => {
  it("rejects negative seq", () => {
    expect(() => canonicalEncodeAuditEntry(baseEntry({ seq: -1n }))).toThrow(/uint64 range/);
  });

  it("rejects seq above uint64 max", () => {
    expect(() => canonicalEncodeAuditEntry(baseEntry({ seq: 0xffffffffffffffffn + 1n }))).toThrow(
      /uint64 range/
    );
  });
});

describe("computeAuditEntryHash", () => {
  it("returns a 32-byte SHA-256 digest", () => {
    const hash = computeAuditEntryHash(baseEntry());
    expect(hash.length).toBe(32);
  });

  it("is deterministic for the same entry", () => {
    const a = computeAuditEntryHash(baseEntry());
    const b = computeAuditEntryHash(baseEntry());
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("differs when ANY tracked field changes (avalanche)", () => {
    const base = computeAuditEntryHash(baseEntry());
    const variants: CanonicalAuditEntry[] = [
      baseEntry({ organizationId: "44444444-4444-7444-a444-444444444444" }),
      baseEntry({ seq: 2n }),
      baseEntry({ action: "pv1.rejected" }),
      baseEntry({ resourceType: "Prescription" }),
      baseEntry({ resourceId: null }),
      baseEntry({ actorUserId: null }),
      baseEntry({ scope: { siteId: "site-2" } }),
      baseEntry({ metadata: { commandLogId: "log-2" } }),
      baseEntry({ occurredAt: new Date("2026-05-22T19:00:00.001Z") }),
      baseEntry({ prevHash: new Uint8Array(32).fill(0xff) }),
    ];
    for (const v of variants) {
      const h = computeAuditEntryHash(v);
      expect(Buffer.from(h).equals(Buffer.from(base))).toBe(false);
    }
  });

  it("chains: an entry's hash depends on prevHash so swapping prev breaks the chain", () => {
    const entry = baseEntry();
    const h1 = computeAuditEntryHash({ ...entry, prevHash: new Uint8Array(32).fill(0x01) });
    const h2 = computeAuditEntryHash({ ...entry, prevHash: new Uint8Array(32).fill(0x02) });
    expect(Buffer.from(h1).equals(Buffer.from(h2))).toBe(false);
  });
});
