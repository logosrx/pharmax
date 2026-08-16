"use client";

// ActionForm + SubmitButton — workflow command forms with real
// pending feedback.
//
// The ops command surfaces post natively to `/api/ops/...` routes
// (which run the command and redirect back with a flash). Native
// posts mean `useFormStatus` can't see the in-flight state, so this
// thin client wrapper tracks submission itself: on submit it flips a
// context flag, and every <SubmitButton> inside spins + disables
// until the navigation completes. An optional `confirm` gate guards
// destructive moves.

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import { buttonClass, type ButtonSize, type ButtonVariant } from "../ui/button.js";
import { Icon, type IconName } from "../ui/icon.js";
import { cx } from "../ui/cx.js";

const PendingContext = createContext(false);

export function ActionForm({
  action,
  confirm,
  encType,
  className,
  children,
}: {
  readonly action: string;
  readonly confirm?: string;
  /** Set to "multipart/form-data" for file uploads. */
  readonly encType?: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const [pending, setPending] = useState(false);

  // A back/forward-cache restore resurrects the pre-navigation React
  // state — without this, a form submitted and then returned to via
  // the back button would sit disabled forever.
  useEffect(() => {
    function onPageShow(e: PageTransitionEvent) {
      if (e.persisted) setPending(false);
    }
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    // Belt-and-braces double-submit guard: the submit buttons disable
    // while pending, but Enter in a text control can still resubmit.
    if (pending) {
      e.preventDefault();
      return;
    }
    if (confirm !== undefined && !window.confirm(confirm)) {
      e.preventDefault();
      return;
    }
    setPending(true);
  }

  return (
    <form
      action={action}
      method="POST"
      encType={encType}
      onSubmit={onSubmit}
      aria-busy={pending || undefined}
      className={className}
    >
      <PendingContext.Provider value={pending}>{children}</PendingContext.Provider>
    </form>
  );
}

export function SubmitButton({
  variant = "primary",
  size = "md",
  icon,
  className,
  children,
}: {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly icon?: IconName;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const pending = useContext(PendingContext);
  return (
    <button type="submit" disabled={pending} className={buttonClass({ variant, size, className })}>
      {pending ? (
        <svg
          viewBox="0 0 24 24"
          width={size === "sm" ? 14 : 16}
          height={size === "sm" ? 14 : 16}
          fill="none"
          className={cx("animate-spin", "shrink-0")}
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.4" opacity="0.25" />
          <path
            d="M21 12a9 9 0 0 0-9-9"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
          />
        </svg>
      ) : icon ? (
        <Icon name={icon} size={size === "sm" ? 14 : 16} />
      ) : null}
      {children}
    </button>
  );
}
