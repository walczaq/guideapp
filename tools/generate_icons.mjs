// Renders all PWA icons from inline SVGs. Run when the design changes:
//   node tools/generate_icons.mjs
// (sharp must be installed locally: npm install sharp)
//
// Outputs (all at repo root, referenced by manifest.json + sw.js):
//   /icon-192.png         — standard PWA icon, purpose="any"
//   /icon-512.png         — large PWA icon, purpose="any"
//   /icon-maskable-512.png — adaptive icon with safe-zone padding so
//                            Android's mask doesn't crop content
//   /badge-72.png         — monochrome notification badge
//
// Design notes:
//   - Standard icons: cream paper background, thick ink frame, centered
//     italic Fraunces-style "F" with a small red dot (the mark accent).
//   - Maskable icon: same content but padded so it sits inside an 80%
//     center safe zone (Android's adaptive icon can crop to circle,
//     squircle, or rounded-square — content must survive any crop).
//   - Badge: pure mono so Android can recolor for the status bar.

import sharp from 'sharp';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..');

// Standard icon — content can reach close to the edges because it's
// presented as-is, not cropped.
const iconSvg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
  <rect x="0" y="0" width="192" height="192" rx="32" fill="#f4ede0"/>
  <rect x="12" y="12" width="168" height="168" rx="24" fill="none" stroke="#1a1d1a" stroke-width="8"/>
  <text x="96" y="132" text-anchor="middle"
        font-family="Georgia, 'Times New Roman', serif"
        font-style="italic" font-weight="700"
        font-size="128" fill="#1a1d1a">F</text>
  <circle cx="148" cy="50" r="8" fill="#b8331d"/>
</svg>`.trim();

// Maskable icon — content shrunk into the center 80% so Android's
// adaptive icon mask (which can crop to circle / squircle / rounded
// square) doesn't clip the F or the red dot. Background extends to
// the edges so the mask has paper everywhere it cuts.
const maskableSvg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect x="0" y="0" width="512" height="512" fill="#f4ede0"/>
  <rect x="80" y="80" width="352" height="352" rx="48" fill="none" stroke="#1a1d1a" stroke-width="14"/>
  <text x="256" y="338" text-anchor="middle"
        font-family="Georgia, 'Times New Roman', serif"
        font-style="italic" font-weight="700"
        font-size="252" fill="#1a1d1a">F</text>
  <circle cx="358" cy="146" r="14" fill="#b8331d"/>
</svg>`.trim();

const badgeSvg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72">
  <rect x="0" y="0" width="72" height="72" rx="12" fill="#000"/>
  <text x="36" y="50" text-anchor="middle"
        font-family="Georgia, 'Times New Roman', serif"
        font-style="italic" font-weight="700"
        font-size="48" fill="#fff">F</text>
</svg>`.trim();

async function render(svg, size, outPath) {
  await sharp(Buffer.from(svg))
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toFile(outPath);
  console.log('wrote', outPath);
}

await render(iconSvg, 192, join(outDir, 'icon-192.png'));
await render(iconSvg, 512, join(outDir, 'icon-512.png'));
await render(maskableSvg, 512, join(outDir, 'icon-maskable-512.png'));
await render(badgeSvg, 72, join(outDir, 'badge-72.png'));
