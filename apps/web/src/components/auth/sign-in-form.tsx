// Sign-in form for the in-house identity engine (ADR-0030).
//
// Posts email + password (+ TOTP/recovery code when MFA is required) to
// `POST /api/auth/sign-in`. The route resolves the org from the
// subdomain, runs `signIn()`, and sets the session cookie. On the
// `MFA_REQUIRED` code we reveal the code field and re-submit. On success
// we navigate to /ops (a full navigation so the new session cookie is
// picked up by the next request).

"use client";

import { useState, type FormEvent } from "react";

const inputClass =
  "w-full rounded-md border border-line-strong bg-surface-2 px-3 py-2 text-sm text-fg outline-none focus:border-brand";

export function SignInForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [needMfa, setNeedMfa] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/sign-in", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          ...(needMfa && mfaCode.length > 0 ? { mfaCode } : {}),
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        code?: string;
      };
      if (response.ok) {
        window.location.assign("/ops");
        return;
      }
      if (data.code === "MFA_REQUIRED") {
        setNeedMfa(true);
        setError(mfaCode.length > 0 ? "Invalid code. Try again." : null);
        setBusy(false);
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
      {needMfa ? (
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-fg">Authentication code</span>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            value={mfaCode}
            onChange={(e) => setMfaCode(e.target.value)}
            placeholder="6-digit code or recovery code"
            className={inputClass}
          />
        </label>
      ) : null}
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-md bg-brand px-3 py-2 text-sm font-medium text-brand-fg shadow-sm hover:bg-brand-hover disabled:opacity-60"
      >
        {busy ? "Signing in…" : needMfa ? "Verify" : "Sign in"}
      </button>
    </form>
  );
}
