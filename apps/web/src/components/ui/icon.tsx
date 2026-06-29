// Icon set — in-house, zero-dependency, stroke-based SVGs.
//
// One coherent family (24px grid, 1.6 stroke, round caps/joins,
// currentColor) so every glyph in the console reads as one set
// rather than a grab-bag. Server-rendered, no client JS. Size via
// the `size` prop (px) or override with a className (e.g. h-4 w-4).
//
// Add new glyphs by adding an entry to ICON_PATHS; the union of keys
// becomes `IconName`, so nav/config can reference icons by name with
// full type-safety.

import type { SVGProps } from "react";

import { cx } from "./cx.js";

const ICON_PATHS = {
  dashboard: (
    <>
      <rect x="3" y="3" width="7.5" height="9" rx="1.5" />
      <rect x="13.5" y="3" width="7.5" height="5.5" rx="1.5" />
      <rect x="13.5" y="12" width="7.5" height="9" rx="1.5" />
      <rect x="3" y="15.5" width="7.5" height="5.5" rx="1.5" />
    </>
  ),
  typing: (
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <path d="M6.5 9.5h.01M10 9.5h.01M13.5 9.5h.01M17 9.5h.01M6.5 13h.01M17 13h.01M9.5 13h5" />
    </>
  ),
  verify: (
    <>
      <path d="M9 4h6a1 1 0 0 1 1 1v1h1a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h1V5a1 1 0 0 1 1-1Z" />
      <path d="M9 6h6" />
      <path d="m9.5 14 2 2 3.5-4" />
    </>
  ),
  fill: (
    <>
      <path d="M10 3h4" />
      <path d="M11 3v4.2a2 2 0 0 1-.4 1.2l-4.2 5.9A2 2 0 0 0 8 17.5V19a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-1.5a2 2 0 0 0-.4-1.2l-4.2-5.9a2 2 0 0 1-.4-1.2V3" />
      <path d="M7.5 14h9" />
    </>
  ),
  final: (
    <>
      <path d="m3 12 2.5 2.5L11 9" />
      <path d="m11 12 2.5 2.5L21 7" />
    </>
  ),
  shipping: (
    <>
      <path d="M2.5 6.5h10v8.5h-10z" />
      <path d="M12.5 9.5h4l3 3v2.5h-7z" />
      <circle cx="6" cy="17.5" r="1.6" />
      <circle cx="16" cy="17.5" r="1.6" />
      <path d="M7.6 17.5h6.8M2.5 17.5h1.9" />
    </>
  ),
  dock: (
    <>
      <path d="M3 8.5a2 2 0 0 1 2-2h1.2l1-1.5h5.6l1 1.5H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      <circle cx="12" cy="12.5" r="3.2" />
    </>
  ),
  unmatched: (
    <>
      <path d="M3 5h13a2 2 0 0 1 2 2v6" />
      <path d="M3 5v12a2 2 0 0 0 2 2h9" />
      <path d="m7 14 3-3 2 2" />
      <path d="m3 3 18 18" />
    </>
  ),
  emergency: (
    <>
      <path d="M12 3.5 21 19.5H3Z" />
      <path d="M12 9.5v4" />
      <path d="M12 16.5h.01" />
    </>
  ),
  billing: (
    <>
      <path d="M5 3.5h14v17l-2.5-1.5L14 20.5 12 19l-2 1.5L7.5 19 5 20.5Z" />
      <path d="M8.5 8h7M8.5 12h7M8.5 15.5h4" />
    </>
  ),
  reports: (
    <>
      <path d="M3.5 3.5v15a2 2 0 0 0 2 2h15" />
      <path d="M7.5 16v-3.5M12 16V8M16.5 16v-5.5" />
    </>
  ),
  history: (
    <>
      <path d="M3.5 12a8.5 8.5 0 1 1 2.6 6.1" />
      <path d="M3.5 18.5V14H8" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19.5a5.5 5.5 0 0 1 11 0" />
      <path d="M16 5.2a3.2 3.2 0 0 1 0 5.6" />
      <path d="M17.5 14.4a5.5 5.5 0 0 1 3 5.1" />
    </>
  ),
  patients: (
    <>
      <circle cx="12" cy="7.5" r="3.5" />
      <path d="M5.5 20.5a6.5 6.5 0 0 1 13 0" />
      <path d="M9.5 14.5h.9l.7-1.3.9 2 .7-.7h1.3" />
    </>
  ),
  sites: (
    <>
      <path d="M4 21V6.5l8-3.5 8 3.5V21" />
      <path d="M4 21h16" />
      <path d="M9 21v-4.5h6V21" />
      <path d="M8.5 9.5h.01M12 9.5h.01M15.5 9.5h.01M8.5 13h.01M15.5 13h.01" />
    </>
  ),
  carriers: (
    <>
      <path d="m3.5 7.5 8.5-4 8.5 4-8.5 4Z" />
      <path d="M3.5 7.5v9l8.5 4 8.5-4v-9" />
      <path d="M12 11.5v9" />
    </>
  ),
  schedules: (
    <>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2" />
      <path d="M3.5 9.5h17M8 3v4M16 3v4" />
      <path d="M12 12.5V15l1.8 1" />
    </>
  ),
  notifications: (
    <>
      <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9Z" />
      <path d="M10 19.5a2.2 2.2 0 0 0 4 0" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3 5 6v5.5c0 4.5 3 7.7 7 9 4-1.3 7-4.5 7-9V6Z" />
      <path d="m9 12 2 2 4-4.5" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20.5 20.5-4.6-4.6" />
    </>
  ),
  scan: (
    <>
      <path d="M3.5 8V6a2 2 0 0 1 2-2h2M16.5 4h2a2 2 0 0 1 2 2v2M20.5 16v2a2 2 0 0 1-2 2h-2M7.5 20h-2a2 2 0 0 1-2-2v-2" />
      <path d="M7 8.5v7M9.5 8.5v7M12 8.5v7M14.5 8.5v7M17 8.5v7" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  alert: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 8v4.5M12 15.5h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  check: <path d="m4.5 12.5 5 5 10-11" />,
  x: <path d="m6 6 12 12M18 6 6 18" />,
  plus: <path d="M12 5v14M5 12h14" />,
  chevronRight: <path d="m9 5 7 7-7 7" />,
  chevronLeft: <path d="m15 5-7 7 7 7" />,
  chevronDown: <path d="m5 9 7 7 7-7" />,
  arrowRight: <path d="M4 12h15m-6-7 7 7-7 7" />,
  arrowLeft: <path d="M20 12H5m6 7-7-7 7-7" />,
  externalLink: (
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4 10 14" />
      <path d="M19 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M4.5 4.5l1.4 1.4M18.1 18.1l1.4 1.4M2.5 12h2M19.5 12h2M4.5 19.5l1.4-1.4M18.1 5.9l1.4-1.4" />
    </>
  ),
  moon: <path d="M20 13.5A8 8 0 1 1 10.5 4a6.2 6.2 0 0 0 9.5 9.5Z" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 13.5a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.1a2 2 0 1 1-4 0v-.2a1.7 1.7 0 0 0-2.9-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.1-2.9H1a2 2 0 1 1 0-4h.2a1.7 1.7 0 0 0 1.1-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 2.9 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H23a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.4.9Z" />
    </>
  ),
  pill: (
    <>
      <rect x="3.5" y="8" width="17" height="8" rx="4" transform="rotate(-45 12 12)" />
      <path d="m9 9 6 6" />
    </>
  ),
  package: (
    <>
      <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9Z" />
      <path d="m4 7.5 8 4.5 8-4.5M12 21v-9" />
      <path d="m8 5.2 8 4.6" />
    </>
  ),
  hold: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M10 9.5v5M14 9.5v5" />
    </>
  ),
  logout: (
    <>
      <path d="M14 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8" />
      <path d="M16 8.5 19.5 12 16 15.5M9.5 12h10" />
    </>
  ),
  print: (
    <>
      <path d="M7 9V4h10v5" />
      <path d="M7 18H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2" />
      <rect x="7" y="15" width="10" height="6" rx="1" />
    </>
  ),
} as const;

export type IconName = keyof typeof ICON_PATHS;

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  readonly name: IconName;
  readonly size?: number;
}

export function Icon({ name, size = 18, className, ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cx("shrink-0", className)}
      {...rest}
    >
      {ICON_PATHS[name]}
    </svg>
  );
}
