"use client";

// AccountNav — the tab strip shared by the self-service /ops/account/*
// pages (security, appearance).

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cx } from "../ui/cx.js";

const LINKS = [
  { href: "/ops/account/security", label: "Security" },
  { href: "/ops/account/appearance", label: "Appearance" },
] as const;

export function AccountNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Account settings" className="flex gap-1 border-b border-line">
      {LINKS.map((link) => {
        const active = pathname === link.href;
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={cx(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "border-brand text-fg"
                : "border-transparent text-muted hover:border-line-strong hover:text-fg"
            )}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
