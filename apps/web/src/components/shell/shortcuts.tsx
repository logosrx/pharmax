"use client";

// GlobalShortcuts — the console's keyboard-first layer.
//
// One global keydown listener (mounted once in the ops layout) that
// owns everything the command palette doesn't:
//
//   - "g then x" navigation chords (Linear/GitHub style, 800ms
//     window) bound ONLY to destinations in the permission-filtered
//     nav tree the layout computed — unauthorized routes never bind.
//   - "/" focuses the topbar order search (via a custom event, so
//     the search stays decoupled from this component).
//   - "?" opens a cheat-sheet dialog listing every shortcut.
//   - "j" / "k" move a visual selection through queue rows (any
//     [data-kbd-row] rendered by QueueRow); Enter opens the selected
//     order.
//
// ⌘K stays owned by CommandPalette. Nothing here fires while focus is
// in a text-entry control or while any modal dialog is open — the
// matching/suppression rules live in shortcuts-model.ts (pure,
// unit-tested).

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Kbd } from "../ui/badge.js";
import { Icon } from "../ui/icon.js";
import {
  FOCUS_ORDER_SEARCH_EVENT,
  advanceChord,
  buildNavChords,
  shouldSuppressShortcut,
  type ChordState,
} from "./shortcuts-model.js";
import type { NavGroup } from "./sidebar-nav.js";

function queueRows(): ReadonlyArray<HTMLElement> {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-kbd-row]"));
}

/** One line of the cheat sheet: key chips + what they do. */
function CheatRow({
  keys,
  children,
}: {
  readonly keys: ReadonlyArray<string>;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md px-3 py-1.5">
      <span className="min-w-0 flex-1 truncate text-sm text-muted">{children}</span>
      <span className="flex shrink-0 items-center gap-1">
        {keys.map((k, i) => (
          <Kbd key={`${k}:${i}`}>{k}</Kbd>
        ))}
      </span>
    </div>
  );
}

