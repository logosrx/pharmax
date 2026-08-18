// Sentry Edge-runtime init.
//
// Next.js middleware and Edge route handlers run on the Edge runtime
// (Vercel's V8 isolates, Cloudflare-style). The server-only Sentry
// init in `apps/web/instrumentation.ts` does NOT run there — Edge
// has its own module graph. This file is loaded by @sentry/nextjs
// when an Edge function boots.
//
// We don't currently use Edge runtime in apps/web (every route is
// pinned to `runtime: "nodejs"` because we depend on Prisma and
// node:crypto), but @sentry/nextjs expects this file to exist for a
// complete config. Keep it in sync with the server config above.

import * as Sentry from "@sentry/nextjs";

import { buildBeforeSend, scrubBreadcrumb } from "./src/observability/sentry-scrub-core.js";

const dsn = process.env["SENTRY_DSN"];

if (dsn !== undefined && dsn.length > 0 && process.env["NODE_ENV"] !== "test") {
  Sentry.init({
    dsn,
    environment: process.env["SENTRY_ENVIRONMENT"] ?? process.env["NODE_ENV"] ?? "development",
    tracesSampleRate: Number(process.env["SENTRY_TRACES_SAMPLE_RATE"] ?? 0),
    sendDefaultPii: false,

    // Same scrubber as the Node and browser runtimes. Edge is unused
    // today — every route pins `runtime: "nodejs"` for Prisma and
    // node:crypto — but "keep it in sync with the server config" is
    // the stated intent of this file, and an unscrubbed init that
    // nobody exercises is exactly the one that survives review and
    // then gets exercised.
    beforeSend: buildBeforeSend({ enabledInEnvironment: true }),
    beforeBreadcrumb: scrubBreadcrumb,
  });
}
