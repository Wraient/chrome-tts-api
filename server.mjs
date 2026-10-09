#!/usr/bin/env node
// chrome-tts-api — local HTTP API over Chrome's real on-device TTS engine.
// Serves the engine harness, drives headless Chrome over CDP, returns audio.
//
//   node server.mjs [port]            # default 3733
//   GET  /voices                      # JSON voice catalog
//   GET  /health                      # { ok, ready, installedLangs }
//   POST /tts  {text, voice?, rate?, pitch?, volume?, format?}
//        format: wav (default) | mp3 | json (audio_base64 + words)
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const root = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || process.env.PORT || 3733);
const CHROME = process.env.CHROME_BIN || 'google-chrome-stable';
const PROFILE = join(root, '.chrome-profile');
const UPSTREAM = JSON.parse(readFileSync(join(root, 'voices.upstream.json'), 'utf8'));

// --- voice catalog ---------------------------------------------------------
const CATALOG = [];
for (const p of UPSTREAM) {
  const lang = p.id.split('-').slice(0, 2).join('-'); // en-us-x-multi-seanet -> en-us
  for (const s of p.speakers) {
    CATALOG.push({ name: s.name, lang, gender: s.gender, speaker: s.speaker, pack: p.id });
  }
}
const DEFAULT_VOICE = 'Google US English 1 (Natural)';
const langOf = (name) => (CATALOG.find((v) => v.name === name) || {}).lang || null;

// --- static server ---------------------------------------------------------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.zvoice': 'application/octet-stream' };

function handleStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  try {
    // Rewritten voices.json: same packs/checksums, local download URLs.
    if (url.pathname === '/harness/voices.json') {
      const local = UPSTREAM.map((p) => ({
        ...p,
        url: `http://127.0.0.1:${PORT}/voices/${p.fileId}.zvoice`,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(local));
      return true;
    }
    let file;
    if (url.pathname.startsWith('/harness/')) {
      file = join(root, 'harness', url.pathname.slice('/harness/'.length));
    } else if (url.pathname === '/streaming_worklet_processor.js') {
      file = join(root, 'harness', 'streaming_worklet_processor.js');
    } else if (url.pathname.startsWith('/voices/')) {
      file = join(root, 'voices', url.pathname.slice('/voices/'.length));
    } else {
      return false;
    }
    if (!existsSync(file) || !file.startsWith(root)) {
      res.writeHead(404); res.end('not found'); return true;
    }
    // The wasm build uses pthreads: the page must be cross-origin isolated.
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    });
    res.end(readFileSync(file));
    return true;
  } catch (e) {
    res.writeHead(500); res.end(String(e)); return true;
  }
}

