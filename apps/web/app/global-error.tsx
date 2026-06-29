// Next.js root error boundary.
//
// Catches errors that escape the layout itself (e.g. a throw in
// `RootLayout` or its dependencies). Renders its own `<html>` +
// `<body>` because the regular root layout has already crashed
// at this point — there's no parent to render into.
//
// As with `app/error.tsx`, the file MUST be a client component.
// Sentry capture is critical here because errors at this level
// are usually framework misconfig / build issues that operators
// can't recover from; on-call needs the stack.

"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

interface GlobalErrorProps {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  useEffect(() => {
    Sentry.captureException(error, {
      tags: {
        boundary: "app-root",
        ...(error.digest !== undefined ? { digest: error.digest } : {}),
      },
    });
  }, [error]);

  return (
    <html lang="en">
      <body className="min-h-screen bg-canvas text-fg antialiased">
        <main className="mx-auto flex max-w-lg flex-col items-center gap-4 px-6 py-20 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full border border-red-500/30 bg-red-500/10 text-red-400">
            <svg
              viewBox="0 0 24 24"
              width={22}
              height={22}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.6}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="8.5" />
              <path d="M12 8v4.5M12 15.5h.01" />
            </svg>
          </span>
          <div className="space-y-1.5">
            <h1 className="text-xl font-semibold">Something went wrong</h1>
            <p className="text-sm text-muted">
              A fatal error occurred and the application could not recover. The incident has been
              captured for our on-call team.
            </p>
          </div>
          {error.digest !== undefined ? (
            <p className="text-xs text-subtle">
              Reference id: <code className="font-mono text-muted">{error.digest}</code>
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => reset()}
            className="inline-flex h-9 items-center justify-center rounded-md bg-brand px-4 text-sm font-medium text-brand-fg shadow-sm transition-colors hover:bg-brand-hover"
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
