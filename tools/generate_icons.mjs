// Renders /icon-192.png and /badge-72.png from inline SVGs. Run once when
// the design changes:
//   npx --yes sharp@0.33 node tools/generate_icons.mjs
// or (with sharp already installed):
//   node tools/generate_icons.mjs
//
// Design: paper-toned square (matches the app's --paper background), thick
// ink border (matches --ink), and a centered "F" in the Fraunces aesthetic.
// The badge variant is monochrome so Android can recolor it.

import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..');

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
await render(badgeSvg, 72, join(outDir, 'badge-72.png'));
