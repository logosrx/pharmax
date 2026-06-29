// Unit tests for the shared KMS adapter decision tree.
//
// Covers the non-AWS branches end-to-end (no network): dev/test seed
// → LocalKmsAdapter, production without AWS env → throw, dev without
// any config → throw. The AWS-present branches call out to KMS
// (`validate()`), so they are exercised by the apps' integration
// boots, not here. Also pins the `parsePreviousDataKeyKeyIds` parser
// that was previously copy-pasted into both apps.

import { describe, expect, it, vi } from "vitest";

import {
  buildKmsAdapterFromEnv,
  parsePreviousDataKeyKeyIds,
  type KmsAdapterEnv,
} from "./build-kms-adapter.js";

const SEED = "0123456789abcdef0123456789abcdef"; // 32 chars

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

describe("buildKmsAdapterFromEnv", () => {
  it("dev with a valid seed → LocalKmsAdapter", async () => {
    const env: KmsAdapterEnv = { NODE_ENV: "development", PHARMAX_LOCAL_KMS_SEED: SEED };
    const result = await buildKmsAdapterFromEnv({
      env,
      logger: fakeLogger(),
      processName: "apps/test",
    });
    expect(result.adapterName).toBe("LocalKmsAdapter");
    expect(result.kms.constructor.name).toBe("LocalKmsAdapter");
  });

  it("test env with a valid seed → LocalKmsAdapter", async () => {
    const env: KmsAdapterEnv = { NODE_ENV: "test", PHARMAX_LOCAL_KMS_SEED: SEED };
    const result = await buildKmsAdapterFromEnv({
      env,
      logger: fakeLogger(),
      processName: "apps/test",
    });
    expect(result.adapterName).toBe("LocalKmsAdapter");
  });

  it("dev without seed AND without AWS config → throws (no silent fallback)", async () => {
    const env: KmsAdapterEnv = { NODE_ENV: "development" };
    await expect(
      buildKmsAdapterFromEnv({ env, logger: fakeLogger(), processName: "apps/web" })
    ).rejects.toThrow(/PHARMAX_LOCAL_KMS_SEED/);
  });

  it("dev with a too-short seed → throws", async () => {
    const env: KmsAdapterEnv = { NODE_ENV: "development", PHARMAX_LOCAL_KMS_SEED: "tooshort" };
    await expect(
      buildKmsAdapterFromEnv({ env, logger: fakeLogger(), processName: "apps/web" })
    ).rejects.toThrow();
  });

  it("production without complete AWS KMS env → refuses to boot", async () => {
    const env: KmsAdapterEnv = {
      NODE_ENV: "production",
      // region present but key ids missing → not allAwsPresent
      AWS_REGION: "us-east-1",
      PHARMAX_LOCAL_KMS_SEED: SEED,
    };
    await expect(
      buildKmsAdapterFromEnv({ env, logger: fakeLogger(), processName: "apps/worker" })
    ).rejects.toThrow(/Refusing to boot apps\/worker in production/);
  });

  it("error messages are attributed to the supplied processName", async () => {
    const env: KmsAdapterEnv = { NODE_ENV: "development" };
    await expect(
      buildKmsAdapterFromEnv({ env, logger: fakeLogger(), processName: "apps/custom" })
    ).rejects.toThrow(/Refusing to boot apps\/custom/);
  });
});

describe("parsePreviousDataKeyKeyIds", () => {
  it("returns [] for undefined", () => {
    expect(parsePreviousDataKeyKeyIds(undefined)).toEqual([]);
  });

  it("returns [] for an empty / whitespace string", () => {
    expect(parsePreviousDataKeyKeyIds("   ")).toEqual([]);
  });

  it("splits, trims, and drops empties", () => {
    expect(parsePreviousDataKeyKeyIds(" a , b ,, c ")).toEqual(["a", "b", "c"]);
  });

  it("handles a single entry", () => {
    expect(parsePreviousDataKeyKeyIds("arn:aws:kms:...:key/abc")).toEqual([
      "arn:aws:kms:...:key/abc",
    ]);
  });
});
