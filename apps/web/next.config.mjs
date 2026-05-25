import { withSentryConfig } from "@sentry/nextjs";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Workspace packages publish TypeScript source via `main`/`types`
  // pointing at `src/index.ts`. Next must transpile them.
  transpilePackages: ["@pharmax/crypto", "@pharmax/database", "@pharmax/platform-core"],
  experimental: {
    // Allow consuming workspace packages whose generated client lives
    // outside the standard node_modules tree.
    externalDir: true,
  },
  // Workspace packages publish TS source with NodeNext-style `.js`
  // extension imports (e.g. `export * from "./logger/index.js"`). This
  // is required for Node ESM and our `verbatimModuleSyntax: true`
  // tsconfig — Node will reject extensionless ESM imports, and TS will
  // not let us drop the extension under the bundler resolver.
  //
  // Webpack handles this via `resolve.extensionAlias`. Turbopack does
  // NOT yet have parity (vercel/next.js#82945). Until it does, we run
  // both `next dev` and `next build` on the webpack runtime via the
  // `--webpack` flag in package.json scripts. The webpack config below
  // is what makes `./foo.js` resolve to `./foo.ts` at the bundler
  // boundary.
  webpack(config) {
    config.resolve = config.resolve ?? {};
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"],
      ".jsx": [".tsx", ".jsx"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

// Wrap with Sentry config. This enables:
//   - Source-map upload (requires SENTRY_AUTH_TOKEN at build time)
//   - Tunneling endpoint to bypass ad-blockers
//   - Auto-instrumentation of routes / server actions
//
// All knobs are documented at https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/
// When SENTRY_AUTH_TOKEN is unset (local dev, PR previews without
// org-level secrets), source-map upload is silently skipped — the
// rest of the integration still works.
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  // Suppress Sentry CLI logs in CI unless explicitly enabled.
  silent: !process.env.CI,
  // Don't auto-upload source maps unless we have an auth token.
  // The flag is harmless when the token is set.
  widenClientFileUpload: true,
  // Tunnel browser SDK events through the app to bypass ad-blockers.
  // Keeps the surface area small — Next will generate /monitoring.
  tunnelRoute: "/monitoring",
  // Hide the original source map files from the production bundle.
  hideSourceMaps: true,
  // Auto-disable when no DSN is configured. Prevents "Sentry is set
  // up but doing nothing" warnings during local builds.
  disableLogger: true,
  automaticVercelMonitors: false,
});
