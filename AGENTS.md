# AGENTS.md — operating chrome-tts-api

> Read this if you are an AI agent tasked with turning text into speech.
> You do not need to understand the engine internals. Just boot the server
> and call it. (Internals live in [RESEARCH.md](RESEARCH.md).)

## What this is

A local HTTP API that speaks any text in Chrome's Read Aloud voices
(`Google US English 1 (Natural)`, … — 217 voices, 33 locales).
No API key, no cloud, no cost. Audio never leaves the machine.

## 0. System requirements (read before running anywhere)

**Tested platform:** Linux x86_64 (Arch, kernel 6.x), 12 cores, 15 GB RAM.
Expected to work on macOS (Intel/ARM) and Windows/WSL2 with the same
prerequisites — the engine is portable wasm and all flags/paths are
cross-platform — but only Linux is verified. There is no Docker image;
run it directly on the host (it must spawn real Chrome).

**Software (all required unless noted):**

| Requirement | Version | Why | Check |
|---|---|---|---|
| Node.js | ≥22 (24 verified) | Server + CDP driver use global `WebSocket`/`fetch`, stable since 22 | `node --version` |
| Google Chrome | Recent (154 verified) | Headless engine host; needs `headless=new`, CDP, IDBFS, AudioContext | `google-chrome-stable --version` (override path via `CHROME_BIN`) |
| ffmpeg + libmp3lame | any with lame | MP3 output only; WAV needs nothing | `ffmpeg -h encoder=libmp3lame` |
| curl, python3 | any | Optional; used in doc examples only | — |

No `npm install` — zero dependencies. No root, no display server
(headless), no audio hardware (`--mute-audio`; PCM is captured in-page,
not played).

**Hardware:**

| Resource | Need |
|---|---|
| RAM free | ~2 GB for the stack (Chrome ~1.7 GB + node ~230 MB, measured); 4 GB system RAM comfortable |
| CPU | Any x86_64/ARM64; more cores = faster renders (wasm uses pthreads — ~6× realtime on 12 cores, expect ~2–3× on 4 cores) |
| Disk | ~50 MB base (23 MB engine + profile) + ~19 MB per installed language (en-us) up to ~486 MB for all 33 locales; harness profile grows to ~250 MB with caches |

**Runtime environment:**

- Binds `127.0.0.1` only (API port, default 3733 via argv/`$PORT`, plus an
  ephemeral CDP port). Nothing listens on LAN; to expose it, put your own
  reverse proxy/auth in front.
- Needs to spawn a `chrome` subprocess and write to the project dir
  (`.chrome-profile/` voice cache). Honor the Chrome profile lock: one
  server per profile dir at a time.
- Network: only localhost at runtime, **except** (a) one-time voice-pack
  downloads from `redirector.gvt1.com` (public, no auth) and (b) Chrome's
  own background telemetry/update checks (harmless offline). After packs
  are cached, synthesis is fully offline.
- First boot ≈ 30 s (Chrome start + 23 MB wasm compile); first request
  per language +a few seconds (pack install from local `voices/`).

## 1. Boot the server

```bash
cd ~/chrome-tts-api
node server.mjs 3733 >>/tmp/chrome-tts-api.log 2>&1 &
sleep 30; curl -s http://127.0.0.1:3733/health
```

Expect `{"ok":true,"ready":true,...}`. First boot takes ~30 s (headless
Chrome + 23 MB wasm init). One instance per port; one instance per
`.chrome-profile` (Chrome profile lock). To stop:

```bash
P=$(pgrep -f "[s]erver.mjs 3733" | head -1); [ -n "$P" ] && kill $P
pkill -f "[.]chrome-profile"   # the harness Chrome it spawned
```

Requirements: Node ≥22, `google-chrome-stable` on PATH, `ffmpeg`
(mp3 output only). Zero npm dependencies — no install step.

## 2. Pick a voice

```bash
curl -s "http://127.0.0.1:3733/voices?lang=en-us" | python3 -m json.tool
```

Use the exact `name` string in synthesis calls, e.g.
`Google US English 1 (Natural)`. Omit `?lang=` for all 217 voices.

## 3. Synthesize

```bash
curl -s -X POST http://127.0.0.1:3733/tts \
  -H 'Content-Type: application/json' \
  -d '{"text":"Hello world","voice":"Google US English 1 (Natural)"}' \
  -o out.wav
```

| Field | Default | Notes |
|---|---|---|
| `text` | (required) | Any length; server sentence-chunks ~1200 chars and stitches |
| `voice` | `Google US English 1 (Natural)` | Exact `name` from `/voices` |
| `rate` | `1` | 0.1–10 |
| `pitch` | `1` | 0.25–2 |
| `volume` | `1` | 0–1, applied in post |
| `format` | `wav` | `wav` (24 kHz mono s16) \| `mp3` \| `timings` \| `json` |
| `pause_sentence` | `220` | ms of silence after a same-paragraph sentence; `0` opts out |
| `pause_paragraph` | `500` | ms after a sentence a blank line follows |
| `pause_heading` | `700` | ms after a heading |

