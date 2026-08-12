"use client";

// AppearanceSelector — the three-way theme control (dark / light /
// system) on /ops/account/appearance. Applies the choice to the
// document immediately, then saves it to the account via the
// SetThemePreference command; the saved preference follows the
// operator to every device at sign-in.

import { useState } from "react";

import { applyThemeChoice, persistThemeChoice } from "../../lib/theme-client.js";
import type { ThemeChoice } from "../../lib/theme.js";
import { Icon, type IconName } from "../ui/icon.js";
import { cx } from "../ui/cx.js";

const OPTIONS: ReadonlyArray<{
  readonly value: ThemeChoice;
  readonly label: string;
  readonly description: string;
  readonly icon: IconName;
}> = [
  { value: "dark", label: "Dark", description: "The console's native look.", icon: "moon" },
  { value: "light", label: "Light", description: "For bright environments.", icon: "sun" },
  {
    value: "system",
    label: "System",
    description: "Follow this device's setting.",
    icon: "monitor",
  },
];

type SaveState = "idle" | "saving" | "saved" | "error";

export function AppearanceSelector({ initialTheme }: { readonly initialTheme: ThemeChoice }) {
  const [selected, setSelected] = useState<ThemeChoice>(initialTheme);
  const [saveState, setSaveState] = useState<SaveState>("idle");

  async function select(choice: ThemeChoice) {
    if (choice === selected && saveState !== "error") return;
    setSelected(choice);
    applyThemeChoice(choice);
    setSaveState("saving");
    const ok = await persistThemeChoice(choice);
    setSaveState(ok ? "saved" : "error");
  }

  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label="Console theme" className="grid gap-3 sm:grid-cols-3">
        {OPTIONS.map((option) => {
          const active = option.value === selected;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => void select(option.value)}
              className={cx(
                "flex flex-col items-start gap-1 rounded-lg border p-4 text-left transition-colors",
                active
                  ? "border-brand bg-surface-2"
                  : "border-line bg-surface-1 hover:border-line-strong hover:bg-surface-2"
              )}
            >
              <span className="flex items-center gap-2 text-sm font-semibold text-fg">
                <Icon name={option.icon} size={16} />
                {option.label}
              </span>
              <span className="text-xs text-muted">{option.description}</span>
            </button>
          );
        })}
      </div>
      <p aria-live="polite" className="text-xs text-muted">
        {saveState === "saving" && "Saving…"}
        {saveState === "saved" && "Saved to your account — this theme follows you to every device."}
        {saveState === "error" &&
          "Applied on this device, but saving to your account failed. Try again."}
      </p>
    </div>
  );
}
