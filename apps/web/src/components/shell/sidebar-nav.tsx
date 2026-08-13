"use client";

// SidebarNav — grouped, icon-led primary navigation.
//
// Renders the permission-filtered nav (computed server-side and passed
// in as a serializable tree) with:
//   - active-route highlighting (longest-prefix match, so a parent and
//     its child route never both light up),
//   - live queue-depth badges,
//   - a persisted collapse toggle (icons-only rail on narrow focus).
//
// Pure presentation + client routing state; all auth/permission/count
// resolution happens in the server layout.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { cx } from "../ui/cx.js";
import { Icon, type IconName } from "../ui/icon.js";
import { BrandMark, BrandWordmark } from "./brand.js";
import { sumLiveCounts, useLiveQueueCounts } from "./live-queue-counts.js";

export interface NavLink {
  readonly href: string;
  readonly label: string;
  readonly icon: IconName;
  /** SSR-computed badge value (first paint / no-stream fallback). */
  readonly count?: number | null;
  /** Bucket codes whose live sum keeps the badge current (ADR-0034). */
  readonly countCodes?: ReadonlyArray<string>;
}

export interface NavGroup {
  readonly label: string;
  readonly items: ReadonlyArray<NavLink>;
}

const STORAGE_KEY = "pharmax-sidebar-collapsed";

function bestMatchHref(pathname: string, hrefs: ReadonlyArray<string>): string | null {
  let best: string | null = null;
  for (const href of hrefs) {
    const match =
      href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/");
    if (match && (best === null || href.length > best.length)) best = href;
  }
  return best;
}

export function SidebarNav({ groups }: { readonly groups: ReadonlyArray<NavGroup> }) {
  const pathname = usePathname() ?? "/";
  const { buckets, live } = useLiveQueueCounts();
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(STORAGE_KEY) === "1");
    } catch {
      /* ignore */
    }
  }, []);

  function toggle() {
    setCollapsed((c) => {
      const next = !c;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  const allHrefs = groups.flatMap((g) => g.items.map((i) => i.href));
  const active = bestMatchHref(pathname, allHrefs);

  return (
    <aside
      className={cx(
        "sticky top-0 hidden h-screen shrink-0 flex-col border-r border-line bg-surface/60 backdrop-blur-sm transition-[width] duration-200 sm:flex",
        collapsed ? "w-16" : "w-64"
      )}
    >
      <div
        className={cx("flex h-14 items-center gap-2.5 px-4", collapsed && "justify-center px-0")}
      >
        {collapsed ? <BrandMark className="h-8 w-8" /> : <BrandWordmark className="h-6" />}
      </div>

      <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-3">
        {groups.map((group) => (
          <div key={group.label} className="space-y-1">
            {!collapsed ? (
              <p className="px-2 pb-1 text-3xs font-semibold uppercase tracking-caps text-subtle">
                {group.label}
              </p>
            ) : (
              <div className="mx-auto my-2 h-px w-6 bg-line" />
            )}
            {group.items.map((item) => {
              const isActive = active === item.href;
              // Live badge: once the stream delivers, the SSE sum
              // supersedes the SSR-computed seed.
              const count =
                live && item.countCodes !== undefined
                  ? (sumLiveCounts(buckets, item.countCodes) ?? item.count)
                  : item.count;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  title={collapsed ? item.label : undefined}
                  aria-current={isActive ? "page" : undefined}
                  className={cx(
                    "group relative flex items-center gap-3 rounded-md px-2.5 py-2 text-sm " +
                      "transition-[background-color,color] duration-150 ease-(--ease-out)",
                    collapsed && "justify-center px-0",
                    isActive
                      ? "bg-brand/12 font-medium text-fg shadow-(--shadow-edge)"
                      : "text-muted hover:bg-surface-2 hover:text-fg"
                  )}
                >
                  {isActive ? (
                    <span className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-gradient-to-b from-iris-400 to-iris-600" />
                  ) : null}
                  <Icon
                    name={item.icon}
                    size={18}
                    className={cx(
                      "transition-transform duration-150 ease-(--ease-out) group-hover:scale-110",
                      isActive ? "text-brand" : "text-subtle group-hover:text-fg"
                    )}
                  />
                  {!collapsed ? <span className="flex-1 truncate">{item.label}</span> : null}
                  {count !== undefined && count !== null && count > 0 ? (
                    <span
                      className={cx(
                        "tabular-nums",
                        collapsed
                          ? "absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-brand"
                          : isActive
                            ? "inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-brand/30 bg-brand/15 px-1.5 text-2xs font-semibold text-tone-brand"
                            : "inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-line bg-surface-2 px-1.5 text-2xs font-semibold text-muted"
                      )}
                    >
                      {!collapsed ? (count > 99 ? "99+" : count) : null}
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <button
        type="button"
        onClick={toggle}
        className="flex h-11 items-center gap-2 border-t border-line px-4 text-xs text-subtle transition-colors hover:bg-surface-2 hover:text-fg"
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        <Icon name={collapsed ? "chevronRight" : "chevronLeft"} size={16} />
        {!collapsed ? <span>Collapse</span> : null}
      </button>
    </aside>
  );
}
