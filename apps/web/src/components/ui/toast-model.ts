// Toast model — the framework-free engine behind <ToastProvider>.
//
// All queue/dedupe/timing behaviour lives here, in a plain class with
// a subscribe/getSnapshot surface (shaped for useSyncExternalStore),
// so the logic is unit-testable under the node test environment with
// fake timers — no DOM, no React renderer.
//
// Behaviour contract:
//   - At most MAX_VISIBLE_TOASTS render at once; extras wait in a
//     FIFO queue and are promoted as slots free up.
//   - Showing a toast identical to one already visible/queued (same
//     variant + title + description + detail) does not stack a
//     duplicate — the existing toast's countdown restarts instead.
//     Double-submits and React strict-mode effect replays collapse.
//   - Each toast auto-dismisses after its duration (default ~5s;
//     errors linger longer so operators can copy the detail code).
//     `durationMs: 0` opts out — the toast stays until dismissed.
//   - pause()/resume() (hover over the stack) freeze the remaining
//     countdown of every visible toast; exit animations still run.
//   - Dismissal is two-phase: the toast is first marked `leaving`
//     (the view plays its exit transition), then removed after
//     EXIT_ANIMATION_MS.

export type ToastVariant = "success" | "error" | "warning" | "info";

export interface ToastInput {
  readonly variant: ToastVariant;
  readonly title: string;
  readonly description?: string;
  /**
   * Support-quotable identifier (error code, correlation/request id)
   * rendered in mono. Error toasts surface this so an operator can
   * read it to support verbatim.
   */
  readonly detail?: string;
  /** Auto-dismiss delay. `0` = sticky (manual dismiss only). */
  readonly durationMs?: number;
}

export interface ToastItem {
  readonly id: string;
  readonly variant: ToastVariant;
  readonly title: string;
  readonly description: string | null;
  readonly detail: string | null;
  readonly durationMs: number;
  /** True while the exit animation plays; removal follows. */
  readonly leaving: boolean;
}

export const MAX_VISIBLE_TOASTS = 4;
export const DEFAULT_DURATION_MS = 5_000;
/** Errors linger: the operator may need to copy the detail code. */
export const ERROR_DURATION_MS = 8_000;
export const EXIT_ANIMATION_MS = 160;

export function resolveDurationMs(input: ToastInput): number {
  if (input.durationMs !== undefined) return input.durationMs;
  return input.variant === "error" ? ERROR_DURATION_MS : DEFAULT_DURATION_MS;
}

interface LiveToast {
  item: ToastItem;
  /** Countdown left when (re)armed; meaningful while paused. */
  remainingMs: number;
  /** Epoch ms the current timer was armed at; null while paused/sticky. */
  armedAt: number | null;
  timer: ReturnType<typeof setTimeout> | null;
}

function dedupeKey(t: {
  readonly variant: ToastVariant;
  readonly title: string;
  readonly description: string | null;
  readonly detail: string | null;
}): string {
  return `${t.variant}\u0000${t.title}\u0000${t.description ?? ""}\u0000${t.detail ?? ""}`;
}

export class ToastStore {
  private visible: LiveToast[] = [];
  private queued: ToastItem[] = [];
  private readonly listeners = new Set<() => void>();
  private snapshot: ReadonlyArray<ToastItem> = [];
  private paused = false;
  private seq = 0;
  private readonly exitTimers = new Map<string, ReturnType<typeof setTimeout>>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): ReadonlyArray<ToastItem> => this.snapshot;

  show(input: ToastInput): string {
    const item: ToastItem = {
      id: `toast-${++this.seq}`,
      variant: input.variant,
      title: input.title,
      description: input.description ?? null,
      detail: input.detail ?? null,
      durationMs: resolveDurationMs(input),
      leaving: false,
    };

    // Dedupe against live toasts: restart the countdown instead of
    // stacking an identical card.
    const key = dedupeKey(item);
    const live = this.visible.find((v) => !v.item.leaving && dedupeKey(v.item) === key);
    if (live !== undefined) {
      this.restartCountdown(live);
      return live.item.id;
    }
    const pending = this.queued.find((q) => dedupeKey(q) === key);
    if (pending !== undefined) return pending.id;

    if (this.visible.length >= MAX_VISIBLE_TOASTS) {
      this.queued.push(item);
      return item.id;
    }
    this.mount(item);
    this.publish();
    return item.id;
  }

  dismiss(id: string): void {
    const live = this.visible.find((v) => v.item.id === id);
    if (live === undefined || live.item.leaving) {
      // Not visible — it may still be waiting in the queue.
      this.queued = this.queued.filter((q) => q.id !== id);
      return;
    }
    this.beginExit(live);
    this.publish();
  }

  dismissAll(): void {
    for (const live of [...this.visible]) {
      if (!live.item.leaving) this.beginExit(live);
    }
    this.queued = [];
    this.publish();
  }

  /** Freeze every visible countdown (stack hovered). */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    const now = Date.now();
    for (const live of this.visible) {
      if (live.timer === null) continue;
      clearTimeout(live.timer);
      live.timer = null;
      if (live.armedAt !== null) {
        live.remainingMs = Math.max(0, live.remainingMs - (now - live.armedAt));
        live.armedAt = null;
      }
    }
  }

  /** Resume countdowns with the time each toast had left. */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    for (const live of this.visible) {
      if (!live.item.leaving) this.arm(live);
    }
  }

  /** Clear every timer (provider unmount). */
  destroy(): void {
    for (const live of this.visible) {
      if (live.timer !== null) clearTimeout(live.timer);
    }
    for (const timer of this.exitTimers.values()) clearTimeout(timer);
    this.exitTimers.clear();
    this.visible = [];
    this.queued = [];
    this.publish();
  }

  private mount(item: ToastItem): void {
    const live: LiveToast = { item, remainingMs: item.durationMs, armedAt: null, timer: null };
    this.visible.push(live);
    if (!this.paused) this.arm(live);
  }

  private arm(live: LiveToast): void {
    if (live.item.durationMs === 0 || live.remainingMs <= 0) {
      if (live.item.durationMs !== 0 && live.remainingMs <= 0) {
        this.beginExit(live);
        this.publish();
      }
      return;
    }
    live.armedAt = Date.now();
    live.timer = setTimeout(() => {
      live.timer = null;
      this.beginExit(live);
      this.publish();
    }, live.remainingMs);
  }

  private restartCountdown(live: LiveToast): void {
    if (live.timer !== null) {
      clearTimeout(live.timer);
      live.timer = null;
    }
    live.remainingMs = live.item.durationMs;
    live.armedAt = null;
    if (!this.paused) this.arm(live);
  }

  private beginExit(live: LiveToast): void {
    if (live.timer !== null) {
      clearTimeout(live.timer);
      live.timer = null;
    }
    live.item = { ...live.item, leaving: true };
    const id = live.item.id;
    this.exitTimers.set(
      id,
      setTimeout(() => {
        this.exitTimers.delete(id);
        this.remove(id);
      }, EXIT_ANIMATION_MS)
    );
  }

  private remove(id: string): void {
    this.visible = this.visible.filter((v) => v.item.id !== id);
    // Promote queued toasts into the freed slots.
    while (this.queued.length > 0 && this.visible.length < MAX_VISIBLE_TOASTS) {
      const next = this.queued.shift();
      if (next !== undefined) this.mount(next);
    }
    this.publish();
  }

  private publish(): void {
    this.snapshot = this.visible.map((v) => v.item);
    for (const listener of this.listeners) listener();
  }
}
