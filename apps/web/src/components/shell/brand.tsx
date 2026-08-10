// Brand — the Pharmax logo, theme-aware.
//
// Two SVG wordmark variants live in `public/brand/`: charcoal for light
// surfaces and white for the dark console (the blue "x" mark is
// identical in both). The swap is pure CSS keyed off the `.light` class
// on <html> (see the `.brand-wordmark-*` rules in `app/globals.css`),
// so the correct variant renders on first paint with zero client JS —
// usable from server and client components alike.
//
// The SVG masters are committed in `brand/`;
// `scripts/brand/generate-brand-assets.ts` copies them here and
// rasterizes the favicon. Update the masters and re-run that script
// rather than editing the served copies by hand.

import { cx } from "../ui/cx.js";

/** Full "pharmax" wordmark. Size it via a height class (e.g. `h-6`). */
export function BrandWordmark({ className }: { readonly className?: string }) {
  return (
    <span className={cx("inline-flex shrink-0 items-center", className)}>
      <img
        src="/brand/pharmax-wordmark-dark.svg"
        alt="Pharmax"
        className="brand-wordmark-on-dark h-full w-auto"
      />
      <img
        src="/brand/pharmax-wordmark-light.svg"
        alt="Pharmax"
        className="brand-wordmark-on-light h-full w-auto"
      />
    </span>
  );
}

/** Square "x" mark — collapsed rails, mobile topbars, tight spots. */
export function BrandMark({ className }: { readonly className?: string }) {
  return <img src="/brand/pharmax-mark.svg" alt="Pharmax" className={cx("shrink-0", className)} />;
}
