// Provider portal password-change form (ADR-0033, slice 3).
//
// Posts current + new password to
// `POST /api/portal/v1/auth/change-password`. The server verifies the
// current password (a hijacked session alone cannot rotate the
// credential) and revokes every other portal session on success.
// Password-policy violations from the server are listed verbatim.

"use client";

import { useState, type FormEvent } from "react";

const inputClass =
  "w-full rounded-md border border-line-strong bg-surface-2 px-3 py-2 text-sm text-fg outline-none " +
  "focus:border-brand focus:ring-2 focus:ring-ring/40";

export function PortalChangePasswordForm() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [violations, setViolations] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (password !== confirm) {
      setError("New passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    setViolations([]);
    setDone(false);
    try {
      const response = await fetch("/api/portal/v1/auth/change-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword: password }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        violations?: readonly { message?: string }[];
      };
      if (response.ok) {
        setDone(true);
        setCurrentPassword("");
        setPassword("");
        setConfirm("");
        setBusy(false);
        return;
      }
      if (Array.isArray(data.violations) && data.violations.length > 0) {
        setViolations(
          data.violations.map((v) => v.message ?? "Password does not meet the policy.")
        );
      }
      setError(data.error ?? "Password change failed.");
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
      <h2 className="text-sm font-semibold text-fg">Change password</h2>
      <label className="block space-y-1.5">
        <span className="text-sm font-medium text-fg">Current password</span>
        <input
          type="password"
          autoComplete="current-password"
          required
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          className={inputClass}
        />
      </label>
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
        <span className="text-sm font-medium text-fg">Confirm new password</span>
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
      {done ? (
        <p role="status" className="text-sm text-tone-success">
          Password updated. Other signed-in devices have been signed out.
        </p>
      ) : null}
      <button
        type="submit"
        disabled={busy}
        className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-brand-fg shadow-sm hover:bg-brand-hover disabled:opacity-60"
      >
        {busy ? "Updating…" : "Update password"}
      </button>
    </form>
  );
}
