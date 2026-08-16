"use client";

// CommandPalette — ⌘K jump-anywhere for the operator console.
//
// One keystroke opens a filterable list of every destination the
// operator is allowed to see (the same permission-filtered nav tree
// the sidebar renders — nothing unauthorized can appear here), plus
// quick actions (theme, account) and an "open order" passthrough that
// routes free text to the order-detail resolver exactly like the scan
// bar does.
//
// Pure client presentation: no data fetching, no new dependencies.
// Keyboard model: ⌘K/Ctrl+K toggles, ↑/↓ move, Enter runs, Esc closes.

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { applyThemeChoice, persistThemeChoice } from "../../lib/theme-client.js";
import type { ThemeChoice } from "../../lib/theme.js";
import { Kbd } from "../ui/badge.js";
import { cx } from "../ui/cx.js";
import { Icon, type IconName } from "../ui/icon.js";
import { rankEntries } from "./command-palette-model.js";
import type { NavGroup } from "./sidebar-nav.js";

const RECENTS_KEY = "pharmax-palette-recents";
const RECENTS_MAX = 5;

interface PaletteCommand {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly icon: IconName;
  /** Right-edge hint (e.g. destination kind). */
  readonly hint?: string;
  readonly run: () => void;
}

function readRecents(): ReadonlyArray<string> {
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function pushRecent(id: string): void {
  try {
    const next = [id, ...readRecents().filter((x) => x !== id)].slice(0, RECENTS_MAX);
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* private mode — recents just won't persist */
  }
}

export function CommandPalette({ groups }: { readonly groups: ReadonlyArray<NavGroup> }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [recentIds, setRecentIds] = useState<ReadonlyArray<string>>([]);
  const [isMac, setIsMac] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setIsMac(!/windows|linux/i.test(window.navigator.userAgent));
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActiveIndex(0);
    // Return focus to the trigger so the keyboard position is not
    // lost when the dialog unmounts (harmless before a navigation).
    triggerRef.current?.focus();
  }, []);

  const commands = useMemo<ReadonlyArray<PaletteCommand>>(() => {
    const nav: PaletteCommand[] = groups.flatMap((group) =>
      group.items.map((item) => ({
        id: `nav:${item.href}`,
        label: item.label,
        group: group.label,
        icon: item.icon,
        hint: "Page",
        run: () => router.push(item.href),
      }))
    );
    const theme: PaletteCommand[] = (
      [
        ["dark", "Theme: Dark", "moon"],
        ["light", "Theme: Light", "sun"],
        ["system", "Theme: System", "monitor"],
      ] as ReadonlyArray<[ThemeChoice, string, IconName]>
    ).map(([choice, label, icon]) => ({
      id: `theme:${choice}`,
      label,
      group: "Preferences",
      icon,
      hint: "Action",
      run: () => {
        applyThemeChoice(choice);
        void persistThemeChoice(choice);
      },
    }));
    const account: PaletteCommand[] = [
      {
        id: "nav:/ops/account/security",
        label: "Account security",
        group: "Account",
        icon: "shield",
        hint: "Page",
        run: () => router.push("/ops/account/security"),
      },
      {
        id: "nav:/ops/account/appearance",
        label: "Appearance settings",
        group: "Account",
        icon: "settings",
        hint: "Page",
        run: () => router.push("/ops/account/appearance"),
      },
    ];
    return [...nav, ...account, ...theme];
  }, [groups, router]);

  // Visible list: ranked matches while filtering; recents-then-all when idle.
  const visible = useMemo<ReadonlyArray<PaletteCommand>>(() => {
    const q = query.trim().toLowerCase();
    let base: PaletteCommand[];
    if (q.length === 0) {
      const byId = new Map(commands.map((c) => [c.id, c]));
      const recents = recentIds
        .map((id) => byId.get(id))
        .filter((c): c is PaletteCommand => c !== undefined)
        .map((c) => ({ ...c, group: "Recent" }));
      const recentSet = new Set(recents.map((c) => c.id));
      base = [...recents, ...commands.filter((c) => !recentSet.has(c.id))];
    } else {
      base = [...rankEntries(commands, q)];
    }
    // Free-text passthrough: anything that could be an order number or
    // scanned barcode routes to the order resolver, same as the scan bar.
    if (q.length >= 3) {
      base = [
        ...base,
        {
          id: "order:open",
          label: `Open order “${query.trim()}”`,
          group: "Orders",
          icon: "scan",
          hint: "Go",
          run: () => router.push(`/ops/orders/${encodeURIComponent(query.trim())}`),
        },
      ];
    }
    return base;
  }, [commands, query, recentIds, router]);

  const openPalette = useCallback(() => {
    setRecentIds(readRecents());
    setOpen(true);
  }, []);

  // Global shortcut — works even while typing (the modifier disambiguates).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (open) close();
        else openPalette();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close, openPalette]);

  // Focus the input and lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Keep the active option in view as the selection moves.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  function runCommand(cmd: PaletteCommand) {
    pushRecent(cmd.id);
    close();
    cmd.run();
  }

  function onInputKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, visible.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cmd = visible[activeIndex];
      if (cmd !== undefined) runCommand(cmd);
    } else if (e.key === "Tab") {
      // Single-field dialog: keep focus on the input.
      e.preventDefault();
    }
  }

  // Section headers only make sense for the idle (unfiltered) listing.
  const showGroups = query.trim().length === 0;
  let lastGroup: string | null = null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={openPalette}
        aria-label="Open command palette"
        aria-haspopup="dialog"
        className="hidden h-9 shrink-0 items-center gap-2 rounded-md border border-line-strong bg-surface-2 px-3 text-sm text-muted shadow-xs transition-colors hover:bg-surface-3 hover:text-fg md:inline-flex"
      >
        <Icon name="search" size={14} />
        <span className="hidden lg:inline">Commands</span>
        <Kbd>{isMac ? "⌘K" : "Ctrl K"}</Kbd>
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[14vh]"
          role="presentation"
          onMouseDown={close}
        >
          <div className="animate-fade-in absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            onMouseDown={(e) => e.stopPropagation()}
            className="animate-slide-up surface-sheen relative w-full max-w-lg overflow-hidden rounded-xl border border-line bg-surface shadow-lg"
          >
            <div className="flex items-center gap-3 border-b border-line px-4">
              <Icon name="search" size={16} className="shrink-0 text-subtle" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActiveIndex(0);
                }}
                onKeyDown={onInputKeyDown}
                role="combobox"
                aria-expanded="true"
                aria-controls="command-palette-list"
                aria-activedescendant={
                  visible[activeIndex] !== undefined ? `palette-opt-${activeIndex}` : undefined
                }
                autoComplete="off"
                spellCheck={false}
                placeholder="Jump to a page, run an action, or open an order…"
                className="h-12 w-full bg-transparent text-sm text-fg placeholder:text-subtle focus:outline-none"
              />
              <Kbd>esc</Kbd>
            </div>

            <div
              ref={listRef}
              id="command-palette-list"
              role="listbox"
              aria-label="Commands"
              className="max-h-[52vh] overflow-y-auto p-2"
            >
              {visible.length === 0 ? (
                <p className="px-3 py-8 text-center text-sm text-muted">
                  No matches. Try a page name, or paste an order number.
                </p>
              ) : (
                visible.map((cmd, index) => {
                  const header = showGroups && cmd.group !== lastGroup ? cmd.group : null;
                  lastGroup = cmd.group;
                  const active = index === activeIndex;
                  return (
                    <div key={`${cmd.id}:${index}`}>
                      {header !== null ? (
                        <p className="px-3 pb-1 pt-3 text-3xs font-semibold uppercase tracking-caps text-subtle first:pt-1">
                          {header}
                        </p>
                      ) : null}
                      <button
                        type="button"
                        id={`palette-opt-${index}`}
                        data-index={index}
                        role="option"
                        aria-selected={active}
                        onClick={() => runCommand(cmd)}
                        onMouseMove={() => setActiveIndex(index)}
                        className={cx(
                          "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors",
                          active ? "bg-brand/12 text-fg" : "text-muted"
                        )}
                      >
                        <Icon
                          name={cmd.icon}
                          size={16}
                          className={cx("shrink-0", active ? "text-brand" : "text-subtle")}
                        />
                        <span className="min-w-0 flex-1 truncate">{cmd.label}</span>
                        <span className="shrink-0 text-2xs text-subtle">
                          {active ? <Kbd>↵</Kbd> : cmd.hint}
                        </span>
                      </button>
                    </div>
                  );
                })
              )}
            </div>

            <div className="flex items-center gap-4 border-t border-line bg-surface-2/60 px-4 py-2 text-2xs text-subtle">
              <span className="inline-flex items-center gap-1.5">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd> navigate
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Kbd>↵</Kbd> open
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Kbd>esc</Kbd> close
              </span>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
