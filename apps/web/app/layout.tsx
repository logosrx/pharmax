// Root layout.
//
// `<ClerkProvider>` MUST be inside `<body>` per the Clerk
// Next.js Core 3 contract (Core 2 allowed wrapping `<html>`;
// the @clerk/nextjs version pinned in package.json is Core 3+).
//
// When `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is unset (dev clones
// without Clerk credentials), Clerk's Keyless mode auto-generates
// dev keys on first SDK init; we render the provider unconditionally
// so the operator console pages don't need to fork their auth
// strategy based on env shape.

import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "Pharmax",
  description: "Enterprise pharmacy operating system",
};

// Applied before paint so a saved light/dark choice never flashes.
// Defaults to dark (the console's primary mode) when nothing is saved.
const THEME_BOOTSTRAP = `(function(){try{var t=localStorage.getItem("pharmax-theme");if(t==="light"){document.documentElement.classList.add("light")}}catch(e){}})();`;

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className="antialiased">
        <ClerkProvider dynamic>{children}</ClerkProvider>
      </body>
    </html>
  );
}
