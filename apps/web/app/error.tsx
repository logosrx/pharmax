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

import { Button } from "../src/components/ui/button.js";
import { Icon } from "../src/components/ui/icon.js";

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
    <main className="mx-auto flex max-w-lg flex-col items-center gap-4 px-6 py-20 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full border border-red-500/30 bg-red-500/10 text-red-400">
        <Icon name="alert" size={22} />
      </span>
      <div className="space-y-1.5">
        <h1 className="text-xl font-semibold text-fg">Something went wrong</h1>
        <p className="text-sm text-muted">
          An unexpected error occurred while rendering this page. The incident has been captured for
          our on-call team.
        </p>
      </div>
      {error.digest !== undefined ? (
        <p className="text-xs text-subtle">
          Reference id: <code className="font-mono text-muted">{error.digest}</code>
        </p>
      ) : null}
      <Button onClick={() => reset()} icon="history">
        Try again
      </Button>
    </main>
  );
}
