// /ops segment error boundary.
//
// Catches runtime render errors from any operator-console page and
// renders the canonical ErrorState INSIDE the ops shell (the layout
// survives an error boundary, so the sidebar and top bar stay up and
// the operator is never dumped to a bare 500). The root app/error.tsx
// still backstops failures outside /ops.
//
// Per Next.js convention this file must be a client component.
// Sentry capture mirrors app/error.tsx: the digest Next stamps on
// server-thrown errors is both tagged for on-call and shown to the
// operator as the quotable error code.
//
// PHI invariant: only the digest is rendered — never error.message,
// which for unexpected errors carries no PHI guarantee.

"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

import { Button } from "../../src/components/ui/button.js";
import { ErrorState } from "../../src/components/ui/empty-state.js";

interface OpsErrorBoundaryProps {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}

export default function OpsSegmentError({ error, reset }: OpsErrorBoundaryProps) {
  useEffect(() => {
    Sentry.captureException(error, {
      tags: {
        boundary: "ops-segment",
        ...(error.digest !== undefined ? { digest: error.digest } : {}),
      },
    });
  }, [error]);

  return (
    <ErrorState
      title="This page failed to load"
      description="Something went wrong while rendering this view. The incident has been captured for our on-call team — retry, or quote the error code to support if it keeps failing."
      {...(error.digest !== undefined ? { detail: error.digest } : {})}
      action={
        <Button variant="secondary" size="sm" icon="history" onClick={() => reset()}>
          Try again
        </Button>
      }
    />
  );
}
