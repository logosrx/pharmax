"use client";

// Toast — transient command feedback for the operator console.
//
// <ToastProvider> owns one ToastStore (all queue/dedupe/timing logic
// lives in toast-model.ts) and renders the bottom-right stack;
// useToast() is how client components report command outcomes.
//
// Accessibility: success/info render role="status" (polite), error/
// warning render role="alert" (assertive), each toast is its own
// aria-atomic live region, and the dismiss button is labelled.
//
// Error toasts accept a `detail` string — the error code or
// correlation id from the command route — rendered in mono so an
// operator can quote it to support verbatim.

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { cx } from "./cx.js";
import { Icon, type IconName } from "./icon.js";
import { ToastStore, type ToastInput, type ToastItem, type ToastVariant } from "./toast-model.js";

export type ToastOptions = Omit<ToastInput, "variant" | "title">;

export interface ToastApi {
  readonly show: (input: ToastInput) => string;
  readonly success: (title: string, options?: ToastOptions) => string;
  readonly error: (title: string, options?: ToastOptions) => string;
  readonly warning: (title: string, options?: ToastOptions) => string;
  readonly info: (title: string, options?: ToastOptions) => string;
  readonly dismiss: (id: string) => void;
}

const ToastContext = createContext<{ api: ToastApi; store: ToastStore } | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (ctx === null) {
    throw new Error("useToast() requires a <ToastProvider> ancestor (mounted in the ops layout).");
  }
  return ctx.api;
}

/**
 * Null when no provider is mounted — for components that also render
 * on surfaces outside the ops shell (e.g. the theme toggle on
 * /preview) and degrade to silence there.
 */
export function useToastOptional(): ToastApi | null {
  return useContext(ToastContext)?.api ?? null;
}

export function ToastProvider({ children }: { readonly children: ReactNode }) {
  const [store] = useState(() => new ToastStore());
  useEffect(() => () => store.destroy(), [store]);

  const api = useMemo<ToastApi>(() => {
    const withVariant =
      (variant: ToastVariant) =>
      (title: string, options?: ToastOptions): string =>
        store.show({ variant, title, ...options });
    return {
      show: (input) => store.show(input),
      success: withVariant("success"),
      error: withVariant("error"),
      warning: withVariant("warning"),
      info: withVariant("info"),
      dismiss: (id) => store.dismiss(id),
    };
  }, [store]);

  const ctx = useMemo(() => ({ api, store }), [api, store]);

  return (
    <ToastContext.Provider value={ctx}>
      {children}
      <ToastViewport store={store} />
    </ToastContext.Provider>
  );
}

const VARIANT_STYLES: Record<
  ToastVariant,
  { readonly border: string; readonly icon: string; readonly glyph: IconName }
> = {
  success: {
    border: "border-emerald-500/30",
    icon: "text-tone-success-accent",
    glyph: "check",
  },
  error: {
    border: "border-red-500/35",
    icon: "text-tone-danger-accent",
    glyph: "alert",
  },
  warning: {
    border: "border-amber-500/30",
    icon: "text-tone-warning-accent",
    glyph: "alert",
  },
  info: {
    border: "border-sky-500/30",
    icon: "text-tone-info-accent",
    glyph: "info",
  },
};

function ToastViewport({ store }: { readonly store: ToastStore }) {
  const toasts = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  if (toasts.length === 0) return null;

  return (
    <div
      aria-label="Notifications"
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col items-stretch gap-2"
      onMouseEnter={() => store.pause()}
      onMouseLeave={() => store.resume()}
    >
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} onDismiss={() => store.dismiss(toast.id)} />
      ))}
    </div>
  );
}

function ToastCard({
  toast,
  onDismiss,
}: {
  readonly toast: ToastItem;
  readonly onDismiss: () => void;
}) {
  const style = VARIANT_STYLES[toast.variant];
  const assertive = toast.variant === "error" || toast.variant === "warning";

  return (
    <div
      role={assertive ? "alert" : "status"}
      aria-live={assertive ? "assertive" : "polite"}
      aria-atomic="true"
      className={cx(
        // Machined panel: near-opaque surface, hairline top-light
        // inset, lifted ambient shadow — same finish as .card-sheen,
        // one elevation step up so the stack reads above the page.
        "pointer-events-auto flex items-start gap-3 rounded-lg border bg-surface-2/95 p-3.5 backdrop-blur-md",
        "shadow-[inset_0_1px_0_0_rgb(255_255_255/0.05),0_16px_40px_-8px_rgb(0_0_0/0.44),0_6px_16px_-6px_rgb(0_0_0/0.36)]",
        style.border,
        toast.leaving
          ? "translate-y-1 opacity-0 transition-[opacity,transform] duration-150 ease-(--ease-out)"
          : "animate-slide-up"
      )}
    >
      <Icon name={style.glyph} size={17} className={cx("mt-0.5 shrink-0", style.icon)} />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-sm font-medium leading-snug text-fg">{toast.title}</p>
        {toast.description !== null ? (
          <p className="text-xs leading-snug text-muted">{toast.description}</p>
        ) : null}
        {toast.detail !== null ? (
          <p className="break-all font-mono text-2xs text-subtle">{toast.detail}</p>
        ) : null}
      </div>
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={onDismiss}
        className="-m-1 shrink-0 rounded-md p-1 text-subtle transition-colors hover:bg-surface-3 hover:text-fg"
      >
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}
