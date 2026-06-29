"use client";

// ThemeToggle — flips the `.light` class on <html> and persists the
// choice. The actual first-paint theme is applied by an inline script
// in the root layout (no-flash); this control just toggles + stores.

import { useEffect, useState } from "react";

import { Icon } from "../ui/icon.js";
import { cx } from "../ui/cx.js";

const STORAGE_KEY = "pharmax-theme";

export function ThemeToggle({ className }: { readonly className?: string }) {
  const [light, setLight] = useState(false);

  useEffect(() => {
    setLight(document.documentElement.classList.contains("light"));
  }, []);

  function toggle() {
    const next = !light;
    setLight(next);
    document.documentElement.classList.toggle("light", next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? "light" : "dark");
    } catch {
      /* private mode — theme just won't persist */
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={light ? "Switch to dark theme" : "Switch to light theme"}
      title={light ? "Switch to dark theme" : "Switch to light theme"}
      className={cx(
        "inline-flex h-9 w-9 items-center justify-center rounded-md border border-line-strong " +
          "bg-surface-2 text-muted transition-colors hover:bg-surface-3 hover:text-fg",
        className
      )}
    >
      <Icon name={light ? "moon" : "sun"} size={16} />
    </button>
  );
}
