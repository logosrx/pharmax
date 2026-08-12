// Root layout.
//
// Authentication is the in-house engine (ADR-0030) — no client-side
// identity provider wraps the tree. Session state is server-resolved
// per request via `resolveOperatorTenancyContext`; the sign-in surface
// posts to `/api/auth/sign-in`.

import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Inter, JetBrains_Mono } from "next/font/google";

import "./globals.css";

// Self-hosted at build time by next/font — the CSS token layer
// (`--font-sans` / `--font-mono` in globals.css) references these
// variables first, so the whole console actually renders Inter +
// JetBrains Mono instead of silently falling back to system fonts.
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Pharmax",
  description: "Enterprise pharmacy operating system",
};

// Applied before paint so a saved light/dark choice never flashes.
// Defaults to dark (the console's primary mode) when nothing is saved.
const THEME_BOOTSTRAP = `(function(){try{var t=localStorage.getItem("pharmax-theme");if(t==="light"){document.documentElement.classList.add("light")}}catch(e){}})();`;

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
