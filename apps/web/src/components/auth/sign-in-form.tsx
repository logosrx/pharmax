// Sign-in form for the in-house identity engine (ADR-0030 / ADR-0036).
//
// Posts email + password to `POST /api/auth/sign-in`. On `MFA_REQUIRED`
// the response lists the account's second-factor `methods`:
//
//   - TOTP     → reveal the code field and re-submit with `mfaCode`.
//   - WEBAUTHN → offer "Use security key": fetch assertion options
//     (password-gated), run `navigator.credentials.get()` via
//     @simplewebauthn/browser, and re-submit with the assertion.
//
// On success we navigate to /ops (a full navigation so the new session
// cookie is picked up by the next request).

"use client";

import { useState, type FormEvent } from "react";
import {
  startAuthentication,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

const inputClass =
  "w-full rounded-md border border-line-strong bg-surface-2 px-3 py-2 text-sm text-fg outline-none focus:border-brand";

interface SignInErrorBody {
  error?: string;
  code?: string;
  methods?: string[];
}

export function SignInForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [needMfa, setNeedMfa] = useState(false);
  const [mfaMethods, setMfaMethods] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const offersWebAuthn = mfaMethods.includes("WEBAUTHN");
  const offersCode = !needMfa || mfaMethods.length === 0 || mfaMethods.includes("TOTP");

  async function submitSignIn(extra: Record<string, unknown>): Promise<void> {
    const response = await fetch("/api/auth/sign-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, ...extra }),
    });
    const data = (await response.json().catch(() => ({}))) as SignInErrorBody;
    if (response.ok) {
      window.location.assign("/ops");
      return;
    }
    if (data.code === "MFA_REQUIRED") {
      setNeedMfa(true);
      setMfaMethods(Array.isArray(data.methods) ? data.methods : []);
      setError(mfaCode.length > 0 ? "Invalid code. Try again." : null);
      setBusy(false);
      return;
    }
    setError(data.error ?? "Sign-in failed.");
    setBusy(false);
  }

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await submitSignIn(needMfa && mfaCode.length > 0 ? { mfaCode } : {});
    } catch {
      setError("Network error. Try again.");
      setBusy(false);
    }
  }

  async function onUseSecurityKey(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const optionsResponse = await fetch("/api/auth/webauthn/authenticate/options", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const optionsData = (await optionsResponse.json().catch(() => ({}))) as {
        error?: string;
        challengeId?: string;
        options?: PublicKeyCredentialRequestOptionsJSON;
      };
      if (
        !optionsResponse.ok ||
        optionsData.challengeId === undefined ||
        optionsData.options === undefined
      ) {
        setError(optionsData.error ?? "Could not start the security-key check.");
        setBusy(false);
        return;
      }

      let assertion: unknown;
      try {
        assertion = await startAuthentication({ optionsJSON: optionsData.options });
      } catch {
        setError("Security key was not verified. Try again or use a code.");
        setBusy(false);
        return;
      }

      await submitSignIn({
        webauthn: { challengeId: optionsData.challengeId, response: assertion },
      });
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
      {needMfa && offersCode ? (
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
      {needMfa && offersWebAuthn ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void onUseSecurityKey()}
          className="w-full rounded-md border border-line-strong bg-surface-2 px-3 py-2 text-sm font-medium text-fg hover:bg-surface disabled:opacity-60"
        >
          Use security key
        </button>
      ) : null}
    </form>
  );
}
