// Portal sign-out button (ADR-0033, slice 2). Posts to the portal
// sign-out route (immediate server-side revocation + cookie clear),
// then hard-navigates to /portal/sign-in.

"use client";

import { useState } from "react";

export function PortalSignOutButton() {
  const [busy, setBusy] = useState(false);

  async function onClick(): Promise<void> {
    setBusy(true);
    try {
      await fetch("/api/portal/v1/auth/sign-out", { method: "POST" });
    } finally {
      window.location.assign("/portal/sign-in");
    }
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
