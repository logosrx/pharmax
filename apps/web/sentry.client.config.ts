// Sentry browser-side init.
//
// Loaded automatically by @sentry/nextjs on the client. Keep this
// minimal: the web tier is back-office today, no public surface, and
// we keep client error budgets tight to avoid leaking PHI accidents
// through the browser SDK's auto-captured breadcrumbs.
//
// SECURITY: `NEXT_PUBLIC_*` env vars are visible to the browser.
// Sentry DSNs are designed to be public (rate-limited at Sentry's
// edge), but we still gate by `NEXT_PUBLIC_SENTRY_DSN` rather than
// hard-coding so prod / staging / dev each have isolated projects.

import * as Sentry from "@sentry/nextjs";

const dsn = process.env["NEXT_PUBLIC_SENTRY_DSN"];

if (dsn !== undefined && dsn.length > 0) {
  Sentry.init({
    dsn,
    environment: process.env["NEXT_PUBLIC_SENTRY_ENVIRONMENT"] ?? "development",

    // Performance sampling — keep at 0 by default; ramp via env.
    tracesSampleRate: Number(process.env["NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE"] ?? 0),

    // Session replay and other browser-side data sources are
    // intentionally disabled. They are PHI risks in a pharmacy app
    // (a replay frame could capture patient names on screen) and
    // require an explicit security review before enabling.
    replaysOnErrorSampleRate: 0,
    replaysSessionSampleRate: 0,

    // Server-side scrubbing handles the bulk of PHI defense; client
    // events go through Sentry's default scrubbing only. Custom
    // scrubbing for the browser SDK would need a separate
    // `beforeSend` that knows nothing about server tenancy context.
    sendDefaultPii: false,
  });
}
