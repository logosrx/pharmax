// Server-only env loader.
//
// Schema lives here; the parse + freeze + fail-fast machinery lives in
// `@pharmax/platform-core/env`. Validation runs once on first import.
// Required values throw at boot. OPTIONAL values (Stripe) are surfaced
// as `undefined` so the webhook route can gracefully degrade — most
// local-dev clones won't have Stripe creds.
//
// NEVER expose anything here to client components or as `NEXT_PUBLIC_*`.
// If a value needs to reach the browser, add a separate `client-env.ts`
// that explicitly whitelists each key.

import "server-only";

import { env as envNs } from "@pharmax/platform-core";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DATABASE_URL: z.string().url(),
  DIRECT_URL: z.string().url().optional(),
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  EASYPOST_WEBHOOK_SECRET: z.string().min(1).optional(),

  // Master seed for the dev/test LocalKmsAdapter. See
  // apps/worker/src/env.ts for the full rationale — apps/web and
  // apps/worker MUST agree on this value or rows encrypted in one
  // process are undecryptable in the other.
  // Replace with `AWS_KMS_KEY_ARN` + an AwsKmsAdapter in prod.
  PHARMAX_LOCAL_KMS_SEED: z.string().min(32),

  // Error tracking (Sentry). Optional — when unset, Sentry is fully
  // disabled and `Logger.error` calls only hit stdout. In production
  // these MUST be set; the bootstrap layer will warn if they aren't.
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_ENVIRONMENT: z.string().min(1).optional(),
  SENTRY_RELEASE: z.string().min(1).optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),
  SENTRY_PROFILES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),
});

export const env = envNs.defineEnv(schema, {
  contextLabel: "apps/web environment",
});
export type Env = typeof env;
