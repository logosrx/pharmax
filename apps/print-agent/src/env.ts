import { env as envNs } from "@pharmax/platform-core";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DATABASE_URL: z.string().url(),
  DIRECT_URL: z.string().url().optional(),

  PRINT_AGENT_ORG_SLUG: z.string().min(1).default("acme"),
  PRINT_AGENT_WORKSTATION_CODE: z.string().min(1).default("WS-01"),
  PRINT_AGENT_ACTOR_EMAIL: z.string().email().default("print-agent@acme.test"),

  PRINT_AGENT_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2_000),
  PRINT_AGENT_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),

  /** `file` writes ZPL to disk (dev). `tcp` sends raw ZPL to a network printer. */
  PRINT_AGENT_ZPL_MODE: z.enum(["file", "tcp"]).default("file"),
  PRINT_AGENT_ZPL_FILE_PATH: z.string().min(1).default("/tmp/pharmax-vial-label.zpl"),
  PRINT_AGENT_PRINTER_HOST: z.string().min(1).default("127.0.0.1"),
  PRINT_AGENT_PRINTER_PORT: z.coerce.number().int().positive().default(9100),
  PRINT_AGENT_PRINTER_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  PHARMAX_LOCAL_KMS_SEED: z.string().min(32),

  // Error tracking. Optional in local dev; required in prod.
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_ENVIRONMENT: z.string().min(1).optional(),
  SENTRY_RELEASE: z.string().min(1).optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),
});

export const env = envNs.defineEnv(schema, {
  contextLabel: "apps/print-agent environment",
});
export type Env = typeof env;
