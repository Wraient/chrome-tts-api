# AGENTS.md — operating chrome-tts-api

> Read this if you are an AI agent tasked with turning text into speech.
> You do not need to understand the engine internals. Just boot the server
> and call it. (Internals live in [RESEARCH.md](RESEARCH.md).)

## What this is

A local HTTP API that speaks any text in Chrome's Read Aloud voices
(`Google US English 1 (Natural)`, … — 217 voices, 33 locales).
No API key, no cloud, no cost. Audio never leaves the machine.

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
| `format` | `wav` | `wav` (24 kHz mono s16) \| `mp3` \| `json` |

`format: json` returns
`{audio_base64, mime, sample_rate, duration_ms, voice, rate, pitch,
words: [{word, start_ms, end_ms, char_index, length}]}` —
everything a read-along-highlighting UI needs.

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
