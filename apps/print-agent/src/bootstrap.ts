import { configureCommandBus } from "@pharmax/command-bus";
import { configureCrypto, LocalKmsAdapter } from "@pharmax/crypto";
import { prisma } from "@pharmax/database";
import { clock } from "@pharmax/platform-core";
import { configureRbac, PrismaPermissionLoader } from "@pharmax/rbac";

import { env } from "./env.js";
import { logger } from "./logger.js";
import { initSentry } from "./observability/sentry-init.js";

let booted = false;

export function bootstrap(): void {
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

  if (env.NODE_ENV === "production") {
    throw new Error(
      "Refusing to boot apps/print-agent in production with LocalKmsAdapter. Wire AwsKmsAdapter before promoting."
    );
  }

  configureCrypto({
    kms: new LocalKmsAdapter({ seed: env.PHARMAX_LOCAL_KMS_SEED }),
  });

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
    zplMode: env.PRINT_AGENT_ZPL_MODE,
    sentryReady,
  });
}
