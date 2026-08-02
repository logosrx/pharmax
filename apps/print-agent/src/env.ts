import { env as envNs } from "@pharmax/platform-core";
import { z } from "zod";

/**
 * Local-development fixture identity, seeded by `prisma/seed.ts`.
 *
 * These are defaults so `pnpm dev` works with no configuration. They are
 * also, for the same reason, what an unconfigured PRODUCTION task falls
 * back to — which is not a hypothetical: the prod ECS task definition
 * injected none of these, so print-agent booted looking for the `acme`
 * fixture tenant in the production database, threw
 * `PrintAgentBootstrapError` out of resolve-runtime-context, exited
 * before writing its liveness marker, and crash-looped until the ECS
 * deployment timed out (2026-08-02).
 *
 * They are named constants so the production guard below cannot drift
 * out of sync with the defaults it is guarding against.
 */
const DEV_FIXTURE_ORG_SLUG = "acme";
const DEV_FIXTURE_WORKSTATION_CODE = "WS-01";
const DEV_FIXTURE_ACTOR_EMAIL = "print-agent@acme.test";
const LOOPBACK_PRINTER_HOST = "127.0.0.1";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DATABASE_URL: z.string().url(),
  DIRECT_URL: z.string().url().optional(),

  PRINT_AGENT_ORG_SLUG: z.string().min(1).default(DEV_FIXTURE_ORG_SLUG),
  PRINT_AGENT_WORKSTATION_CODE: z.string().min(1).default(DEV_FIXTURE_WORKSTATION_CODE),
  PRINT_AGENT_ACTOR_EMAIL: z.string().email().default(DEV_FIXTURE_ACTOR_EMAIL),

  PRINT_AGENT_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2_000),
  PRINT_AGENT_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),

  /** `file` writes ZPL to disk (dev). `tcp` sends raw ZPL to a network printer. */
  PRINT_AGENT_ZPL_MODE: z.enum(["file", "tcp"]).default("file"),
  PRINT_AGENT_ZPL_FILE_PATH: z.string().min(1).default("/tmp/pharmax-vial-label.zpl"),
  PRINT_AGENT_PRINTER_HOST: z.string().min(1).default(LOOPBACK_PRINTER_HOST),
  PRINT_AGENT_PRINTER_PORT: z.coerce.number().int().positive().default(9100),
  PRINT_AGENT_PRINTER_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  /**
   * Post-send `~HS` printer status verification (tcp mode only).
   * Default on — a fault flag (paper out / paused / head up /
   * ribbon out) fails the job instead of recording a label that
   * never printed. Set false ONLY for print servers that don't
   * relay bidirectional traffic.
   */
  PRINT_AGENT_VERIFY_STATUS: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  // KMS adapter selection (mirrors apps/worker + apps/web). In
  // production the print-agent MUST run AwsKmsAdapter: AWS_REGION +
  // AWS_KMS_DATA_KEY_ID + AWS_KMS_SEARCH_KEY_ID are all required (see
  // bootstrap.ts). The local seed is dev/test only.
  AWS_REGION: z.string().min(1).optional(),
  AWS_KMS_DATA_KEY_ID: z.string().min(1).optional(),
  AWS_KMS_SEARCH_KEY_ID: z.string().min(1).optional(),
  AWS_KMS_KEY_LABEL: z.string().min(1).optional(),
  PHARMAX_LOCAL_KMS_SEED: z.string().min(32).optional(),

  // Error tracking. Optional in local dev; required in prod.
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_ENVIRONMENT: z.string().min(1).optional(),
  SENTRY_RELEASE: z.string().min(1).optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),
});

