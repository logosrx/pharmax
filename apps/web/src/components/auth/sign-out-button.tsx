// Sign-out control (ADR-0030). Posts to `/api/auth/sign-out` (which
// revokes the session server-side + clears the cookie), then navigates
// to /sign-in with a full load so the cleared cookie takes effect.

"use client";

import { useState } from "react";

export function SignOutButton() {
  const [busy, setBusy] = useState(false);
  async function onClick(): Promise<void> {
    setBusy(true);
    try {
      await fetch("/api/auth/sign-out", { method: "POST" });
    } catch {
      // Best-effort; navigate regardless so the local cookie is dropped.
    }
    window.location.assign("/sign-in");
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="rounded-md border border-line-strong bg-surface-2 px-3 py-1.5 text-sm text-fg hover:bg-surface disabled:opacity-60"
    >
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
