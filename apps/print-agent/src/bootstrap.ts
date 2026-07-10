import { configureCommandBus } from "@pharmax/command-bus";
import {
  AwsKmsAdapter,
  configureCrypto,
  createAwsKmsClient,
  type KmsAdapter,
  LocalKmsAdapter,
} from "@pharmax/crypto";
import { prisma } from "@pharmax/database";
import { clock } from "@pharmax/platform-core";
import { configureRbac, PrismaPermissionLoader } from "@pharmax/rbac";

import { env } from "./env.js";
import { logger } from "./logger.js";
import { initSentry } from "./observability/sentry-init.js";

let booted = false;

export async function bootstrap(): Promise<void> {
  if (booted) return;
  booted = true;

  // Sentry FIRST so its uncaughtException / unhandledRejection
  // handlers can catch failures from the remaining init steps.
  const sentryReady = initSentry({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV,
    ...(env.SENTRY_RELEASE !== undefined ? { release: env.SENTRY_RELEASE } : {}),
    tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
    serverName: "pharmacy-print-agent",
  });
  if (env.NODE_ENV === "production" && !sentryReady) {
    logger.warn("print-agent.booted_without_sentry", {
      reason: "SENTRY_DSN not configured",
    });
  }

  const { kms, adapterName } = await buildKmsAdapter();
  configureCrypto({ kms });

  configureRbac({
    loader: new PrismaPermissionLoader(prisma),
  });

  configureCommandBus({
    prisma,
    clock: clock.systemClock,
    logger: logger.child({ component: "command-bus" }),
  });

  logger.info("print-agent.bootstrap.complete", {
    nodeEnv: env.NODE_ENV,
    cryptoAdapter: adapterName,
    zplMode: env.PRINT_AGENT_ZPL_MODE,
    sentryReady,
  });
}

/**
 * Choose + construct the process KMS adapter from env.
 *
 * This mirrors `@pharmax/composition`'s `buildKmsAdapterFromEnv` (the
 * single source of truth used by apps/web + apps/worker). We inline
 * the same decision here rather than depend on @pharmax/composition so
 * the tsx-run print-agent keeps a minimal dependency surface. The
 * construction parameters MUST stay identical to that helper —
 * `dataKeyKeyId`, `searchKeyKeyId`, and `keyIdLabel` ("app-phi") — so a
 * PHI row wrapped by web/worker stays decryptable here and vice-versa.
 *
 * Production requires the full AwsKmsAdapter config; dev/test falls
 * back to LocalKmsAdapter against PHARMAX_LOCAL_KMS_SEED.
 */
async function buildKmsAdapter(): Promise<{
  readonly kms: KmsAdapter;
  readonly adapterName: "AwsKmsAdapter" | "LocalKmsAdapter";
}> {
  const region = env.AWS_REGION;
  const dataKeyId = env.AWS_KMS_DATA_KEY_ID;
  const searchKeyId = env.AWS_KMS_SEARCH_KEY_ID;
  const label = env.AWS_KMS_KEY_LABEL ?? "app-phi";

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
        "Refusing to boot apps/print-agent in production: AWS_REGION, AWS_KMS_DATA_KEY_ID, and " +
          "AWS_KMS_SEARCH_KEY_ID must all be set. Provision the KMS keys via infra/terraform/modules/kms " +
          "and inject them through the ECS task definition."
      );
    }
    const kms = new AwsKmsAdapter({
      client: createAwsKmsClient({ region }),
      dataKeyKeyId: dataKeyId,
      searchKeyKeyId: searchKeyId,
      keyIdLabel: label,
    });
    // Round-trip the IAM contract once at boot so a missing
    // kms:DescribeKey surfaces here, not at the first PHI decrypt.
    await kms.validate();
    return { kms, adapterName: "AwsKmsAdapter" };
  }

  // dev / test — explicit AWS config wins if fully present, else local seed.
  if (allAwsPresent) {
    const kms = new AwsKmsAdapter({
      client: createAwsKmsClient({ region }),
      dataKeyKeyId: dataKeyId,
      searchKeyKeyId: searchKeyId,
      keyIdLabel: label,
    });
    await kms.validate();
    return { kms, adapterName: "AwsKmsAdapter" };
  }

  const seed = env.PHARMAX_LOCAL_KMS_SEED;
  if (typeof seed !== "string" || seed.length < 32) {
    throw new Error(
      "Refusing to boot apps/print-agent: neither AWS KMS config nor PHARMAX_LOCAL_KMS_SEED is present. " +
        "Set PHARMAX_LOCAL_KMS_SEED (>=32 chars) for local dev, or wire AWS_KMS_DATA_KEY_ID / AWS_KMS_SEARCH_KEY_ID."
    );
  }
  return { kms: new LocalKmsAdapter({ seed }), adapterName: "LocalKmsAdapter" };
}
