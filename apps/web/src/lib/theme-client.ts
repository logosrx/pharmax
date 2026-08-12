// Browser-side theme application + persistence. Client components only
// (touches document/window) — the isomorphic constants live in theme.ts.

import { THEME_COOKIE_MAX_AGE_SECONDS, THEME_COOKIE_NAME, type ThemeChoice } from "./theme.js";

const STORAGE_KEY = "pharmax-theme";

/**
 * Apply a theme to the current document and record it in the two
 * client-side stores the first-paint path reads (cookie for the server
 * render, localStorage for signed-out surfaces).
 */
export function applyThemeChoice(choice: ThemeChoice): void {
  const light =
    choice === "light" ||
    (choice === "system" && window.matchMedia("(prefers-color-scheme: light)").matches);
  document.documentElement.classList.toggle("light", light);
  try {
    window.localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    /* private mode — theme just won't persist locally */
  }
  document.cookie = `${THEME_COOKIE_NAME}=${choice}; path=/; max-age=${THEME_COOKIE_MAX_AGE_SECONDS}; samesite=lax`;
}

/**
 * Save the choice to the account (SetThemePreference). Returns whether
 * the save landed; callers that don't care (the quick topbar toggle on
 * signed-out surfaces gets a 401) can ignore the result.
 */
export async function persistThemeChoice(choice: ThemeChoice): Promise<boolean> {
  try {
    const response = await fetch("/api/ops/account/appearance", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({ theme: choice }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