`format: json` returns
`{audio_base64, mime, sample_rate, duration_ms, voice, rate, pitch, text,
pauses, pauses_ms,
words: [{word, start_ms, end_ms, char_index, length}],
sentences: [{text, start_ms, end_ms, char_index, char_end, break_after}]}` —
everything a read-along-highlighting UI needs.
`format: timings` returns the same thing **without** `audio_base64`/`mime`.

**The engine is gapless.** It trims its own trailing silence, so audio has 0 ms
of pause between everything; punctuation does not add any. Pauses are inserted
into the PCM in `server.mjs`, sized by each sentence's `break_after` tag
(`sentence` / `paragraph` / `heading`). Timestamps are remapped by the same
plan, so timings and audio always agree. Defaults are on; pass `0` for any
class to get the original rendering back.

A blank line in `text` is a hard sentence boundary — that is what stops a
heading, which has no terminal punctuation, merging into the next paragraph.

**Build read-aloud UIs from `char_index`, not from `word`.** `text` is the
exact string those offsets index into, so `text.slice(start, end)`
reconstructs the source character-for-character. Re-joining `word` tokens
invents spaces around punctuation (`history . In`), because the engine emits
punctuation both standalone-with-whitespace (`'. '`) and glued (`'Dr.'`).
Sentence spans tile the text: gaps hold whitespace only, list markers attach to
the sentence they introduce. During playback, binary-search `words`/`sentences`
on `start_ms` each frame, and hold a reference to the highlighted element —
clearing by index leaves stale highlights after a seek.

## 3a. PDFs

```bash
python3 tools/pdf-to-text.py FILE_OR_URL -o out.txt --report
python3 tools/pdf-to-text.py card.pdf --pages 8-20 -o chapter.txt   # one chapter
```

Then POST the result to `/tts` normally — no engine change is needed. A line
break costs 0 ms versus a space, so the engine reads PDF text fine; the work is
in extraction, because page numbers, hyphenated line breaks, `●` markers and
zero-width spaces all survive into speech. The cleaner reflows paragraphs
(needs `pdftotext -layout`), drops the TOC and running headers, and keeps
section headings. Tables in slide-style PDFs are images — only captions are
readable, and OCR is not wired up.

Check any extractor output before shipping it to a player:
`python3 tools/verify-article.py out.txt` (want `PROBLEMS: 0`).

**Long texts take a long time — plan the client around it.** ~6× realtime
means a 20k-word article is ~145 min of audio and ~25 min of wall time. The
server lifts Node's default 5-minute `requestTimeout`, so the *client* must set
its own (curl: `--max-time 3600`; Python: `urlopen(..., timeout=7200)`).
Prefer `format: "timings"` when the audio goes to a file — a long article
renders to hundreds of MB of WAV that would otherwise be base64'd through RAM.

Ready-made reference client: `curl -s localhost:3733/demo` (paste text,
**Synthesize & play**, spoken sentence + word highlight in place).
Alignment logic is pure and separately tested: `node tools/test-sentences.mjs`.

## 4. Performance rules of thumb

- ~6× realtime: 10 min of audio takes ~100 s to render.
- First request for a language installs its voice pack (local files,
  a few seconds); later requests reuse the on-disk cache.
- One synthesis at a time per server; concurrent requests queue.
- RAM: ~2 GB total (headless Chrome ~1.7 GB + node ~230 MB).

## 5. Adding a language

```bash
node tools/download-voices.mjs <prefix>   # e.g. en-gb, de-de, ja-jp
node tools/download-voices.mjs --list     # all 66 packs + sizes
node tools/download-voices.mjs --all      # everything (~486 MB)
```

Downloads verify against sha256 pins automatically. Then just call
`/tts` with a voice of that language — install happens on first use.

## 6. If something breaks

- `GET /health` shows `ready` and `installedLangs` — check this first.
- `POST /debug` with `{"js":"..."}` evaluates JS in the engine page.
  Useful probes: `self.crossOriginIsolated` (must be `true`),
  `JSON.stringify(window.__err)`,
  `window.__tts.module.FS.readdir('/voices')`.
- `rm -rf .chrome-profile` wipes the voice cache (reinstalls from
  local `voices/` on next request).
- Full failure-mode list: [README.md](README.md) § Troubleshooting.
- Do NOT "fix" synthesis by pointing the engine at Google Cloud TTS —
  different product, different voices. This engine is on-device.
