"use client";

// Mint + revoke controls for `/ops/admin/api-keys`.
//
// These are fetch-based client components, NOT `ActionForm` posts,
// because the mint response contract is unique in the admin console:
// the raw `pxk_` token is returned in the JSON body exactly once and
// must be rendered without a navigation (a redirect+flash flow
// physically cannot deliver it — the token never enters the command
// bus or any store the redirect target could read).
//
// Idempotency: the mint form owns the caller side of the create
// route's `Idempotency-Key` contract. One key is generated per form
// "attempt series" — kept across network retries so an honest retry
// replays instead of minting a second live key, and discarded as soon
// as the operator edits any input (a changed payload under the same
// key would be rejected as a mismatch, not replayed).
//
// PHI: none. Key labels, permission codes, and the one-time token.

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { buttonClass } from "../ui/button.js";
import { Banner } from "../ui/feedback.js";
import { Field, Input } from "../ui/field.js";
import { Icon } from "../ui/icon.js";
import { useToast } from "../ui/toast.js";

export interface ScopeOption {
  readonly code: string;
  readonly description: string;
}

export interface QuotaTierOption {
  readonly tier: string;
  /** Rendered numbers, e.g. "120 req/min · 50,000 req/day". */
  readonly description: string;
}

interface MintSuccess {
  readonly apiKeyId: string;
  readonly name: string;
  readonly tokenPrefix: string;
  /** null on idempotent replay — the original token is gone for good. */
  readonly token: string | null;
}

