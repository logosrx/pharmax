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
      <body className="min-h-screen bg-neutral-950 text-neutral-100">
        <main className="mx-auto max-w-2xl space-y-4 px-6 py-10">
          <h1 className="text-2xl font-semibold">Something went wrong</h1>
          <p className="text-sm text-neutral-400">
            A fatal error occurred and the application could not recover. The incident has been
            captured for our on-call team.
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
      </body>
    </html>
  );
}
