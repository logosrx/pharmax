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
  // Resend delivery webhook signing secret (Svix-signed, `whsec_`
  // prefix). When unset the `/api/webhooks/resend` route returns
  // 503 (dev clones without Resend). Production MUST set it so
  // delivered/bounced/complained events advance the
  // notification_delivery projection.
  RESEND_WEBHOOK_SECRET: z.string().min(1).optional(),

  // Clerk authentication (identity layer). OPTIONAL at the schema
  // level so dev clones boot without a Clerk account (the operator
  // console pages render an "auth not configured" message in that
  // case; webhook routes still work without auth). REQUIRED in
  // production — `bootstrap.ts` enforces presence with a hard-fail
  // boot message so a missed env var cannot silently downgrade
  // identity to a no-op.
  // - Publishable key: client-safe (NEXT_PUBLIC_*); embedded in
  //   browser bundles for the <ClerkProvider> initialization.
  // - Secret key: server-only; never expose to client.
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1).optional(),
  CLERK_SECRET_KEY: z.string().min(1).optional(),
  // Clerk webhook secret (Svix-signed). Consumed by
  // `app/api/webhooks/clerk/route.ts` to verify `user.created` /
  // `user.updated` / `user.deleted` / `session.created` events.
  // OPTIONAL in dev (the route returns 503 if unset); REQUIRED in
  // production — `bootstrap.ts` hard-fails boot when missing so
  // the auto-link / sync / off-boarding pipeline activates.
  CLERK_WEBHOOK_SECRET: z.string().min(1).optional(),

  // Sign-up surface flag.
  //
  // Defaults to `false` — sign-up is closed unless an environment
  // explicitly opts in. The `/sign-up` route layers three rules:
  //
  //   1. Always-open in `development` / `test` so contributors can
  //      spin tenants up end-to-end without provisioning invitations.
  //   2. Always-open when the inbound URL carries a Clerk invitation
  //      ticket (`?__clerk_ticket=...`) regardless of the flag —
  //      pre-staged operators MUST be able to complete enrollment.
  //   3. Otherwise (production with no ticket): open ONLY if this
  //      flag is `true`. The middleware also returns 404 on direct
  //      hits to `/sign-up` when the flag is false and no ticket is
  //      present (defence-in-depth — the page handler is the
  //      primary gate, the middleware is the second line).
  //
  // We accept the canonical truthy strings (`"true"` / `"1"`) and
  // reject everything else — `z.coerce.boolean()` would treat any
  // non-empty string (including `"false"`) as `true`, which is a
  // classic boot-time footgun. The preprocess below normalizes
  // case + whitespace so `TRUE`, `True`, `" true "` all resolve
  // consistently.
  CLERK_SIGNUPS_ENABLED: z
    .preprocess((value) => {
      if (typeof value !== "string") return value;
      const normalized = value.trim().toLowerCase();
      if (normalized === "true" || normalized === "1") return true;
      if (normalized === "false" || normalized === "0" || normalized === "") return false;
      return value;
    }, z.boolean())
    .default(false),

  // Operator-facing support contact. Rendered on the production
  // sign-up "closed" page (mailto link) and any other "contact
  // your administrator" surface. Validated as an email so a typo
  // (e.g. "support" missing the @) hard-fails boot. REQUIRED in
  // production via the same hard-fail check as the Clerk vars.
  SUPPORT_EMAIL: z.string().email().optional(),

  // Master seed for the dev/test LocalKmsAdapter. apps/web and
  // apps/worker MUST agree on this value or rows encrypted in one
  // process are undecryptable in the other. Required in development +
  // test; in production we use AwsKmsAdapter instead and the seed
  // can be omitted (bootstrap.ts ignores it under NODE_ENV=production).
  PHARMAX_LOCAL_KMS_SEED: z.string().min(32).optional(),

  // ---- AWS KMS (production envelope encryption) -------------------
  //
  // In NODE_ENV=production, bootstrap.ts wires an AwsKmsAdapter. The
  // adapter needs:
  //   - AWS_REGION                  — which regional KMS endpoint to use.
  //   - AWS_KMS_DATA_KEY_ID         — the ENCRYPT_DECRYPT key for DEK wrap.
  //                                   Accepts ARN, key id, or alias.
  //   - AWS_KMS_SEARCH_KEY_ID       — the GENERATE_VERIFY_MAC / HMAC_256
  //                                   key for blind-index search keys.
  //   - AWS_KMS_KEY_LABEL           — optional. Short stable label
  //                                   embedded in the kid we persist.
  //                                   Defaults to "app-phi".
  //
  // All four are OPTIONAL at the schema level so dev clones boot
  // without AWS creds. `bootstrap.ts` enforces presence under
  // NODE_ENV=production with a clear hard-fail message.
  AWS_REGION: z.string().min(1).optional(),
  AWS_KMS_DATA_KEY_ID: z.string().min(1).optional(),
  AWS_KMS_SEARCH_KEY_ID: z.string().min(1).optional(),
  AWS_KMS_KEY_LABEL: z.string().min(1).optional(),

  // Report CSV archive — the web tier READS from the same bucket
  // the worker writes to (download route streams CSVs back to the
  // operator). Optional in dev (in-memory fallback); MUST match
  // the worker's bucket + KMS key in production. See
  // apps/worker/src/env.ts for the producer-side notes.
  REPORT_ARCHIVE_S3_BUCKET: z.string().min(1).optional(),
  REPORT_ARCHIVE_S3_KMS_KEY_ID: z.string().min(1).optional(),

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
