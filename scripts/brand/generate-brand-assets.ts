// One-off generator for the Pharmax brand assets under apps/web/public/brand.
//
// Input: the original wordmark PNG (dark charcoal "pharma" + two-tone "x"
// on a solid background, no alpha). Outputs:
//   - pharmax-wordmark-light.png  — transparent bg, original dark text
//     (for light surfaces: light mode console, README on github-light, emails)
//   - pharmax-wordmark-dark.png   — transparent bg, text recolored to a
//     light gray so it reads on the dark console; the blue "x" is kept as-is
//   - pharmax-mark.png            — square crop of the "x" mark, transparent
//     bg (favicon / app icon source)
//   - apps/web/app/icon.png       — 64x64 app-router favicon from the mark
//
// Usage: pnpm exec tsx scripts/brand/generate-brand-assets.ts <source.png>
// Requires `sharp` (present in the workspace store as a transitive dep);
// set SHARP_DIR to its resolved directory if bare resolution fails.

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface SharpModule {
  (
    input?: string | Buffer | { raw?: object; create?: object },
    options?: object
  ): {
    ensureAlpha(): ReturnType<SharpModule>;
    raw(): ReturnType<SharpModule>;
    extract(region: {
      left: number;
      top: number;
      width: number;
      height: number;
    }): ReturnType<SharpModule>;
    resize(w: number, h: number, opts?: object): ReturnType<SharpModule>;
    composite(items: Array<{ input: Buffer; left: number; top: number }>): ReturnType<SharpModule>;
    png(): ReturnType<SharpModule>;
    toBuffer(opts?: {
      resolveWithObject: true;
    }): Promise<{ data: Buffer; info: { width: number; height: number; channels: number } }>;
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

const src = process.argv[2];
if (src === undefined) {
  console.error("usage: tsx generate-brand-assets.ts <source.png>");
  process.exit(1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const brandDir = path.join(repoRoot, "apps", "web", "public", "brand");

const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width, height, channels } = info;

// Sample the background color from the top-left corner (solid, no alpha
// in the source).
const bgR = data[0]!;
const bgG = data[1]!;
const bgB = data[2]!;

const isBackground = (r: number, g: number, b: number): boolean =>
  Math.abs(r - bgR) + Math.abs(g - bgG) + Math.abs(b - bgB) < 30;

// The wordmark letters are a near-neutral charcoal; the "x" mark is blue.
// Neutral = low saturation (max-min channel spread small).
const isNeutralInk = (r: number, g: number, b: number): boolean =>
  Math.max(r, g, b) - Math.min(r, g, b) < 28;

const light = Buffer.alloc(width * height * 4);
const dark = Buffer.alloc(width * height * 4);
let minInkX = width;
let maxInkX = -1;
let minInkY = height;
let maxInkY = -1;
let minBlueX = width;
let maxBlueX = -1;
let minBlueY = height;
let maxBlueY = -1;

for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * channels;
    const o = (y * width + x) * 4;
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    if (isBackground(r, g, b)) {
      // transparent in both variants
      light[o + 3] = 0;
      dark[o + 3] = 0;
      continue;
    }
    minInkX = Math.min(minInkX, x);
    maxInkX = Math.max(maxInkX, x);
    minInkY = Math.min(minInkY, y);
    maxInkY = Math.max(maxInkY, y);
    // light variant: keep original colors
    light[o] = r;
    light[o + 1] = g;
    light[o + 2] = b;
    light[o + 3] = 255;
    if (isNeutralInk(r, g, b)) {
      // dark variant: recolor charcoal letters to a light gray (#E7E9EC),
      // preserving the anti-aliased blend toward the background as alpha.
      const distBg = (Math.abs(r - bgR) + Math.abs(g - bgG) + Math.abs(b - bgB)) / 3;
      const alpha = Math.min(255, Math.round(distBg * 3.2));
      dark[o] = 0xe7;
      dark[o + 1] = 0xe9;
      dark[o + 2] = 0xec;
      dark[o + 3] = alpha;
    } else {
      // the blue "x": keep as-is in both variants
      dark[o] = r;
      dark[o + 1] = g;
      dark[o + 2] = b;
      dark[o + 3] = 255;
      minBlueX = Math.min(minBlueX, x);
      maxBlueX = Math.max(maxBlueX, x);
      minBlueY = Math.min(minBlueY, y);
      maxBlueY = Math.max(maxBlueY, y);
    }
  }
}

const trimLeft = Math.max(0, minInkX - 4);
const trimTop = Math.max(0, minInkY - 4);
const trimRight = Math.min(width - 1, maxInkX + 4);
const trimBottom = Math.min(height - 1, maxInkY + 4);
const trim = {
  left: trimLeft,
  top: trimTop,
  width: trimRight - trimLeft + 1,
  height: trimBottom - trimTop + 1,
};

const rawSpec = { raw: { width, height, channels: 4 } };
await sharp(light, rawSpec)
  .extract(trim)
  .png()
  .toFile(path.join(brandDir, "pharmax-wordmark-light.png"));
await sharp(dark, rawSpec)
  .extract(trim)
  .png()
  .toFile(path.join(brandDir, "pharmax-wordmark-dark.png"));

// Square mark: crop the blue "x" with padding, centered on a square canvas.
const blueW = maxBlueX - minBlueX + 1;
const blueH = maxBlueY - minBlueY + 1;
const side = Math.max(blueW, blueH);
const pad = Math.round(side * 0.14);
const sq = side + pad * 2;
const markCrop = (await sharp(light, rawSpec)
  .extract({ left: minBlueX, top: minBlueY, width: blueW, height: blueH })
  .png()
  .toBuffer()) as unknown as Buffer;
await sharp({
  create: { width: sq, height: sq, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
})
  .composite([
    {
      input: markCrop,
      left: Math.round((sq - blueW) / 2),
      top: Math.round((sq - blueH) / 2),
    },
  ])
  .png()
  .toFile(path.join(brandDir, "pharmax-mark.png"));

await sharp(path.join(brandDir, "pharmax-mark.png"))
  .resize(64, 64, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toFile(path.join(repoRoot, "apps", "web", "app", "icon.png"));

console.log("brand assets written", { trim, mark: { blueW, blueH, sq } });
