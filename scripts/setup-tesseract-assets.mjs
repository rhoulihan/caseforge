// Populate public/tesseract/ with the self-hosted tesseract.js assets so in-browser OCR image
// redaction works fully offline (no third-party CDN at runtime). Runs before dev/build (see the
// dev/build npm scripts) and in CI release. Cross-platform (Node, no bash). Idempotent.
//
// Only the SIMD WASM variants are copied (every modern browser has WASM SIMD) to keep the footprint
// near ~8 MB. If the English data can't be fetched (offline first run), the build still SUCCEEDS —
// image redaction just degrades to "sent un-redacted with a warning" at runtime until the asset exists.

import { mkdirSync, copyFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dest = join(root, 'public', 'tesseract');
mkdirSync(dest, { recursive: true });

const cp = (from, to) => {
  try {
    copyFileSync(from, to);
    return true;
  } catch {
    return false;
  }
};

// 1. Worker
if (!cp(join(root, 'node_modules/tesseract.js/dist/worker.min.js'), join(dest, 'worker.min.js')))
  console.warn('WARN: tesseract.js worker not found — run `pnpm install`.');

// 2. WASM core — SIMD variants + the loader entry only (modern browsers all support WASM SIMD).
const coreDir = join(root, 'node_modules/tesseract.js-core');
if (existsSync(coreDir)) {
  for (const f of readdirSync(coreDir)) {
    // SIMD loader (.js) + binary (.wasm) only — skip the big *.wasm.js single-file fallbacks
    // (the standard path loads the .js loader which fetches the .wasm). Keeps the footprint ~8 MB.
    const want = (f.includes('simd') || f === 'index.js') && (f.endsWith('.wasm') || f.endsWith('.js')) && !f.endsWith('.wasm.js');
    if (want) cp(join(coreDir, f), join(dest, f));
  }
} else {
  console.warn('WARN: tesseract.js-core not found — run `pnpm install`.');
}

// 3. English (fast) traineddata — fetched once, then cached locally (kept out of git).
const td = join(dest, 'eng.traineddata.gz');
if (!existsSync(td)) {
  const urls = [
    'https://cdn.jsdelivr.net/gh/naptha/tessdata@gh-pages/4.0.0_fast/eng.traineddata.gz',
    'https://github.com/naptha/tessdata/raw/gh-pages/4.0.0_fast/eng.traineddata.gz',
  ];
  let ok = false;
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        writeFileSync(td, Buffer.from(await res.arrayBuffer()));
        ok = true;
        break;
      }
    } catch {
      /* try next */
    }
  }
  if (!ok) console.warn('WARN: could not fetch eng.traineddata.gz — OCR redaction unavailable until this asset is present.');
}

console.log('tesseract assets in public/tesseract/:', readdirSync(dest).join(', '));
