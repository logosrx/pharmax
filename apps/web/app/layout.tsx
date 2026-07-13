// Root layout.
//
// Authentication is the in-house engine (ADR-0030) — no client-side
// identity provider wraps the tree. Session state is server-resolved
// per request via `resolveOperatorTenancyContext`; the sign-in surface
// posts to `/api/auth/sign-in`.

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
      <body className="antialiased">{children}</body>
    </html>
  );
}
