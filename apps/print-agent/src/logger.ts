import { logger as loggerNs } from "@pharmax/platform-core";

import { env } from "./env.js";
import { createSentryErrorReporter } from "./observability/sentry-init.js";

const basePinoLogger = loggerNs.createPinoLogger({
  service: "pharmacy-print-agent",
  level: env.LOG_LEVEL,
});

export const logger = loggerNs.withErrorReporter(basePinoLogger, createSentryErrorReporter());
