"use client";

// ThemeToggle — quick dark/light flip in the topbar. Applies the theme
// to the document, records it in the cookie + localStorage (first-paint
// stores), and saves it to the account in the background so the choice
// follows the operator to other devices. The three-way control
// (including "system") lives at /ops/account/appearance.

import { useEffect, useState } from "react";

import { applyThemeChoice, persistThemeChoice } from "../../lib/theme-client.js";
import { Icon } from "../ui/icon.js";
import { cx } from "../ui/cx.js";

export function ThemeToggle({ className }: { readonly className?: string }) {
  const [light, setLight] = useState(false);

  useEffect(() => {
    setLight(document.documentElement.classList.contains("light"));
  }, []);

  function toggle() {
    const next = !light;
    setLight(next);
    const choice = next ? "light" : "dark";
    applyThemeChoice(choice);
    // Fire-and-forget: on signed-out surfaces (/preview) this 401s,
    // which is fine — the cookie/localStorage stores still applied.
    void persistThemeChoice(choice);
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
