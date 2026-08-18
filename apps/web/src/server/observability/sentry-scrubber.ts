// PHI-safe Sentry beforeSend / beforeBreadcrumb scrubber — server entry.
//
// The implementation moved to `src/observability/sentry-scrub-core.ts`
// so the browser and Edge SDKs can share it. Nothing in the scrubbing
// logic was ever server-specific: it is a static allowlist plus a set
// of regexes, with no tenancy, request, or Node dependency. Only the
// `server-only` guard is server-specific, and it stays here so the
// server import path keeps its build-time protection while the shared
// core stays importable from a browser bundle.
//
// This file preserves the previous public surface exactly —
// `buildBeforeSend`, `scrubBreadcrumb`, `__testing` — so every existing
// importer (sentry-init, ops-scope, logger, dispatch-from-route,
// app/error.tsx) is unaffected.
//
// Tests: `sentry-scrubber.test.ts` covers the server surface;
// `sentry-scrub-core.test.ts` covers the PHI pattern redaction that
// all three runtimes share.

import "server-only";

export {
  buildBeforeSend,
  scrubBreadcrumb,
  redactPhiPatterns,
  __testing,
} from "../../observability/sentry-scrub-core.js";