export function GlobalShortcuts({ groups }: { readonly groups: ReadonlyArray<NavGroup> }) {
  const router = useRouter();
  const pathname = usePathname();
  const [cheatOpen, setCheatOpen] = useState(false);
  const [isMac, setIsMac] = useState(true);
  const chordRef = useRef<ChordState | null>(null);
  const rowIndexRef = useRef(-1);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const chords = useMemo(() => buildNavChords(groups), [groups]);

  useEffect(() => {
    setIsMac(!/windows|linux/i.test(window.navigator.userAgent));
  }, []);

  const clearRowSelection = useCallback(() => {
    for (const el of queueRows()) el.removeAttribute("data-kbd-selected");
    rowIndexRef.current = -1;
  }, []);

  // Queue rows unmount on navigation; drop the stale index with them.
  useEffect(() => {
    rowIndexRef.current = -1;
  }, [pathname]);

  const moveRowSelection = useCallback((delta: 1 | -1) => {
    const rows = queueRows();
    if (rows.length === 0) return;
    const current = rowIndexRef.current;
    const next =
      current === -1
        ? delta === 1
          ? 0
          : rows.length - 1
        : Math.max(0, Math.min(current + delta, rows.length - 1));
    rows.forEach((el, i) => {
      if (i === next) el.setAttribute("data-kbd-selected", "true");
      else el.removeAttribute("data-kbd-selected");
    });
    rows[next]?.scrollIntoView({ block: "nearest" });
    rowIndexRef.current = next;
  }, []);

  const openCheatSheet = useCallback(() => {
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setCheatOpen(true);
  }, []);

  // Return focus to wherever the operator was when "?" was pressed
  // (or to the trigger chip), so the keyboard position is not lost.
  const closeCheatSheet = useCallback(() => {
    setCheatOpen(false);
    const restore = restoreFocusRef.current;
    if (restore !== null && restore.isConnected && restore !== document.body) restore.focus();
    else triggerRef.current?.focus();
  }, []);

  // The single global listener. Chords are attempted first (they may
  // consume "g" or a bound second key); everything else falls through.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented) return;
      const el = e.target instanceof HTMLElement ? e.target : null;
      const suppressed = shouldSuppressShortcut({
        targetTag: el?.tagName ?? null,
        targetIsContentEditable: el?.isContentEditable ?? false,
        dialogOpen: document.querySelector('[role="dialog"][aria-modal="true"]') !== null,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
      });
      if (suppressed) {
        chordRef.current = null;
        return;
      }

      const chord = advanceChord(chordRef.current, e.key, Date.now(), chords);
      chordRef.current = chord.state;
      if (chord.matched !== null) {
        e.preventDefault();
        clearRowSelection();
        router.push(chord.matched.href);
        return;
      }
      if (chord.consumed) {
        e.preventDefault();
        return;
      }

      if (e.key === "?") {
        e.preventDefault();
        openCheatSheet();
        return;
      }
      if (e.key === "/") {
        e.preventDefault();
        window.dispatchEvent(new Event(FOCUS_ORDER_SEARCH_EVENT));
        return;
      }
      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        moveRowSelection(e.key === "j" ? 1 : -1);
        return;
      }
      if (e.key === "Enter") {
        // Never hijack Enter aimed at a focused control (button, link,
        // option) — that keypress belongs to the control.
        if (el !== null && el.closest("a,button,[role='option']") !== null) return;
        const row = rowIndexRef.current >= 0 ? queueRows()[rowIndexRef.current] : undefined;
        const href = row?.getAttribute("data-kbd-href");
        if (href !== undefined && href !== null && href.length > 0) {
          e.preventDefault();
          router.push(href);
        }
        return;
      }
      if (e.key === "Escape" && rowIndexRef.current !== -1) {
        clearRowSelection();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chords, router, clearRowSelection, moveRowSelection, openCheatSheet]);

  // Focus the dialog's close button and lock body scroll while open
  // (same containment pattern as the command palette).
  useEffect(() => {
    if (!cheatOpen) return;
    closeRef.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [cheatOpen]);

  function onDialogKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeCheatSheet();
    } else if (e.key === "Tab") {
      // The close button is the only focusable element — trap focus.
      e.preventDefault();
      closeRef.current?.focus();
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (cheatOpen ? closeCheatSheet() : openCheatSheet())}
        aria-label="Keyboard shortcuts"
        aria-haspopup="dialog"
        title="Keyboard shortcuts"
        className="hidden h-9 shrink-0 items-center rounded-md border border-line-strong bg-surface-2 px-2 text-muted shadow-xs transition-colors hover:bg-surface-3 hover:text-fg md:inline-flex"
      >
        <Kbd>?</Kbd>
      </button>

      {cheatOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[14vh]"
          role="presentation"
          onMouseDown={closeCheatSheet}
        >
          <div className="animate-fade-in absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Keyboard shortcuts"
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={onDialogKeyDown}
            className="animate-slide-up surface-sheen relative w-full max-w-lg overflow-hidden rounded-xl border border-line bg-surface shadow-lg"
          >
            <div className="flex h-12 items-center gap-3 border-b border-line px-4">
              <Icon name="dashboard" size={16} className="shrink-0 text-subtle" />
              <h2 className="flex-1 text-sm font-medium text-fg">Keyboard shortcuts</h2>
              <button
                ref={closeRef}
                type="button"
                onClick={closeCheatSheet}
                aria-label="Close keyboard shortcuts"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-subtle transition-colors hover:bg-surface-2 hover:text-fg"
              >
                <Icon name="x" size={14} />
              </button>
            </div>

            <div className="max-h-[52vh] space-y-1 overflow-y-auto p-2">
              {chords.length > 0 ? (
                <>
                  <p className="px-3 pb-1 pt-3 text-3xs font-semibold uppercase tracking-caps text-subtle first:pt-1">
                    Navigation
                  </p>
                  {chords.map((c) => (
                    <CheatRow key={c.href} keys={["g", c.key]}>
                      Go to {c.label}
                    </CheatRow>
                  ))}
                </>
              ) : null}

              <p className="px-3 pb-1 pt-3 text-3xs font-semibold uppercase tracking-caps text-subtle first:pt-1">
                Search
              </p>
              <CheatRow keys={["/"]}>Focus order search</CheatRow>
              <CheatRow keys={isMac ? ["⌘", "K"] : ["Ctrl", "K"]}>Open command palette</CheatRow>

              <p className="px-3 pb-1 pt-3 text-3xs font-semibold uppercase tracking-caps text-subtle first:pt-1">
                General
              </p>
              <CheatRow keys={["j", "k"]}>Move queue selection down / up</CheatRow>
              <CheatRow keys={["↵"]}>Open selected order</CheatRow>
              <CheatRow keys={["?"]}>Show this cheat sheet</CheatRow>
              <CheatRow keys={["esc"]}>Close dialogs · clear selection</CheatRow>
            </div>

            <div className="flex items-center gap-4 border-t border-line bg-surface-2/60 px-4 py-2 text-2xs text-subtle">
              <span className="inline-flex items-center gap-1.5">
                <Kbd>esc</Kbd> close
              </span>
              <span>Shortcuts pause while you type or a dialog is open.</span>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
