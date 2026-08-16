// Provider portal account-setup form (ADR-0033, slice 2).
//
// The prescriber lands here from the emailed /portal/setup?token=…
// link. Posts the token + chosen password to
// `POST /api/portal/v1/auth/setup`; on success routes to
// /portal/sign-in (setup never mints a session — sign-in stays the
// single session-minting path). Password-policy violations from the
// server are listed verbatim under the field.

"use client";

import { useState, type FormEvent } from "react";

const inputClass =
  "w-full rounded-md border border-line-strong bg-surface-2 px-3 py-2 text-sm text-fg outline-none " +
  "focus:border-brand focus:ring-2 focus:ring-ring/40";

export function PortalSetupForm({ token }: { readonly token: string }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [violations, setViolations] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    setViolations([]);
    try {
      const response = await fetch("/api/portal/v1/auth/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, newPassword: password }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        violations?: readonly { message?: string }[];
      };
      if (response.ok) {
        setDone(true);
        window.location.assign("/portal/sign-in");
        return;
      }
      if (Array.isArray(data.violations) && data.violations.length > 0) {
        setViolations(
          data.violations.map((v) => v.message ?? "Password does not meet the policy.")
        );
      }
      setError(data.error ?? "Account setup failed.");
      setBusy(false);
    } catch {
      setError("Network error. Try again.");
      setBusy(false);
    }
  }

  if (done) {
    return <p className="text-sm text-muted">Account activated. Redirecting to sign-in…</p>;
  }

  return (
    <form
      onSubmit={onSubmit}
      className="w-full space-y-4 rounded-lg border border-line bg-surface p-6"
    >
      <label className="block space-y-1.5">
        <span className="text-sm font-medium text-fg">Choose a password</span>
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
      {violations.length > 0 ? (
        <ul role="alert" className="list-disc space-y-1 pl-5 text-sm text-tone-danger">
          {violations.map((message, index) => (
            <li key={index}>{message}</li>
          ))}
        </ul>
      ) : null}
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
        {busy ? "Activating…" : "Activate account"}
      </button>
    </form>
  );
}
