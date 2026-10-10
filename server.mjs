#!/usr/bin/env node
// chrome-tts-api — local HTTP API over Chrome's real on-device TTS engine.
// Serves the engine harness, drives headless Chrome over CDP, returns audio.
//
//   node server.mjs [port]            # default 3733
//   GET  /voices                      # JSON voice catalog
//   GET  /health                      # { ok, ready, installedLangs }
//   POST /tts  {text, voice?, rate?, pitch?, volume?, format?, pause_*?}
//        format: wav (default) | mp3 | json (audio_base64 + words) | timings
//        pause_sentence/paragraph/heading: ms of silence after a sentence,
//        based on what follows it. Defaults 220/500/700; 0 opts out.
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { splitText, wordsFrom, sentencesFrom, pausePlan, DEFAULT_PAUSES } from './lib/sentences.mjs';

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
    if (url.pathname === '/demo' || url.pathname === '/') {
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      });
      res.end(readFileSync(join(root, 'demo', 'demo.html')));
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

// --- silence -----------------------------------------------------------------
// The engine trims its own trailing silence (harness/api.js) and renders
// gapless, so pauses are inserted here. `pauses` is [{atMs, ms}], ascending.
function insertPauses(i16, sampleRate, pauses) {
  if (!pauses.length) return i16;
  const gapSamples = pauses.map((p) => Math.round((p.ms * sampleRate) / 1000));
  const extra = gapSamples.reduce((a, b) => a + b, 0);
  const out = new Int16Array(i16.length + extra); // zero-filled = silence
  let src = 0, dst = 0;
  for (let i = 0; i < pauses.length; i++) {
    const at = Math.min(i16.length, Math.max(src, Math.round((pauses[i].atMs * sampleRate) / 1000)));
    if (at > src) { out.set(i16.subarray(src, at), dst); dst += at - src; }
    src = at;
    dst += gapSamples[i];
  }
  out.set(i16.subarray(src), dst);
  return out;
}

// Map a pre-pause timestamp to the audio that actually contains it. A pause sits
// exactly at its sentence's end, so it counts for that timestamp too.
function makeRemap(pauses) {
  if (!pauses.length) return (t) => t;
  const at = pauses.map((p) => p.atMs);
  const cum = [0];
  for (const p of pauses) cum.push(cum[cum.length - 1] + p.ms);
  return (t) => {
    let lo = 0, hi = at.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (at[mid] <= t) lo = mid + 1; else hi = mid; }
    return t + cum[lo];
  };
}

// --- synthesis ---------------------------------------------------------------
// splitText / wordsFrom / sentencesFrom live in lib/sentences.mjs (pure, tested).
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

async function synthesize(text, { voice, rate, pitch, volume }, { keepAudio = true, durations = DEFAULT_PAUSES } = {}) {
  const chunks = splitText(text);
  // The exact string we synthesized. Chunk offsets index into this, so it must
  // be the input verbatim — not a reconstruction from the chunk texts.
  const fullText = String(text);
  const results = [];
  let ms = 0;
  const i16parts = [];
  for (const c of chunks) {
    const r = await cdp.evaluate(
      `window.__ttsSpeak(${JSON.stringify(c.text)}, ${JSON.stringify({ voiceName: voice, rate, pitch, volume })})`);
    if (!r || !r.pcm16Base64) throw new Error('empty synthesis result');
    const raw = Buffer.from(r.pcm16Base64, 'base64');
    c.msBase = ms;
    const durMs = (raw.byteLength / 2 / 24000) * 1000;
    if (keepAudio) i16parts.push(new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2));
    results.push({ timepoints: r.timepoints || [], ms: durMs });
    ms += durMs;
  }
  // Alignment-only callers skip this: a 2-hour article is ~700 MB of PCM, and
  // holding both the parts and the joined copy doubles it for nothing.
  let i16 = null;
  if (keepAudio) {
    const total = i16parts.reduce((n, p) => n + p.length, 0);
    i16 = new Int16Array(total);
    let o = 0;
    for (const p of i16parts) { i16.set(p, o); o += p.length; }
  }
  const words = wordsFrom(fullText, chunks, results);
  const sentences = sentencesFrom(fullText, words);
  // Pause sizing comes from the sentences alone, so the timings below and the
  // audio agree on exactly where the gaps are.
  const pauses = pausePlan(sentences, durations);
  const remap = makeRemap(pauses);
  if (i16) {
    i16 = insertPauses(i16, 24000, pauses);
    i16parts.length = 0; // release the per-chunk copies before the caller builds on this
  }
  for (const w of words) { w.start_ms = Math.round(remap(w.start_ms)); w.end_ms = Math.round(remap(w.end_ms)); }
  for (const s of sentences) { s.start_ms = Math.round(remap(s.start_ms)); s.end_ms = Math.round(remap(s.end_ms)); }
  return {
    i16, sampleRate: 24000,
    durationMs: Math.round(remap(Math.round(ms))),
    pauses_ms: pauses.reduce((n, p) => n + p.ms, 0),
    text: fullText, words, sentences,
  };
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
    // Silence after a sentence, by what follows it. Defaults on; pass 0 to opt
    // out of any class and get the engine's original gapless rendering back.
    const num = (v, d) => {
      const n = Number(v);
      return Number.isFinite(n) && v !== undefined && v !== null && v !== '' ? Math.max(0, n) : d;
    };
    const pauses = {
      sentence: num(q.pause_sentence, DEFAULT_PAUSES.sentence),
      paragraph: num(q.pause_paragraph, DEFAULT_PAUSES.paragraph),
      heading: num(q.pause_heading, DEFAULT_PAUSES.heading),
    };
    try {
      const out = await serialized(async () => {
        await ensureLang(lang);
        return synthesize(text, { voice, rate, pitch, volume },
                         { keepAudio: format !== 'timings', durations: pauses });
      });
      const meta = {
        duration_ms: out.durationMs, sample_rate: out.sampleRate,
        // The exact string word/sentence char offsets index into, so clients
        // can render highlights by slicing this instead of reassembling
        // tokens (which would lose original whitespace).
        text: out.text,
        pauses, pauses_ms: out.pauses_ms,
        voice, rate, pitch, words: out.words, sentences: out.sentences,
      };
      if (format === 'timings') {
        // Metadata only, no audio. A long article renders to hundreds of MB of
        // WAV, which base64-inflates further; callers that keep the audio in a
        // file (the usual HF/R2 pipeline) only need the alignment.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(meta));
      } else if (format === 'json') {
        const audio = wavBuffer(out.i16, out.sampleRate);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...meta, audio_base64: audio.toString('base64'), mime: 'audio/wav' }));
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

// Node aborts a request after 5 minutes by default (requestTimeout), which
// every real article blows through — a 145-minute essay renders for ~25
// minutes. Synthesis is deliberately long-running, so the cap is lifted and
// the client owns its own timeout instead.
server.requestTimeout = 0;
server.headersTimeout = 0;

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