// --- CDP -------------------------------------------------------------------
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
      this.ws.addEventListener('message', (ev) => {
        const m = JSON.parse(String(ev.data));
        if (m.id && this.pending.has(m.id)) {
          const { resolve: r, reject: j } = this.pending.get(m.id);
          this.pending.delete(m.id);
          m.error ? j(new Error(m.error.message)) : r(m.result);
        }
      });
    });
  }
  call(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, awaitPromise = true) {
    const r = await this.call('Runtime.evaluate', {
      expression, awaitPromise, returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error('page eval failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result?.value;
  }
  close() { this.ws.close(); }
}

// --- chrome lifecycle ------------------------------------------------------
let cdp = null;
let chromeProc = null;
const installedLangs = new Set();
let ready = false;

async function boot() {
  mkdirSync(PROFILE, { recursive: true });
  const dbgPort = await freePort();
  console.error(`[boot] debug port ${dbgPort}`);
  chromeProc = spawn(CHROME, [
    '--headless=new', '--no-first-run', '--disable-default-apps',
    '--mute-audio', '--autoplay-policy=no-user-gesture-required',
    `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${dbgPort}`,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  chromeProc.stderr.on('data', (d) => {
    const s = String(d);
    if (/error|crash|fail|FATAL|GPU|audio/i.test(s)) console.error('[chrome]', s.slice(0, 500));
  });
  const base = `http://127.0.0.1:${dbgPort}`;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/json/list`);
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  await fetch(`${base}/json/new?http://127.0.0.1:${PORT}/harness/tts.html`, { method: 'PUT' });
  let target;
  for (let i = 0; i < 100; i++) {
    const list = await (await fetch(`${base}/json/list`)).json();
    target = list.find((t) => t.type === 'page' && t.url.includes('/harness/tts.html'));
    if (target) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!target) throw new Error('harness target not found: ' + JSON.stringify(await (await fetch(`${base}/json/list`)).json()));
  cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.connect();
  // Wait for page scripts to define __ttsReady (target exists before load).
  for (let i = 0; i < 100; i++) {
    const t = await cdp.evaluate('typeof window.__ttsReady', false);
    if (t === 'object') break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const isolated = await cdp.evaluate('self.crossOriginIsolated', false);
  console.error(`[boot] crossOriginIsolated=${isolated}`);
  await cdp.evaluate('window.__ttsReady');
  ready = true;
  console.error('[boot] harness ready');
}

// Serialize all synthesis through one page.
let queue = Promise.resolve();
function serialized(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

async function ensureLang(lang) {
  if (installedLangs.has(lang)) return;
  const status = await cdp.evaluate(`window.__ttsInstall(${JSON.stringify(lang)})`);
  if (status !== 'installed') throw new Error(`voice install failed for ${lang}: ${status}`);
  installedLangs.add(lang);
}

// --- synthesis ---------------------------------------------------------------
const MAX_CHUNK = 1200;
function splitText(text) {
  const parts = String(text).split(/(?<=[.!?;:\n])\s+/);
  const chunks = [];
  let cur = '';
  for (const p of parts) {
    if ((cur + ' ' + p).trim().length > MAX_CHUNK && cur) { chunks.push(cur.trim()); cur = p; }
    else cur = cur ? cur + ' ' + p : p;
  }
  if (cur.trim()) chunks.push(cur.trim());
  // map chunk -> char offset in the joined text we actually synthesize
  let off = 0;
  return chunks.map((c) => {
    const o = { text: c, start: off };
    off += c.length + 1;
    return o;
  });
}

function wordsFrom(fullText, chunks, results) {
  const words = [];
  for (let ci = 0; ci < chunks.length; ci++) {
    const { start: charBase, msBase } = chunks[ci];
    const tps = results[ci].timepoints;
    for (let i = 0; i < tps.length; i++) {
      const tp = tps[i];
      const next = tps[i + 1];
      const startMs = msBase + tp.t * 1000;
      words.push({
        word: fullText.substr(charBase + tp.i, tp.l),
        start_ms: Math.round(startMs),
        end_ms: Math.round(next ? msBase + next.t * 1000 : msBase + results[ci].ms),
        char_index: charBase + tp.i,
        length: tp.l,
      });
    }
  }
  // The engine also emits pause/whitespace fragments; API consumers want words.
  return words.filter((w) => w.word.trim().length > 0);
}

function wavBuffer(i16, sampleRate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + i16.byteLength, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(i16.byteLength, 40);
  return Buffer.concat([h, Buffer.from(i16.buffer)]);
}

function mp3Buffer(i16, sampleRate) {
  return new Promise((resolve, reject) => {
    const ff = execFile('ffmpeg', ['-hide_banner', '-loglevel', 'error',
      '-f', 's16le', '-ar', String(sampleRate), '-ac', '1', '-i', 'pipe:0',
      '-codec:a', 'libmp3lame', '-q:a', '4', '-f', 'mp3', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
        err ? reject(err) : resolve(stdout);
      });
    ff.stdin.end(Buffer.from(i16.buffer));
  });
}

async function synthesize(text, { voice, rate, pitch, volume }) {
  const chunks = splitText(text);
  const fullText = chunks.map((c) => c.text).join(' ');
  const results = [];
  let ms = 0;
  const i16parts = [];
  for (const c of chunks) {
    const r = await cdp.evaluate(
      `window.__ttsSpeak(${JSON.stringify(c.text)}, ${JSON.stringify({ voiceName: voice, rate, pitch, volume })})`);
    if (!r || !r.pcm16Base64) throw new Error('empty synthesis result');
    const raw = Buffer.from(r.pcm16Base64, 'base64');
    i16parts.push(new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2));
    c.msBase = ms;
    const durMs = (raw.byteLength / 2 / 24000) * 1000;
    results.push({ timepoints: r.timepoints || [], ms: durMs });
    ms += durMs;
  }
  const total = i16parts.reduce((n, p) => n + p.length, 0);
  const i16 = new Int16Array(total);
  let o = 0;
  for (const p of i16parts) { i16.set(p, o); o += p.length; }
  return { i16, sampleRate: 24000, durationMs: Math.round(ms), words: wordsFrom(fullText, chunks, results) };
}

// --- HTTP API ------------------------------------------------------------------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ready, installedLangs: [...installedLangs], voices: CATALOG.length }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/debug') {
    let body = '';
    for await (const c of req) body += c;
    try {
      const q = JSON.parse(body || '{}');
      const v = await cdp.evaluate(q.js || '1', q.await !== false);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, value: v }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
    }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/voices') {
    const lang = url.searchParams.get('lang');
    const list = lang ? CATALOG.filter((v) => v.lang === lang.toLowerCase()) : CATALOG;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(list));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/tts') {
    let body = '';
    for await (const c of req) { body += c; if (body.length > 200000) break; }
    let q;
    try { q = JSON.parse(body || '{}'); } catch { res.writeHead(400); res.end('bad json'); return; }
    const text = (q.text || '').toString().trim();
    if (!text) { res.writeHead(400); res.end('missing text'); return; }
    const voice = q.voice || DEFAULT_VOICE;
    const lang = langOf(voice);
    if (!lang) { res.writeHead(400); res.end(`unknown voice: ${voice}`); return; }
    const rate = Math.min(10, Math.max(0.1, Number(q.rate ?? 1) || 1));
    const pitch = Math.min(2, Math.max(0.25, Number(q.pitch ?? 1) || 1));
    const volume = Math.min(1, Math.max(0, Number(q.volume ?? 1)));
    const format = (q.format || url.searchParams.get('format') || 'wav').toLowerCase();
    try {
      const out = await serialized(async () => {
        await ensureLang(lang);
        return synthesize(text, { voice, rate, pitch, volume });
      });
      if (format === 'json') {
        const audio = wavBuffer(out.i16, out.sampleRate);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          audio_base64: audio.toString('base64'), mime: 'audio/wav',
          sample_rate: out.sampleRate, duration_ms: out.durationMs,
          voice, rate, pitch, words: out.words,
        }));
      } else if (format === 'mp3') {
        const mp3 = await mp3Buffer(out.i16, out.sampleRate);
        res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
        res.end(mp3);
      } else {
        res.writeHead(200, { 'Content-Type': 'audio/wav' });
        res.end(wavBuffer(out.i16, out.sampleRate));
      }
    } catch (e) {
      console.error('[tts] error:', e.message);
      res.writeHead(500); res.end('synthesis failed: ' + e.message);
    }
    return;
  }
  if (handleStatic(req, res)) return;
  res.writeHead(404); res.end('not found');
});

process.on('SIGINT', () => { chromeProc?.kill(); process.exit(0); });
process.on('SIGTERM', () => { chromeProc?.kill(); process.exit(0); });

server.listen(PORT, '127.0.0.1', async () => {
  console.error(`[api] listening on http://127.0.0.1:${PORT}`);
  try {
    await boot();
  } catch (e) {
    console.error('[boot] FAILED:', e);
    process.exit(1);
  }
});
