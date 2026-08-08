// Brand — the Pharmax logo, theme-aware.
//
// Two prerendered PNG variants live in `public/brand/`: the original
// charcoal wordmark for light surfaces and a light-gray recolor for the
// dark console (the blue "x" mark is identical in both). The swap is
// pure CSS keyed off the `.light` class on <html> (see the
// `.brand-wordmark-*` rules in `app/globals.css`), so the correct
// variant renders on first paint with zero client JS — usable from
// server and client components alike.
//
// Assets are generated from the master logo by
// `scripts/brand/generate-brand-assets.mjs`; edit the source PNG and
// re-run that script rather than editing the variants by hand.

import { cx } from "../ui/cx.js";

/** Full "pharmax" wordmark. Size it via a height class (e.g. `h-6`). */
export function BrandWordmark({ className }: { readonly className?: string }) {
  return (
    <span className={cx("inline-flex shrink-0 items-center", className)}>
      <img
        src="/brand/pharmax-wordmark-dark.png"
        alt="Pharmax"
        className="brand-wordmark-on-dark h-full w-auto"
      />
      <img
        src="/brand/pharmax-wordmark-light.png"
        alt="Pharmax"
        className="brand-wordmark-on-light h-full w-auto"
      />
    </span>
  );
}

/** Square "x" mark — collapsed rails, mobile topbars, tight spots. */
export function BrandMark({ className }: { readonly className?: string }) {
  return <img src="/brand/pharmax-mark.png" alt="Pharmax" className={cx("shrink-0", className)} />;
}