export function MintApiKeyForm({
  scopeOptions,
  quotaTierOptions,
}: {
  readonly scopeOptions: ReadonlyArray<ScopeOption>;
  readonly quotaTierOptions: ReadonlyArray<QuotaTierOption>;
}) {
  const router = useRouter();
  const toast = useToast();
  const defaultTier = quotaTierOptions[0]?.tier ?? "STANDARD";
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ReadonlySet<string>>(new Set());
  const [quotaTier, setQuotaTier] = useState<string>(defaultTier);
  const [pending, setPending] = useState(false);
  const [minted, setMinted] = useState<MintSuccess | null>(null);
  const [copied, setCopied] = useState(false);
  const idempotencyKeyRef = useRef<string | null>(null);

  function invalidateIdempotencyKey(): void {
    idempotencyKeyRef.current = null;
  }

  function toggleScope(code: string): void {
    invalidateIdempotencyKey();
    setScopes((prev) => {
      const next = new Set(prev);
      if (next.has(code)) {
        next.delete(code);
      } else {
        next.add(code);
      }
      return next;
    });
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (pending) return;
    setMinted(null);
    setCopied(false);
    if (scopes.size === 0) {
      toast.warning("Select at least one scope.");
      return;
    }
    idempotencyKeyRef.current ??= crypto.randomUUID();
    setPending(true);
    try {
      const response = await fetch("/api/ops/admin/api-keys/create", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKeyRef.current,
        },
        body: JSON.stringify({ name: name.trim(), scopes: [...scopes].sort(), quotaTier }),
      });
      const body = (await response.json().catch(() => null)) as {
        data?: MintSuccess;
        error?: { code?: string; message?: string };
      } | null;
      if (!response.ok || body?.data === undefined) {
        toast.error("That mint didn't go through", {
          description: body?.error?.message ?? `Mint failed (HTTP ${response.status}).`,
          ...(body?.error?.code !== undefined ? { detail: body.error.code } : {}),
        });
        return;
      }
      // Success (fresh or replay): this attempt series is finished.
      invalidateIdempotencyKey();
      setMinted(body.data);
      setName("");
      setScopes(new Set());
      setQuotaTier(defaultTier);
      toast.success(`API key "${body.data.name}" minted`, {
        description: "The one-time token is shown above — store it now.",
        detail: `${body.data.tokenPrefix}…`,
      });
      router.refresh();
    } catch {
      // Network failure: keep the idempotency key so a retry replays.
      toast.error("Network error", {
        description: "Retrying is safe — the same request will not mint twice.",
      });
    } finally {
      setPending(false);
    }
  }

  async function copyToken(token: string): Promise<void> {
    await navigator.clipboard.writeText(token);
    setCopied(true);
  }

  return (
    <div className="space-y-4">
      {minted !== null ? (
        minted.token !== null ? (
          <Banner tone="success" title={`Key "${minted.name}" minted (${minted.tokenPrefix}…)`}>
            <div className="space-y-2">
              <p>
                This is the only time the full token is shown. Store it in the partner&apos;s secret
                manager now — Pharmax keeps only a hash and cannot display it again.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <code className="break-all rounded bg-canvas px-2 py-1 font-mono text-xs">
                  {minted.token}
                </code>
                <button
                  type="button"
                  onClick={() => void copyToken(minted.token as string)}
                  className={buttonClass({ variant: "secondary", size: "sm" })}
                >
                  {copied ? <Icon name="check" size={14} /> : null}
                  {copied ? "Copied" : "Copy token"}
                </button>
              </div>
            </div>
          </Banner>
        ) : (
          <Banner tone="warning" title="Key already minted — token not available">
            A previous attempt with this request already minted{" "}
            <code className="font-mono">{minted.tokenPrefix}…</code>. The raw token is only returned
            on first creation; if it was lost, revoke this key and mint a new one.
          </Banner>
        )
      ) : null}

      <form onSubmit={(e) => void onSubmit(e)} className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Name" required help="Operator-facing label, e.g. Acme telehealth prod">
            <Input
              type="text"
              name="name"
              required
              maxLength={120}
              value={name}
              onChange={(e) => {
                invalidateIdempotencyKey();
                setName(e.target.value);
              }}
              placeholder="Acme telehealth prod"
            />
          </Field>
          <Field label="Scopes" required help="Permission codes the key may exercise on the v1 API">
            <div className="space-y-2 pt-1">
              {scopeOptions.map((opt) => (
                <label key={opt.code} className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={scopes.has(opt.code)}
                    onChange={() => toggleScope(opt.code)}
                    className="mt-0.5 accent-current"
                  />
                  <span>
                    <code className="font-mono text-xs font-medium">{opt.code}</code>
                    <span className="block text-xs text-subtle">{opt.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </Field>
          <Field
            label="Quota tier"
            help="Burst rate + daily quota the key is held to. Elevated is granted per partner agreement."
          >
            <div className="space-y-2 pt-1">
              {quotaTierOptions.map((opt) => (
                <label key={opt.tier} className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="quotaTier"
                    checked={quotaTier === opt.tier}
                    onChange={() => {
                      invalidateIdempotencyKey();
                      setQuotaTier(opt.tier);
                    }}
                    className="mt-0.5 accent-current"
                  />
                  <span>
                    <code className="font-mono text-xs font-medium">{opt.tier.toLowerCase()}</code>
                    <span className="block text-xs text-subtle">{opt.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </Field>
        </div>
        <button
          type="submit"
          disabled={pending}
          className={buttonClass({ variant: "primary", size: "md" })}
        >
          <Icon name="plus" size={16} />
          {pending ? "Minting…" : "Mint API key"}
        </button>
      </form>
    </div>
  );
}

export function RevokeApiKeyButton({
  apiKeyId,
  name,
  tokenPrefix,
}: {
  readonly apiKeyId: string;
  readonly name: string;
  readonly tokenPrefix: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState(false);

  async function onRevoke(): Promise<void> {
    if (pending) return;
    const reason = window.prompt(
      `Revoke "${name}" (${tokenPrefix}…)?\n\nPartner requests with this key fail immediately. Enter a reason:`
    );
    if (reason === null) return;
    const trimmed = reason.trim();
    if (trimmed.length === 0) {
      toast.warning("A reason is required to revoke a key.");
      return;
    }
    setPending(true);
    try {
      const response = await fetch("/api/ops/admin/api-keys/revoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKeyId, reason: trimmed }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { code?: string; message?: string };
        } | null;
        toast.error("That revoke didn't go through", {
          description: body?.error?.message ?? `Revoke failed (HTTP ${response.status}).`,
          ...(body?.error?.code !== undefined ? { detail: body.error.code } : {}),
        });
        return;
      }
      toast.success(`API key "${name}" revoked`, { detail: `${tokenPrefix}…` });
      router.refresh();
    } catch {
      toast.error("Network error", {
        description: "The revoke may not have applied — retry.",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void onRevoke()}
      disabled={pending}
      className={buttonClass({ variant: "danger", size: "sm" })}
    >
      {pending ? "Revoking…" : "Revoke"}
    </button>
  );
}
