#!/usr/bin/env node
// Download .zvoice packs from Google's public edge cache with sha256 verify.
// Usage:
//   node tools/download-voices.mjs en-us            # base + seanet packs for en-us
//   node tools/download-voices.mjs en-us en-gb de-de
//   node tools/download-voices.mjs --all             # everything (~486 MB)
//   node tools/download-voices.mjs --list            # show packs + sizes
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const voices = JSON.parse(readFileSync(join(root, 'voices.upstream.json'), 'utf8'));
const outDir = join(root, 'voices');
mkdirSync(outDir, { recursive: true });

const args = process.argv.slice(2);
if (args.includes('--list')) {
  let total = 0;
  for (const p of voices) {
    total += p.compressedSize;
    console.log(`${p.fileId}  ${(p.compressedSize / 1048576).toFixed(1)}MB  ${p.speakers.length} speakers`);
  }
  console.log(`TOTAL ${(total / 1048576).toFixed(1)}MB in ${voices.length} packs`);
  process.exit(0);
}

const wanted = args.includes('--all')
  ? voices
  : voices.filter(p => args.some(a => p.id.toLowerCase().startsWith(a.toLowerCase())));
if (!wanted.length) {
  console.error('No packs match. Try --list or a language prefix like en-us.');
  process.exit(1);
}

let done = 0;
for (const p of wanted) {
  const file = join(outDir, `${p.fileId}.zvoice`);
  if (existsSync(file)) {
    const sum = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (sum === p.sha256Checksum) {
      console.log(`[ok] ${p.fileId} already verified`);
      done++;
      continue;
    }
    console.log(`[stale] ${p.fileId} checksum mismatch, re-downloading`);
  }
  console.log(`[get] ${p.fileId} (${(p.compressedSize / 1048576).toFixed(1)}MB)`);
  const res = await fetch(p.url);
  if (!res.ok || !res.body) throw new Error(`fetch failed: ${res.status} ${p.url}`);
  await pipeline(res.body, createWriteStream(file));
  const sum = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (sum !== p.sha256Checksum) throw new Error(`checksum mismatch for ${p.fileId}`);
  console.log(`[ok] ${p.fileId} verified`);
  done++;
}
console.log(`done: ${done}/${wanted.length} packs in ${outDir}`);
