// Next.js segment error boundary.
//
// Catches RUNTIME errors thrown during render of any page under
// `app/` (server component render error, unhandled rejection from
// a server action, etc.) and renders this UI instead of the 500
// page.
//
// Per Next.js convention, this file MUST be a client component
// (`"use client"`). Sentry's React error boundary in
// `@sentry/nextjs` automatically captures `Error` objects passed
// to error.tsx props — we ALSO call `Sentry.captureException`
// directly so the event carries the operator's correlationId
// (from `error.digest`, which Next.js stamps on every thrown
// error in server contexts) as a tag.
//
// PHI invariant: the rendered message + digest are non-PHI by
// design. Server-thrown error messages may contain identifiers
// but our PharmaxError factory deliberately keeps messages
// operator-facing + PHI-free; the `sentry-scrubber.beforeSend`
// allowlist is the second line of defense.

"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

interface ErrorBoundaryProps {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}

export default function SegmentError({ error, reset }: ErrorBoundaryProps) {
  useEffect(() => {
    Sentry.captureException(error, {
      tags: {
        boundary: "app-segment",
        ...(error.digest !== undefined ? { digest: error.digest } : {}),
      },
    });
  }, [error]);

  return (
    <main className="mx-auto max-w-2xl space-y-4 px-6 py-10">
      <h1 className="text-2xl font-semibold text-neutral-50">Something went wrong</h1>
      <p className="text-sm text-neutral-400">
        An unexpected error occurred while rendering this page. The incident has been captured for
        our on-call team.
      </p>
      {error.digest !== undefined ? (
        <p className="text-xs text-neutral-500">
          Reference id: <code className="font-mono text-neutral-300">{error.digest}</code>
        </p>
      ) : null}
      <button
        type="button"
        onClick={() => reset()}
        className="rounded-md border border-blue-700 bg-blue-900 px-3 py-1.5 text-sm text-blue-100 hover:bg-blue-800"
      >
        Try again
      </button>
    </main>
  );
}
