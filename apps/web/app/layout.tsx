import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Inter, JetBrains_Mono } from "next/font/google";
import { cookies } from "next/headers";

import { THEME_COOKIE_NAME } from "../src/lib/theme.js";

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

// First-paint theme, no flash (see src/lib/theme.ts for the model):
// the server already applied the `pharmax_theme` cookie below; this
// head script covers what the server cannot — resolving "system"
// against prefers-color-scheme, and the legacy localStorage choice on
// devices that predate the cookie.
const THEME_BOOTSTRAP = `(function(){try{var m=document.cookie.match(/(?:^|; )pharmax_theme=(dark|light|system)/);var t=m?m[1]:localStorage.getItem("pharmax-theme");var l=t==="light"||(t==="system"&&window.matchMedia("(prefers-color-scheme: light)").matches);document.documentElement.classList.toggle("light",l)}catch(e){}})();`;

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const store = await cookies();
  const cookieTheme = store.get(THEME_COOKIE_NAME)?.value;

  return (
    <html
      lang="en"
      className={[inter.variable, jetbrainsMono.variable, cookieTheme === "light" ? "light" : ""]
        .filter(Boolean)
        .join(" ")}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
