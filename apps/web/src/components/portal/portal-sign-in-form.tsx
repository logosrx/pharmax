// Provider portal sign-in form (ADR-0033, slice 2).
//
// Posts email + password to `POST /api/portal/v1/auth/sign-in`. The
// route resolves the org from the subdomain, runs `portalSignIn()`,
// and sets the portal session cookie. On success we navigate to
// /portal (a full navigation so the new cookie is picked up by the
// next request). No MFA field — portal v1 is deliberately
// password-only (see PortalSignIn command notes).

"use client";

import { useState, type FormEvent } from "react";

const inputClass =
  "w-full rounded-md border border-line-strong bg-surface-2 px-3 py-2 text-sm text-fg outline-none " +
  "focus:border-brand focus:ring-2 focus:ring-ring/40";

export function PortalSignInForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/portal/v1/auth/sign-in", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        requiresClientSelection?: boolean;
      };
      if (response.ok) {
        // A prescriber affiliated with several client practices has no
        // client on their session yet, and every data page bounces to
        // the chooser anyway. Going straight there saves a redirect and,
        // more usefully, makes the reason obvious rather than looking
        // like the portal forgot where they were headed.
        window.location.assign(
          data.requiresClientSelection === true ? "/portal/select-client" : "/portal"
        );
        return;
      }
      setError(data.error ?? "Sign-in failed.");
      setBusy(false);
    } catch {
      setError("Network error. Try again.");
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="w-full space-y-4 rounded-lg border border-line bg-surface p-6"
    >
      <label className="block space-y-1.5">
        <span className="text-sm font-medium text-fg">Email</span>
        <input
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={inputClass}
        />
      </label>
      <label className="block space-y-1.5">
        <span className="text-sm font-medium text-fg">Password</span>
        <input
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={inputClass}
        />
      </label>
      {error ? (
        <p role="alert" className="text-sm text-tone-danger">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-md bg-brand px-3 py-2 text-sm font-medium text-brand-fg shadow-sm hover:bg-brand-hover disabled:opacity-60"
      >
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
