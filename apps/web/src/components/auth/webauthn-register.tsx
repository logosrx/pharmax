// Self-service security-key / passkey registration (ADR-0036).
//
// Drives the two-step ceremony against the account-security routes:
//   1. POST /api/ops/account/security/webauthn/options → challenge +
//      creation options.
//   2. `navigator.credentials.create()` via @simplewebauthn/browser.
//   3. POST /api/ops/account/security/webauthn/verify → credential
//      stored; recovery codes returned ONCE if this was the first
//      authenticator (rendered here and never again).

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
} from "@simplewebauthn/browser";

const inputClass =
  "w-full rounded-md border border-line-strong bg-surface-2 px-3 py-2 text-sm text-fg outline-none focus:border-brand";

export function WebAuthnRegister() {
  const router = useRouter();
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  async function onRegister(): Promise<void> {
    if (label.trim().length === 0) {
      setError("Give this key a name first (e.g. \u201CYubiKey 5C\u201D).");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const optionsResponse = await fetch("/api/ops/account/security/webauthn/options", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const optionsData = (await optionsResponse.json().catch(() => ({}))) as {
        error?: string;
        challengeId?: string;
        options?: PublicKeyCredentialCreationOptionsJSON;
      };
      if (
        !optionsResponse.ok ||
        optionsData.challengeId === undefined ||
        optionsData.options === undefined
      ) {
        setError(optionsData.error ?? "Could not start registration.");
        setBusy(false);
        return;
      }

      let attestation: unknown;
      try {
        attestation = await startRegistration({ optionsJSON: optionsData.options });
      } catch {
        setError("The authenticator did not complete registration. Try again.");
        setBusy(false);
        return;
      }

      const verifyResponse = await fetch("/api/ops/account/security/webauthn/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          challengeId: optionsData.challengeId,
          label: label.trim(),
          response: attestation,
        }),
      });
      const verifyData = (await verifyResponse.json().catch(() => ({}))) as {
        error?: string;
        recoveryCodes?: string[];
      };
      if (!verifyResponse.ok) {
        setError(verifyData.error ?? "The security key could not be verified.");
        setBusy(false);
        return;
      }

      setLabel("");
      setBusy(false);
      if (Array.isArray(verifyData.recoveryCodes) && verifyData.recoveryCodes.length > 0) {
        // First authenticator: show the codes ONCE before refreshing.
        setRecoveryCodes(verifyData.recoveryCodes);
      } else {
        router.refresh();
      }
    } catch {
      setError("Network error. Try again.");
      setBusy(false);
    }
  }

  if (recoveryCodes !== null) {
    return (
      <div className="space-y-3 rounded-lg border border-line bg-surface p-4">
        <p className="text-sm font-medium text-fg">
          Security key added. Save these recovery codes now — they are shown only once and are the
          only way back into your account if you lose the key.
        </p>
        <ul className="grid grid-cols-2 gap-1 font-mono text-sm text-fg">
          {recoveryCodes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ul>
        <button
          type="button"
          onClick={() => {
            setRecoveryCodes(null);
            router.refresh();
          }}
          className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-brand-fg shadow-sm hover:bg-brand-hover"
        >
          I saved my recovery codes
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <label className="block space-y-1.5">
        <span className="text-sm font-medium text-fg">Key name</span>
        <input
          type="text"
          value={label}
          maxLength={64}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="YubiKey 5C, MacBook Touch ID, …"
          className={inputClass}
        />
      </label>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <button
        type="button"
        disabled={busy}
        onClick={() => void onRegister()}
        className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-brand-fg shadow-sm hover:bg-brand-hover disabled:opacity-60"
      >
        {busy ? "Waiting for authenticator…" : "Add security key"}
      </button>
    </div>
  );
}
