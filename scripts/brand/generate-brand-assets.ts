// Brand asset pipeline — from the SVG masters in `brand/` to the files
// the platform serves.
//
// Masters (committed, exported from the design tool):
//   brand/pharmax-logo.svg        — charcoal wordmark (light surfaces)
//   brand/pharmax-logo-white.svg  — white wordmark (dark surfaces)
//   brand/pharmax-icon.svg        — square two-tone "x" mark
//
// Outputs:
//   apps/web/public/brand/pharmax-wordmark-light.svg  (copy of logo)
//   apps/web/public/brand/pharmax-wordmark-dark.svg   (copy of logo-white)
//   apps/web/public/brand/pharmax-mark.svg            (copy of icon)
//   apps/web/app/icon.png                             (64x64 favicon raster)
//
// The UI serves the SVGs directly (crisp at any DPI); only the favicon
// is rasterized because Safari's SVG-favicon support is unreliable.
//
// Usage: pnpm exec tsx scripts/brand/generate-brand-assets.ts
// Requires `sharp` (present in the workspace store as a transitive dep);
// set SHARP_DIR to its resolved directory if bare resolution fails.

import { copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface SharpModule {
  (
    input: string,
    options?: { density?: number }
  ): {
    resize(w: number, h: number, opts?: object): ReturnType<SharpModule>;
    png(): ReturnType<SharpModule>;
    toFile(p: string): Promise<unknown>;
  };
}

const require = createRequire(import.meta.url);
const sharp: SharpModule = (() => {
  try {
    return require("sharp") as SharpModule;
  } catch {
    // pnpm does not hoist transitive deps; fall back to the store path.
    const sharpDir = process.env.SHARP_DIR;
    if (sharpDir === undefined || sharpDir === "") {
      throw new Error("sharp not resolvable; set SHARP_DIR");
    }
    return require(sharpDir) as SharpModule;
  }
})();

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const masters = path.join(repoRoot, "brand");
const brandDir = path.join(repoRoot, "apps", "web", "public", "brand");

copyFileSync(
  path.join(masters, "pharmax-logo.svg"),
  path.join(brandDir, "pharmax-wordmark-light.svg")
);
copyFileSync(
  path.join(masters, "pharmax-logo-white.svg"),
  path.join(brandDir, "pharmax-wordmark-dark.svg")
);
copyFileSync(path.join(masters, "pharmax-icon.svg"), path.join(brandDir, "pharmax-mark.svg"));

await sharp(path.join(masters, "pharmax-icon.svg"), { density: 300 })
  .resize(64, 64, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toFile(path.join(repoRoot, "apps", "web", "app", "icon.png"));

console.log("brand assets written to apps/web/public/brand + apps/web/app/icon.png");
