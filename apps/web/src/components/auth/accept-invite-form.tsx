// Accept-invite form (ADR-0030). Sets the initial password for an
// invited operator, keyed by the token in the invitation link. Posts to
// `POST /api/auth/accept-invite`; on success sends the operator to
// /sign-in to authenticate.

"use client";

import { useState, type FormEvent } from "react";

const inputClass =
  "w-full rounded-md border border-line-strong bg-surface-2 px-3 py-2 text-sm text-fg outline-none focus:border-brand";

export function AcceptInviteForm({ token }: { readonly token: string }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/accept-invite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (response.ok) {
        setDone(true);
        setTimeout(() => window.location.assign("/sign-in"), 1200);
        return;
      }
      setError(data.error ?? "Could not set your password.");
      setBusy(false);
    } catch {
      setError("Network error. Try again.");
      setBusy(false);
    }
  }

  if (token.length === 0) {
    return (
      <div className="w-full rounded-lg border border-line bg-surface p-6 text-sm text-muted">
        This invitation link is missing its token. Use the link from your invitation email.
      </div>
    );
  }

  if (done) {
    return (
      <div className="w-full rounded-lg border border-line bg-surface p-6 text-sm text-fg">
        Password set. Redirecting you to sign in…
      </div>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      className="w-full space-y-4 rounded-lg border border-line bg-surface p-6"
    >
      <label className="block space-y-1.5">
        <span className="text-sm font-medium text-fg">New password</span>
        <input
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={inputClass}
        />
      </label>
      <label className="block space-y-1.5">
        <span className="text-sm font-medium text-fg">Confirm password</span>
        <input
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className={inputClass}
        />
      </label>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-md bg-brand px-3 py-2 text-sm font-medium text-brand-fg shadow-sm hover:bg-brand-hover disabled:opacity-60"
      >
        {busy ? "Setting password…" : "Set password"}
      </button>
    </form>
  );
}
