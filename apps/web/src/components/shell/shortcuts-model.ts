// Pure model for the global keyboard shortcuts — kept free of client
// imports so chord matching, suppression, and permission filtering are
// unit-testable (same split as command-palette-model.ts).

/** Max gap between "g" and the second key of a navigation chord. */
export const CHORD_WINDOW_MS = 800;

/** Custom event the registry fires to focus the topbar order search. */
export const FOCUS_ORDER_SEARCH_EVENT = "pharmax:focus-order-search";

/** A "g then x" navigation chord bound to a permitted nav destination. */
export interface NavChord {
  /** Second key of the chord (the first is always "g"). */
  readonly key: string;
  readonly href: string;
  readonly label: string;
}

/**
 * The full chord vocabulary. A chord only becomes active when its
 * href exists in the permission-filtered nav the layout computed —
 * see buildNavChords — so unauthorized destinations never bind.
 */
export const CHORD_SPECS: ReadonlyArray<{ readonly key: string; readonly href: string }> = [
  { key: "d", href: "/ops" },
  { key: "t", href: "/ops/typing" },
  { key: "v", href: "/ops/pv1" },
  { key: "f", href: "/ops/fill" },
  { key: "n", href: "/ops/final" },
  { key: "s", href: "/ops/shipping" },
  { key: "o", href: "/ops/orders" },
  { key: "r", href: "/ops/reports" },
];

/** The minimal nav shape the model needs (matches shell NavGroup). */
export interface ChordNavGroup {
  readonly items: ReadonlyArray<{ readonly href: string; readonly label: string }>;
}

/**
 * Intersect the chord vocabulary with the permission-filtered nav.
 * Labels come from the nav item so the cheat sheet always shows the
 * same wording as the sidebar.
 */
export function buildNavChords(groups: ReadonlyArray<ChordNavGroup>): ReadonlyArray<NavChord> {
  const labelByHref = new Map<string, string>();
  for (const group of groups) {
    for (const item of group.items) labelByHref.set(item.href, item.label);
  }
  return CHORD_SPECS.flatMap((spec) => {
    const label = labelByHref.get(spec.href);
    return label === undefined ? [] : [{ key: spec.key, href: spec.href, label }];
  });
}

/** Pending chord prefix: "g" was pressed at `at` (ms epoch). */
export interface ChordState {
  readonly pendingAt: number;
}

export interface ChordResult {
  /** Next pending state (null = no chord in flight). */
  readonly state: ChordState | null;
  /** Chord completed by this key, if any. */
  readonly matched: NavChord | null;
  /** True when this keypress participated in a chord (prefix or match). */
  readonly consumed: boolean;
}

/**
 * Advance the chord state machine with one keypress.
 *
 *   - "g" always (re)opens the window, even mid-chord ("g g d" works).
 *   - Inside the window, a bound second key completes the chord.
 *   - Outside the window, or on an unbound key, the pending prefix is
 *     dropped and the key is left for other handlers.
 */
export function advanceChord(
  state: ChordState | null,
  key: string,
  now: number,
  chords: ReadonlyArray<NavChord>
): ChordResult {
  if (key === "g") {
    return { state: { pendingAt: now }, matched: null, consumed: true };
  }
  if (state !== null && now - state.pendingAt <= CHORD_WINDOW_MS) {
    const matched = chords.find((c) => c.key === key) ?? null;
    return { state: null, matched, consumed: matched !== null };
  }
  return { state: null, matched: null, consumed: false };
}

/** What the suppression check needs to know about a keyboard event. */
export interface SuppressionContext {
  /** Uppercase tag name of the event target ("INPUT", "DIV", …). */
  readonly targetTag: string | null;
  readonly targetIsContentEditable: boolean;
  /** True when the palette / cheat sheet / any modal dialog is open. */
  readonly dialogOpen: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
}

const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * True when a global shortcut must NOT fire: focus is in a text-entry
 * control, a modal dialog owns the keyboard (the palette handles its
 * own keys), or a modifier is held (⌘K and friends are not ours).
 * Shift is deliberately allowed — "?" is Shift+/.
 */
export function shouldSuppressShortcut(ctx: SuppressionContext): boolean {
  if (ctx.metaKey || ctx.ctrlKey || ctx.altKey) return true;
  if (ctx.dialogOpen) return true;
  if (ctx.targetIsContentEditable) return true;
  if (ctx.targetTag !== null && EDITABLE_TAGS.has(ctx.targetTag)) return true;
  return false;
}
