// Theme plumbing shared by server and client code.
//
// Source of truth for a signed-in operator is `user.themePreference`
// (saved via the SetThemePreference command). The `pharmax_theme`
// cookie is a render hint mirroring that preference so the server can
// paint the right theme on the very first byte — it is set at sign-in
// and on every preference save, and is deliberately NOT httpOnly so
// the client toggle can keep it in sync without a round trip.
//
// Resolution order at paint time (root layout + bootstrap script):
//   1. `pharmax_theme` cookie ("dark" | "light" | "system")
//   2. legacy localStorage "pharmax-theme" (pre-account-preference)
//   3. default: dark
// "system" resolves against prefers-color-scheme in the browser (the
// server cannot know it, so it renders dark and the head script — which
// runs before first paint — corrects it).

export const THEME_COOKIE_NAME = "pharmax_theme";

/** One year — re-seeded at every sign-in and preference save anyway. */
export const THEME_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export const THEME_CHOICES = ["dark", "light", "system"] as const;

export type ThemeChoice = (typeof THEME_CHOICES)[number];

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return (THEME_CHOICES as ReadonlyArray<unknown>).includes(value);
}

/** Prisma `UserThemePreference` enum value → cookie value. */
export function themeChoiceFromPreference(preference: "DARK" | "LIGHT" | "SYSTEM"): ThemeChoice {
  switch (preference) {
    case "DARK":
      return "dark";
    case "LIGHT":
      return "light";
    case "SYSTEM":
      return "system";
    default: {
      const exhaustive: never = preference;
      throw new Error(`Unhandled theme preference: ${String(exhaustive)}`);
    }
  }
}

/** Cookie value → Prisma `UserThemePreference` enum value. */
export function preferenceFromThemeChoice(choice: ThemeChoice): "DARK" | "LIGHT" | "SYSTEM" {
  switch (choice) {
    case "dark":
      return "DARK";
    case "light":
      return "LIGHT";
    case "system":
      return "SYSTEM";
    default: {
      const exhaustive: never = choice;
      throw new Error(`Unhandled theme choice: ${String(exhaustive)}`);
    }
  }
}
