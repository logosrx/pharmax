// Bucket guard tests.
//
// The point of this file is the COVERAGE regression: RESERVED_BUCKET_CODES
// is derived from the workflow maps rather than hand-listed, and these
// tests pin that derivation. If someone later adds a
// `BUCKET_CODE_FOR_STATUS` entry introducing a new code and the
// derivation is quietly replaced with a literal array, the first test
// here goes red — before an admin can mint a custom bucket that the
// workflow engine is about to start routing live orders into.

import { describe, expect, it } from "vitest";

import { BucketKind } from "@pharmax/database";
import { BUCKET_CODE_FOR_EXCEPTION_STATE, BUCKET_CODE_FOR_STATUS } from "@pharmax/workflow";

import { DEFAULT_BUCKET_CODES } from "../commands/provision-default-buckets.js";
import {
  ASSIGNABLE_BUCKET_KINDS,
  BUCKET_CODE_REGEX,
  isReservedBucketCode,
  isReservedBucketKind,
  RESERVED_BUCKET_CODES,
  RESERVED_BUCKET_KINDS,
  SYSTEM_BUCKET_MUTABLE_FIELDS,
} from "./bucket-guards.js";

describe("RESERVED_BUCKET_CODES", () => {
  it("covers every code the workflow engine routes primary states into", () => {
    for (const code of Object.values(BUCKET_CODE_FOR_STATUS)) {
      expect(isReservedBucketCode(code)).toBe(true);
    }
  });

  it("covers every code the workflow engine routes exception states into", () => {
    for (const code of Object.values(BUCKET_CODE_FOR_EXCEPTION_STATE)) {
      if (code === undefined) continue;
      expect(isReservedBucketCode(code)).toBe(true);
    }
  });

  it("covers every canonical bucket ProvisionDefaultBuckets seeds", () => {
    for (const code of DEFAULT_BUCKET_CODES) {
      expect(isReservedBucketCode(code)).toBe(true);
    }
  });

  it("reserves exactly the seven seeded codes today", () => {
    expect([...RESERVED_BUCKET_CODES].sort()).toEqual([
      "EMERGENCY",
      "FILL",
      "FINAL",
      "INBOX",
      "PV1",
      "SHIPPING",
      "TYPING",
    ]);
  });

  it("leaves org-specific codes free", () => {
    for (const code of ["PRIOR_AUTH", "COMPOUNDING_QUEUE", "CLINIC_CALLBACK", "NIGHT_SHIFT"]) {
      expect(isReservedBucketCode(code)).toBe(false);
    }
  });
});

describe("RESERVED_BUCKET_KINDS", () => {
  it("reserves the kinds a platform subsystem selects on", () => {
    // EMERGENCY: emergency-bucket-counts selects buckets by this kind
    // alone, org-wide. WORKFLOW: asserts engine routing, which only
    // ever happens for the reserved codes.
    expect(isReservedBucketKind(BucketKind.EMERGENCY)).toBe(true);
    expect(isReservedBucketKind(BucketKind.WORKFLOW)).toBe(true);
  });

  it("leaves the operational kinds assignable", () => {
    for (const kind of [BucketKind.CUSTOM, BucketKind.HOLD, BucketKind.EXCEPTION]) {
      expect(isReservedBucketKind(kind)).toBe(false);
    }
  });

  it("partitions BucketKind exhaustively into reserved and assignable", () => {
    const all = Object.values(BucketKind);
    const partitioned = [...RESERVED_BUCKET_KINDS, ...ASSIGNABLE_BUCKET_KINDS].sort();
    expect(partitioned).toEqual([...all].sort());
  });
});

describe("SYSTEM_BUCKET_MUTABLE_FIELDS", () => {
  it("permits display-plane fields only", () => {
    expect([...SYSTEM_BUCKET_MUTABLE_FIELDS]).toEqual(["name", "sortOrder"]);
  });

  it("never permits the two control-plane fields", () => {
    const mutable: ReadonlyArray<string> = SYSTEM_BUCKET_MUTABLE_FIELDS;
    expect(mutable).not.toContain("code");
    expect(mutable).not.toContain("kind");
  });
});

describe("BUCKET_CODE_REGEX", () => {
  it("accepts SCREAMING_SNAKE codes shaped like the seeded ones", () => {
    for (const code of ["INBOX", "PV1", "PRIOR_AUTH", "Q2", "A_1_B"]) {
      expect(BUCKET_CODE_REGEX.test(code)).toBe(true);
    }
  });

  it("rejects lowercase, leading digits, spaces, dashes, and single chars", () => {
    for (const code of ["lower", "1ABC", "HAS SPACE", "HAS-DASH", "X", ""]) {
      expect(BUCKET_CODE_REGEX.test(code)).toBe(false);
    }
  });
});
