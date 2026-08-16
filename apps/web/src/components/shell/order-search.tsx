"use client";

// OrderSearch — scan-to-open / jump-to-order bar in the topbar.
//
// An operator can scan a barcode or type an order number and hit
// Enter to jump straight to the order detail page (which resolves the
// external order number or id, and fails gracefully if unknown). This
// is the console's fast path: hands-on-scanner, eyes-on-queue.
//
// "/" focuses the field from anywhere. The keydown itself lives in
// the GlobalShortcuts registry (which owns suppression rules — typing
// context, open dialogs); it asks for focus over a custom event so the
// two components stay decoupled.

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { Icon } from "../ui/icon.js";
import { Kbd } from "../ui/badge.js";
import { FOCUS_ORDER_SEARCH_EVENT } from "./shortcuts-model.js";

export function OrderSearch() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");

  useEffect(() => {
    function onFocusRequest() {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
    window.addEventListener(FOCUS_ORDER_SEARCH_EVENT, onFocusRequest);
    return () => window.removeEventListener(FOCUS_ORDER_SEARCH_EVENT, onFocusRequest);
  }, []);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const q = value.trim();
    if (q.length === 0) return;
    router.push(`/ops/orders/${encodeURIComponent(q)}`);
  }

  return (
    <form onSubmit={onSubmit} className="relative w-full max-w-md">
      <Icon
        name="scan"
        size={16}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle"
      />
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        inputMode="search"
        autoComplete="off"
        spellCheck={false}
        placeholder="Search or scan an order…"
        aria-label="Search or scan an order"
        className="h-9 w-full rounded-md border border-line-strong bg-surface-2 pl-9 pr-12 text-sm text-fg placeholder:text-subtle shadow-xs transition-colors focus:border-brand focus:outline-none focus:ring-2 focus:ring-ring/40"
      />
      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2">
        <Kbd>/</Kbd>
      </span>
    </form>
  );
}
