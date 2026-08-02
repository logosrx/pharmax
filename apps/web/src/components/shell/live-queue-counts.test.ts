// Pure-helper tests for the live-counts client module (ADR-0034).
// The provider/hook are exercised in the browser; the summation and
// change-signature logic is where the correctness risk sits.

import { describe, expect, it } from "vitest";

import { bucketsSignature, sumLiveCounts, type LiveBuckets } from "./live-queue-counts.js";

const BUCKETS: LiveBuckets = Object.freeze({
  INBOX: { count: 3, changedAt: "2026-07-31T00:00:00.000Z" },
  TYPING: { count: 2, changedAt: null },
  PV1: null, // provisionable but absent for this org
});

describe("sumLiveCounts", () => {
  it("sums the codes that resolve", () => {
    expect(sumLiveCounts(BUCKETS, ["INBOX", "TYPING"])).toBe(5);
  });

  it("skips unprovisioned and unknown codes but still sums the rest", () => {
    expect(sumLiveCounts(BUCKETS, ["INBOX", "PV1", "NOPE"])).toBe(3);
  });

  it("returns null when NO code resolves (caller falls back to the SSR seed)", () => {
    expect(sumLiveCounts(BUCKETS, ["PV1", "NOPE"])).toBeNull();
    expect(sumLiveCounts(BUCKETS, [])).toBeNull();
  });
});

describe("bucketsSignature", () => {
  it("is stable for the same slice", () => {
    expect(bucketsSignature(BUCKETS, ["INBOX", "TYPING"])).toBe(
      bucketsSignature(BUCKETS, ["INBOX", "TYPING"])
    );
  });

  it("changes when a count changes", () => {
    const moved: LiveBuckets = { ...BUCKETS, TYPING: { count: 3, changedAt: null } };
    expect(bucketsSignature(moved, ["INBOX", "TYPING"])).not.toBe(
      bucketsSignature(BUCKETS, ["INBOX", "TYPING"])
    );
  });

  it("changes when only changedAt moves (count-stable claim under a combined badge)", () => {
    const claimed: LiveBuckets = {
      ...BUCKETS,
      INBOX: { count: 3, changedAt: "2026-07-31T00:00:09.000Z" },
    };
    expect(bucketsSignature(claimed, ["INBOX", "TYPING"])).not.toBe(
      bucketsSignature(BUCKETS, ["INBOX", "TYPING"])
    );
  });

  it("ignores buckets outside the watched slice", () => {
    const otherBucketMoved: LiveBuckets = {
      ...BUCKETS,
      TYPING: { count: 99, changedAt: "2026-07-31T01:00:00.000Z" },
    };
    expect(bucketsSignature(otherBucketMoved, ["INBOX"])).toBe(
      bucketsSignature(BUCKETS, ["INBOX"])
    );
  });

  it("distinguishes unprovisioned (null) from empty (count 0)", () => {
    const empty: LiveBuckets = { PV1: { count: 0, changedAt: null } };
    expect(bucketsSignature(empty, ["PV1"])).not.toBe(bucketsSignature(BUCKETS, ["PV1"]));
  });
});