/**
 * Production boot guard, mirroring the KMS guard in bootstrap.ts.
 *
 * Every check here is a config mistake that the process would otherwise
 * discover far from its cause. The identity defaults fail late and
 * confusingly — as a `PrintAgentBootstrapError` naming a fixture tenant
 * nobody deliberately configured, several layers below the actual
 * mistake, visible only in a crash-looping task's logs. The printer
 * defaults are worse: they fail *quietly*, writing ZPL to `/tmp` or
 * dialling loopback while the pipeline records labels as printed. That
 * is a silent printer failure, which the workflow-safety rules forbid
 * outright.
 *
 * Refusing to boot converts all of it into one legible message at
 * startup. Note this makes an unconfigured print-agent fail *sooner*,
 * not more often — it cannot serve traffic in either case.
 *
 * Issues carry an explicit `path` so they land in `flatten().fieldErrors`
 * and survive `defineEnv`'s error redaction; a pathless issue would be
 * dropped into `formErrors` and reported as an empty failure. Messages
 * name the variable and the expectation, never the observed value.
 */
const schemaWithProductionGuards = schema.superRefine((value, ctx) => {
  if (value.NODE_ENV !== "production") {
    return;
  }

  const fixtures: ReadonlyArray<{
    key: "PRINT_AGENT_ORG_SLUG" | "PRINT_AGENT_WORKSTATION_CODE" | "PRINT_AGENT_ACTOR_EMAIL";
    isFixture: boolean;
    detail: string;
  }> = [
    {
      key: "PRINT_AGENT_ORG_SLUG",
      isFixture: value.PRINT_AGENT_ORG_SLUG === DEV_FIXTURE_ORG_SLUG,
      detail: "the local seed organization slug",
    },
    {
      key: "PRINT_AGENT_WORKSTATION_CODE",
      isFixture: value.PRINT_AGENT_WORKSTATION_CODE === DEV_FIXTURE_WORKSTATION_CODE,
      detail: "the local seed workstation code",
    },
    {
      key: "PRINT_AGENT_ACTOR_EMAIL",
      isFixture:
        value.PRINT_AGENT_ACTOR_EMAIL === DEV_FIXTURE_ACTOR_EMAIL ||
        value.PRINT_AGENT_ACTOR_EMAIL.endsWith(".test"),
      detail: "a reserved .test address that cannot exist in a real tenant",
    },
  ];

  for (const { key, isFixture, detail } of fixtures) {
    if (isFixture) {
      ctx.addIssue({
        code: "custom",
        path: [key],
        message:
          `Refusing to boot apps/print-agent in production: ${key} is still ${detail}. ` +
          "The agent resolves its organization, workstation, and actor from the database " +
          "at boot, so a fixture value means it searches for a tenant that does not exist " +
          "in production and crash-loops. Inject the real value through the ECS task " +
          "definition (infra/terraform/modules/ecs).",
      });
    }
  }

  if (value.PRINT_AGENT_ZPL_MODE === "file") {
    ctx.addIssue({
      code: "custom",
      path: ["PRINT_AGENT_ZPL_MODE"],
      message:
        "Refusing to boot apps/print-agent in production: PRINT_AGENT_ZPL_MODE is 'file', " +
        "which writes label ZPL to disk instead of sending it to a printer. Every job would " +
        "be recorded as printed while no label was produced — a silent printer failure. " +
        "Set PRINT_AGENT_ZPL_MODE=tcp and point PRINT_AGENT_PRINTER_HOST at the Zebra device.",
    });
  }

  if (
    value.PRINT_AGENT_ZPL_MODE === "tcp" &&
    value.PRINT_AGENT_PRINTER_HOST === LOOPBACK_PRINTER_HOST
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["PRINT_AGENT_PRINTER_HOST"],
      message:
        "Refusing to boot apps/print-agent in production: PRINT_AGENT_PRINTER_HOST is still " +
        "loopback, so no printer is reachable. Set it to the Zebra device's address and " +
        "confirm the agent runs somewhere with a network path to it.",
    });
  }
});

export const env = envNs.defineEnv(schemaWithProductionGuards, {
  contextLabel: "apps/print-agent environment",
});
export type Env = typeof env;

/** Exported for tests; production code should import `env`. */
export const __envSchemaForTests = schemaWithProductionGuards;
