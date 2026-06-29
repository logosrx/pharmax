// buildKmsAdapterFromEnv — the SINGLE source of truth for choosing
// and constructing the process KMS adapter from environment.
//
// Why this lives in @pharmax/composition:
//
//   apps/web and apps/worker each had a near-identical copy of this
//   decision tree (`buildKmsAdapter` / `buildWorkerKmsAdapter`) plus
//   a verbatim `parsePreviousDataKeyKeyIds` helper. That duplication
//   is the most safety-critical kind in the codebase: the two
//   processes MUST derive the SAME data-key identity, or rows
//   wrapped by one are undecryptable by the other. Two copies that
//   "must stay byte-identical" is a latent PHI-availability incident
//   waiting for a one-sided edit. Promoting the decision tree to the
//   composition layer makes "which KMS adapter, built how" a single
//   reviewable function both entry points call.
//
// The decision tree (unchanged from the two former copies):
//
//   NODE_ENV=production
//     ALL of AWS_REGION / AWS_KMS_DATA_KEY_ID / AWS_KMS_SEARCH_KEY_ID
//       required. Missing any → throw (refuse to boot).
//     All present → new AwsKmsAdapter(...) + validate().
//
//   NODE_ENV=development | test
//     AWS_KMS_DATA_KEY_ID set (+ region + search key) → AwsKmsAdapter
//       (engineer is explicitly testing against AWS), with a warning.
//     Otherwise → LocalKmsAdapter against PHARMAX_LOCAL_KMS_SEED
//       (>=32 chars; throw if absent/short).
//
// PHI invariant: this file never reads PHI. The KMS seed is a secret
// but not PHI; it is never logged (only its presence/length matters,
// and that is asserted by the caller's env schema + here).

import {
  AwsKmsAdapter,
  createAwsKmsClient,
  LocalKmsAdapter,
  type KmsAdapter,
} from "@pharmax/crypto";
import type { logger as loggerTypes } from "@pharmax/platform-core";

/**
 * The slice of env this builder reads. Both apps/web/env.ts and
 * apps/worker/env.ts structurally satisfy this — only these keys are
 * read; the caller's schema validates everything else. Optional keys
 * tolerate both "absent" and "present but undefined" so a zod-parsed
 * env (`string | undefined`) and a hand-built test env both fit.
 */
export interface KmsAdapterEnv {
  readonly NODE_ENV: "development" | "test" | "production";
  readonly AWS_REGION?: string | undefined;
  readonly AWS_KMS_DATA_KEY_ID?: string | undefined;
  readonly AWS_KMS_SEARCH_KEY_ID?: string | undefined;
  readonly AWS_KMS_KEY_LABEL?: string | undefined;
  readonly AWS_KMS_PREVIOUS_DATA_KEY_IDS?: string | undefined;
  readonly PHARMAX_LOCAL_KMS_SEED?: string | undefined;
}

export interface BuildKmsAdapterInput {
  readonly env: KmsAdapterEnv;
  /** Only info/warn are used; structural so any logger fits. */
  readonly logger: Pick<loggerTypes.Logger, "info" | "warn">;
  /**
   * Process identity for boot logs + error messages, e.g.
   * "apps/web" or "apps/worker". Keeps the one error/log surface
   * attributable to the entry point that booted.
   */
  readonly processName: string;
}

export interface BuiltKmsAdapter {
  readonly kms: KmsAdapter;
  readonly adapterName: "AwsKmsAdapter" | "LocalKmsAdapter";
}

export async function buildKmsAdapterFromEnv(
  input: BuildKmsAdapterInput
): Promise<BuiltKmsAdapter> {
  const { env, logger, processName } = input;

  const region = env.AWS_REGION;
  const dataKeyId = env.AWS_KMS_DATA_KEY_ID;
  const searchKeyId = env.AWS_KMS_SEARCH_KEY_ID;
  const label = env.AWS_KMS_KEY_LABEL ?? "app-phi";
  const previousDataKeyKeyIds = parsePreviousDataKeyKeyIds(env.AWS_KMS_PREVIOUS_DATA_KEY_IDS);

  const allAwsPresent =
    typeof region === "string" &&
    region.length > 0 &&
    typeof dataKeyId === "string" &&
    dataKeyId.length > 0 &&
    typeof searchKeyId === "string" &&
    searchKeyId.length > 0;

  if (env.NODE_ENV === "production") {
    if (!allAwsPresent) {
      throw new Error(
        `Refusing to boot ${processName} in production: AWS_REGION, AWS_KMS_DATA_KEY_ID, and AWS_KMS_SEARCH_KEY_ID must all be set. ` +
          "Provision the KMS keys via infra/terraform/modules/kms and inject the ARNs through Secrets Manager."
      );
    }
    const kms = new AwsKmsAdapter({
      client: createAwsKmsClient({ region }),
      dataKeyKeyId: dataKeyId,
      searchKeyKeyId: searchKeyId,
      keyIdLabel: label,
      ...(previousDataKeyKeyIds.length > 0 ? { previousDataKeyKeyIds } : {}),
    });
    // Round-trip the IAM contract once at boot. If the task role is
    // missing kms:DescribeKey we want to know now, not at the first
    // PHI write.
    await kms.validate();
    if (previousDataKeyKeyIds.length > 0) {
      logger.info("kms.previous_data_keys_configured", {
        processName,
        currentDataKeyId: dataKeyId,
        previousDataKeyCount: previousDataKeyKeyIds.length,
      });
    }
    return { kms, adapterName: "AwsKmsAdapter" };
  }

  // dev / test
  if (allAwsPresent) {
    const kms = new AwsKmsAdapter({
      client: createAwsKmsClient({ region }),
      dataKeyKeyId: dataKeyId,
      searchKeyKeyId: searchKeyId,
      keyIdLabel: label,
      ...(previousDataKeyKeyIds.length > 0 ? { previousDataKeyKeyIds } : {}),
    });
    await kms.validate();
    logger.warn("kms.aws_adapter_in_non_production", {
      processName,
      reason: "AWS_KMS_* env present in non-prod environment",
    });
    return { kms, adapterName: "AwsKmsAdapter" };
  }

  const seed = env.PHARMAX_LOCAL_KMS_SEED;
  if (typeof seed !== "string" || seed.length < 32) {
    throw new Error(
      `Refusing to boot ${processName}: neither AWS KMS config nor PHARMAX_LOCAL_KMS_SEED is present. ` +
        "Set PHARMAX_LOCAL_KMS_SEED (>=32 chars) for local dev, or wire AWS_KMS_DATA_KEY_ID / AWS_KMS_SEARCH_KEY_ID."
    );
  }
  return {
    kms: new LocalKmsAdapter({ seed }),
    adapterName: "LocalKmsAdapter",
  };
}

/**
 * Parse the `AWS_KMS_PREVIOUS_DATA_KEY_IDS` env var into a clean
 * string array. Comma-separated by convention (matches how operators
 * paste ARN lists from Terraform output), whitespace tolerated.
 *
 * Returns an empty array for the steady-state case (env unset or
 * empty after trimming). Per-entry validation (non-empty, no
 * duplicates) is deferred to `new AwsKmsAdapter(...)` so the same
 * rule applies to direct programmatic callers and operators alike.
 *
 * Exported so both entry points AND the unit test share one parser —
 * this was previously copy-pasted verbatim into both apps.
 */
export function parsePreviousDataKeyKeyIds(raw: string | undefined): ReadonlyArray<string> {
  if (typeof raw !== "string") return [];
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  return trimmed
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
