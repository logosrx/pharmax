"use client";

// QueueFlash — turns the command routes' redirect flash into toasts.
//
// Every ops command route (via dispatchOpsCommand) redirects back with
// `?flash=<key>&orderId=<id>` on success or `?error=<CODE: message>`
// on failure. This component — mounted once per command surface with
// that page's key→message map — is the single place those params
// become operator feedback, so wiring the toast system here covers
// every ActionForm dispatcher (typing, PV1, fill, final, shipping,
// order actions, billing, compliance) without touching each page.
//
// It renders nothing: it fires a toast on arrival and then strips the
// flash params from the URL (history.replaceState) so refresh /
// back-forward navigation does not re-announce a stale outcome.
//
// The error payload's leading `CODE:` prefix is split into the
// toast's mono `detail`, giving operators a support-quotable
// identifier. PHI: none — flash keys, order ids, and typed error
// codes/messages only.

import { useEffect, useRef } from "react";

import { useToast } from "../ui/toast.js";

function pick(params: Record<string, string | string[] | undefined>, key: string): string | null {
  const v = params[key];
  return typeof v === "string" ? v : null;
}

/**
 * Split a redirect error payload of the shape `CODE: message` (the
 * format dispatchOpsCommand emits) into a support-quotable code and a
 * human message. Payloads without a code prefix pass through whole.
 */
export function parseFlashError(raw: string): {
  readonly message: string;
  readonly code: string | null;
} {
  const match = /^([A-Z][A-Z0-9_]*):\s+(.*)$/s.exec(raw);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return { message: raw, code: null };
  }
  return { message: match[2], code: match[1] };
}

const FLASH_PARAM_KEYS = ["flash", "orderId", "error"] as const;

function stripFlashParamsFromUrl(): void {
  const url = new URL(window.location.href);
  let changed = false;
  for (const key of FLASH_PARAM_KEYS) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }
  if (changed) {
    window.history.replaceState(window.history.state, "", url.toString());
  }
}

export function QueueFlash({
  params,
  messages,
}: {
  readonly params: Record<string, string | string[] | undefined>;
  readonly messages: Readonly<Record<string, string>>;
}) {
  const toast = useToast();
  const firedRef = useRef<string | null>(null);

  const flashKey = pick(params, "flash");
  const orderId = pick(params, "orderId");
  const error = pick(params, "error");
  const successMessage = flashKey !== null ? (messages[flashKey] ?? null) : null;

  useEffect(() => {
    if (successMessage === null && error === null) return;

    // Guard against strict-mode effect replays and parent re-renders
    // re-announcing the same navigation's outcome. (The store also
    // dedupes identical toasts; this keeps intent explicit.)
    const signature = `${flashKey ?? ""}\u0000${orderId ?? ""}\u0000${error ?? ""}`;
    if (firedRef.current === signature) return;
    firedRef.current = signature;

    if (successMessage !== null) {
      toast.success(successMessage, orderId !== null ? { detail: orderId } : {});
    }
    if (error !== null) {
      const parsed = parseFlashError(error);
      toast.error("That action didn't go through", {
        description: parsed.message,
        ...(parsed.code !== null ? { detail: parsed.code } : {}),
      });
    }
    stripFlashParamsFromUrl();
  }, [toast, flashKey, orderId, error, successMessage]);

  return null;
}
