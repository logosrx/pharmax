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

  // Number of trusted reverse proxies that sit in front of this tier and
  // APPEND to `X-Forwarded-For`. This is the ONLY input that makes a
  // per-IP rate-limit key trustworthy: `resolveClientIp` (see
  // server/http/client-ip.ts) takes the Nth-from-the-right XFF entry,
  // where N is this count, because each trusted proxy appends the address
  // it received the connection from and a spoofed client-supplied entry
  // can only ever sit further LEFT than the outermost trusted hop.
  //
  // The value is DEPLOYMENT-SPECIFIC, which is why it is configuration and
  // not a constant:
  //   - prod us-east-1 : CloudFront -> ALB -> app   => 2
  //   - ALB-only tiers (staging / dev / secondary)  => 1
  //   - local / direct connection (no proxy)        => 0
  //
  // Default 0 is fail-CLOSED for security: when unset we trust no header,
  // so `resolveClientIp` returns undefined and every caller collapses into
  // one shared limiter bucket (stricter, never looser). A misconfigured
  // deployment therefore over-limits rather than handing attackers a fresh
  // bucket per spoofed header — but production MUST set the real hop count
  // (wired in infra/terraform per environment) so legitimate per-IP
  // isolation is preserved.
  TRUSTED_PROXY_HOP_COUNT: z.coerce.number().int().min(0).max(8).default(0),
  DATABASE_URL: z.string().url(),
  DIRECT_URL: z.string().url().optional(),
  // Optional read-replica connection for heavy report scans. When
  // set, `@pharmax/database` routes report READS here (report_run
  // writes + audit stay on the primary). Unset → reports read the
  // primary. Consumed by reporting-client.ts via process.env;
  // declared here for validation + documentation.
  REPORTING_DATABASE_URL: z.string().url().optional(),
  // ElastiCache Redis connection string (rediss://:<auth_token>@<primary>:6379),
  // injected by ECS from Secrets Manager. When set, the web tier backs
  // @pharmax/cache with a shared RedisCache (cross-request identity /
  // permission reuse); when unset, the cache degrades to a NoopCache and
  // every read falls through to Postgres. Optional so dev/test clones boot
  // without Redis. Provisioned by infra/terraform/modules/elasticache.
  REDIS_URL: z.string().url().optional(),
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  EASYPOST_WEBHOOK_SECRET: z.string().min(1).optional(),
  // FedEx Advanced Integrated Visibility webhook security token (set
  // on the webhook project in the FedEx Developer Portal). When
  // unset the `/api/webhooks/fedex` route returns 503.
  FEDEX_WEBHOOK_SECRET: z.string().min(1).optional(),
  // Resend delivery webhook signing secret (Svix-signed, `whsec_`
  // prefix). When unset the `/api/webhooks/resend` route returns
  // 503 (dev clones without Resend). Production MUST set it so
  // delivered/bounced/complained events advance the
  // notification_delivery projection.
  RESEND_WEBHOOK_SECRET: z.string().min(1).optional(),

  // (Clerk identity env vars removed — authentication is in-house per
  // ADR-0030. Password pepper is AUTH_PASSWORD_PEPPER above; sessions
  // are server-side. No external identity provider is configured.)

  // Sign-up surface flag.
  //
  // Defaults to `false` — sign-up is closed unless an environment
  // explicitly opts in. The `/sign-up` route layers three rules:
  //
  //   1. Always-open in `development` / `test` so contributors can
  //      spin tenants up end-to-end.
  //   2. Otherwise (production): sign-up is invitation-only; the
  //      middleware returns 404 on direct hits to `/sign-up` unless
  //      this flag is `true`. Operators enroll via the invitation
  //      link (`/accept-invite?token=...`), not this surface.
  //
  // We accept the canonical truthy strings (`"true"` / `"1"`) and
  // reject everything else — `z.coerce.boolean()` would treat any
  // non-empty string (including `"false"`) as `true`, which is a
  // classic boot-time footgun. The preprocess below normalizes
  // case + whitespace so `TRUE`, `True`, `" true "` all resolve
  // consistently.
  SIGNUPS_ENABLED: z
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

  // Password pepper for the in-house identity engine (ADR-0030),
  // base64-encoded, mixed into Argon2id as the `secret` input. Unlike
  // the per-hash salt, it is NOT stored with the hash — a database-only
  // breach cannot verify passwords without it. Server-only secret,
  // sourced from Secrets Manager in production. Optional in dev/test
  // (the hasher runs without a pepper); bootstrap warns in production
  // when unset.
  AUTH_PASSWORD_PEPPER: z.string().min(32).optional(),

  // Canonical base URL for credential-setup links (invite / password
  // reset). e.g. "https://app.pharmax.example". Optional; dev defaults
  // to http://localhost:3000. The accept-invite / reset routes resolve
  // the user from the token (not the host), so a single canonical host
  // is fine.
  APP_BASE_URL: z.string().url().optional(),

  // Transactional email transport for auth credential-setup messages
  // (invite / password reset). Matches the worker's var names so a
  // single deployment shares one Resend key + from-address. Optional:
  // dev logs the link instead of sending; production warns if unset.
  RESEND_API_KEY: z.string().min(1).optional(),
  NOTIFICATION_FROM_EMAIL: z.string().email().optional(),

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
  //   - AWS_KMS_PREVIOUS_DATA_KEY_IDS — optional. Comma-separated
  //                                   list of historical CMK
  //                                   ARNs/aliases used during a
  //                                   manual CMK identity rotation
  //                                   bake-in window. See
  //                                   `AwsKmsAdapterOptions.previousDataKeyKeyIds`
  //                                   and the RUNBOOK § "Rotating a
  //                                   KMS data key — Manual CMK
  //                                   rotation".
  //
  // All five are OPTIONAL at the schema level so dev clones boot
  // without AWS creds. `bootstrap.ts` enforces presence under
  // NODE_ENV=production with a clear hard-fail message.
  AWS_REGION: z.string().min(1).optional(),
  AWS_KMS_DATA_KEY_ID: z.string().min(1).optional(),
  AWS_KMS_SEARCH_KEY_ID: z.string().min(1).optional(),
  AWS_KMS_KEY_LABEL: z.string().min(1).optional(),
  // Pre-split string of historical CMK ids. `bootstrap.ts` splits on
  // commas, trims whitespace, and drops empty entries before passing
  // to `AwsKmsAdapter`. Examples:
  //   AWS_KMS_PREVIOUS_DATA_KEY_IDS=alias/pharmax/app-phi-key-v1
  //   AWS_KMS_PREVIOUS_DATA_KEY_IDS=alias/pharmax/app-phi-key-v1,arn:aws:kms:us-east-1:111111111111:key/abcd-1234
  //
  // Empty / unset is the steady-state value (no rotation in flight)
  // and produces zero behavioral change.
  AWS_KMS_PREVIOUS_DATA_KEY_IDS: z.string().min(1).optional(),

  // Report CSV archive — the web tier READS from the same bucket
  // the worker writes to (download route streams CSVs back to the
  // operator). Optional in dev (in-memory fallback); MUST match
  // the worker's bucket + KMS key in production. See
  // apps/worker/src/env.ts for the producer-side notes.
  REPORT_ARCHIVE_S3_BUCKET: z.string().min(1).optional(),
  REPORT_ARCHIVE_S3_KMS_KEY_ID: z.string().min(1).optional(),

  // Package-photo storage — the dock-capture flow writes sealed-
  // package photos to this bucket under SSE-KMS (the bytes are not
  // PHI in our threat model, but are encrypted at rest regardless).
  // Optional in dev (in-memory fallback drops captures on redeploy);
  // in production, bootstrap.ts warns when unset and wires
  // S3PackagePhotoStorage when both are present (AWS_REGION required
  // alongside). The KMS key may be the same customer-managed key as
  // AWS_KMS_DATA_KEY_ID or a dedicated photos key.
  S3_PACKAGE_PHOTOS_BUCKET: z.string().min(1).optional(),
  S3_PACKAGE_PHOTOS_KMS_KEY_ID: z.string().min(1).optional(),

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
