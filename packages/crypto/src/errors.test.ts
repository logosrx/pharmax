// @pharmax/crypto error-factory contract.
//
// These pin the factory surface itself, independent of any adapter:
//
//   - `cause` is OPTIONAL, so the widening did not break the callers
//     that predate it (`LocalKmsAdapter`, the unwrap-path kid checks).
//   - `cause` reaches `Error.cause` and NOT `metadata`. The metadata
//     object is the indexed surface — log fields, alarm dimensions,
//     `toJSON` output — and a provider error message can echo request
//     detail. Anything that leaks the cause into metadata is a PHI
//     and secret-hygiene regression, not just untidy.
//   - The no-reason message is byte-identical to the pre-widening
//     message, because operators grep for it and the RUNBOOK quotes
//     it.

import { describe, expect, it } from "vitest";

import {
  KMS_ACCESS_DENIED,
  KMS_KEY_NOT_FOUND,
  decryptFailedError,
  kmsAccessDeniedError,
  kmsKeyNotFoundError,
} from "./errors.js";

const KID = "aws:kek:app-phi:org-1:v1";

describe("kmsKeyNotFoundError", () => {
  it("is callable with only the pre-existing fields", () => {
    const error = kmsKeyNotFoundError({ tenantId: "org-1", kid: KID });
    expect(error.code).toBe(KMS_KEY_NOT_FOUND);
    expect(error.message).toBe(`KMS could not resolve key "${KID}" for tenant.`);
    expect(error.cause).toBeUndefined();
    expect(error.metadata).toEqual({ tenantId: "org-1", kid: KID });
  });

  it("threads `cause` onto Error.cause without copying it into metadata", () => {
    const cause = new Error("AWS said something that may echo request detail");
    const error = kmsKeyNotFoundError({ tenantId: "org-1", kid: KID, cause });
    expect(error.cause).toBe(cause);
    expect(Object.keys(error.metadata)).toEqual(["tenantId", "kid"]);
    expect(JSON.stringify(error.metadata)).not.toContain("echo request detail");
  });

  it("folds `reason` into the message and leaves it out of metadata", () => {
    const error = kmsKeyNotFoundError({
      tenantId: "(boot)",
      kid: "alias/pharmax/data-key",
      reason: "DescribeKey failed for dataKeyKeyId",
    });
    expect(error.message).toBe(
      'KMS could not resolve key "alias/pharmax/data-key" for tenant: DescribeKey failed for dataKeyKeyId'
    );
    expect(error.metadata).not.toHaveProperty("reason");
  });

  it("indexes `awsErrorName` because it is a bounded, non-sensitive value", () => {
    const error = kmsKeyNotFoundError({
      tenantId: "(boot)",
      kid: "alias/pharmax/data-key",
      awsErrorName: "NotFoundException",
    });
    expect(error.metadata.awsErrorName).toBe("NotFoundException");
  });

  it("omits `awsErrorName` entirely rather than storing undefined", () => {
    const error = kmsKeyNotFoundError({ tenantId: "org-1", kid: KID });
    expect("awsErrorName" in error.metadata).toBe(false);
  });

  it("pages: still an unexpected 500", () => {
    const error = kmsKeyNotFoundError({ tenantId: "org-1", kid: KID });
    expect(error.httpStatus).toBe(500);
    expect(error.category).toBe("unexpected");
  });
});

describe("kmsAccessDeniedError", () => {
  it("carries its own code so alarms and runbooks can route on it", () => {
    const error = kmsAccessDeniedError({ tenantId: "(boot)", kid: "alias/pharmax/data-key" });
    expect(error.code).toBe(KMS_ACCESS_DENIED);
    expect(error.code).not.toBe(KMS_KEY_NOT_FOUND);
  });

  it("does not describe an authorization failure as a missing key", () => {
    const error = kmsAccessDeniedError({ tenantId: "(boot)", kid: "alias/pharmax/data-key" });
    expect(error.message).not.toContain("could not resolve");
  });

  it("has the same cause/metadata discipline as its sibling", () => {
    const cause = new Error("not authorized to perform kms:DescribeKey");
    const error = kmsAccessDeniedError({
      tenantId: "(boot)",
      kid: "alias/pharmax/data-key",
      awsErrorName: "AccessDeniedException",
      cause,
    });
    expect(error.cause).toBe(cause);
    expect(error.metadata).toEqual({
      tenantId: "(boot)",
      kid: "alias/pharmax/data-key",
      awsErrorName: "AccessDeniedException",
    });
  });

  it("pages the same way (500 / unexpected) — the split changes routing, not severity", () => {
    const error = kmsAccessDeniedError({ tenantId: "(boot)", kid: "k" });
    expect(error.httpStatus).toBe(500);
    expect(error.category).toBe("unexpected");
  });
});

describe("decryptFailedError", () => {
  const base = {
    reason: "kms.decrypt failed",
    tenantId: "org-1",
    table: "patient",
    column: "first_name",
    recordId: "01JJ0000000000000000000000",
  } as const;

  it("is callable without a cause", () => {
    const error = decryptFailedError(base);
    expect(error.cause).toBeUndefined();
  });

  it("threads a cause without widening metadata", () => {
    const cause = new Error("InvalidCiphertextException");
    const error = decryptFailedError({ ...base, cause });
    expect(error.cause).toBe(cause);
    expect(Object.keys(error.metadata).sort()).toEqual(["column", "recordId", "table", "tenantId"]);
  });
});
