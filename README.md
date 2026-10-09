# chrome-tts-api

## What it is

A local HTTP API over the exact TTS engine behind Chrome's
**Reading Mode → Read Aloud** ("Listen to this page") natural voices
(`Google US English 1 (Natural)`, …). No API key, no cloud TTS bill, no
screen-scraping: the engine is a **23 MB on-device WASM synthesizer**
(`bindings_main.wasm`) plus downloadable **voice packs** (`.zvoice` zips,
public URLs, sha256-pinned). The server re-hosts Google's own engine files
in a headless-Chrome harness page, captures the 24 kHz PCM the engine
produces, and serves it as WAV/MP3 with word-level timings.

Why this design: desktop Chrome synthesizes fully on-device
(`chrome/browser/component_updater/wasm_tts_engine_component_installer.cc`
→ component extension `bjbcblmdcnggnibecjikpoljcgkbgphl` → offscreen
document → `GoogleTts*` wasm calls). There is no per-utterance network API
to call, so driving the real engine is the only way to get the real voices.
The harness reuses Google's `offscreen_compiled.js` **verbatim** with two
shims (fake `chrome.runtime` bus, fake `AudioWorkletNode` that records PCM
instead of playing it), so voice quality and text normalization are
bit-for-bit what Chrome ships.

## File map

| Path | What |
|---|---|
| `server.mjs` | HTTP API + static host + headless-Chrome launcher + CDP driver. Zero deps (Node ≥22). |
| `harness/tts.html` | Harness page (script order matters; must be served cross-origin isolated). |
| `harness/shim-pre.js` | Ours. `chrome.runtime` + `AudioWorkletNode` fakes (PCM capture). |
| `harness/shim-post.js` | Ours. Wraps wasm exports to scrape word timepoints + completion. |
| `harness/api.js` | Ours. `__ttsReady/__ttsInstall/__ttsSpeak` driver API used over CDP. |
| `harness/bindings_main.{js,wasm}` | Google's engine (copied from Chrome profile, see Rebuild). |
| `harness/offscreen_compiled.js` | Google's engine driver (copied, unmodified). |
| `harness/streaming_worklet_processor.js` | Google's worklet (loaded but unused; must 200). |
| `voices.upstream.json` | Pack catalog (66 packs, 217 speakers) copied from the engine. |
| `voices/*.zvoice` | Downloaded voice packs (gitignored). |
| `tools/download-voices.mjs` | Pack downloader with sha256 verify. |
| `.chrome-profile/` | Harness Chrome profile; persists installed voices (IDBFS). |
| `sample.wav` | Demo output (`Google US English 1 (Natural)`). |
| `AGENTS.md` | Operator manual for AI agents: boot, synthesize, voices, troubleshooting. |
| `RESEARCH.md` | Full reverse-engineering notes (all platforms, protocols, formats). |

## Patches / deviations from upstream

- **None to engine files.** `bindings_main.*`, `offscreen_compiled.js`,
  `streaming_worklet_processor.js` are byte-identical to what Chrome's
  component updater installed (v20260917.1, engine v13.2).
- `voices.json` served to the harness is `voices.upstream.json` with only
  `url` rewritten to local `/voices/*.zvoice` (checksums/sizes untouched,
  so engine-side validation still passes).
- If Chrome updates the engine, re-copy the files (see Rebuild) — the
  shims depend on internal names (`loadWasmTtsBindings`,
  `_GoogleTts{Init,InitBuffered,ReadBuffered,FinalizeBuffered}`,
  `_GoogleTtsGetTimepoints*`, offscreen message types).

## Service management

No systemd unit (interactive dev server). One instance per port:

```bash
cd ~/chrome-tts-api
node server.mjs 3733            # foreground; Ctrl-C stops server+chrome
node server.mjs                 # default port 3733 / $PORT
```

The server spawns and owns its headless Chrome; killing node orphans nothing
(SIGINT/SIGTERM also kill Chrome). Only one server per `.chrome-profile`
at a time (Chrome profile lock).

## Endpoints / interfaces

Base `http://127.0.0.1:3733` (localhost only).

| Endpoint | Use |
|---|---|
| `GET /health` | `{ok, ready, installedLangs, voices}` |
| `GET /voices[?lang=en-us]` | 217-entry catalog: `{name, lang, gender, speaker, pack}` |
| `POST /tts` | `{text, voice?, rate?, pitch?, volume?, format?}` → audio |
| `POST /debug` | Dev only: `{js, await?}` → CDP eval result in harness page |

`/tts` params: `voice` = full name from `/voices` (default
`Google US English 1 (Natural)`); `rate` 0.1–10 (default 1);
`pitch` 0.25–2 (default 1); `volume` 0–1 (default 1, applied in post).
`format`: `wav` (default, 24 kHz mono s16) → `audio/wav` bytes;
`mp3` → `audio/mpeg` via ffmpeg; `json` → see below.

`format: json` returns
`{audio_base64 (wav), mime, sample_rate, duration_ms, voice, rate, pitch,
words: [{word, start_ms, end_ms, char_index, length}]}`.
Long texts are sentence-chunked (~1200 chars) and concatenated with
offset-corrected timings; synthesis runs ~6× realtime.

```bash
curl -X POST localhost:3733/tts -H 'Content-Type: application/json' \
  -d '{"text":"Hello world","voice":"Google US English 2 (Natural)"}' -o out.wav
```

## Wired clients

None yet — any HTTP client works. Planned: a small web UI for paste-and-listen.

## Troubleshooting

1. **Boot hangs / `ready:false`** — Chrome failed to start (missing
   `google-chrome-stable`? profile lock from a zombie?).
   `pkill -f chrome-tts-api/.chrome-profile`, check `/tmp/chrome-tts-api.log`.
2. **`crossOriginIsolated=false`** — the wasm build uses pthreads and refuses
   to init without COOP/COEP. The server sets both on every static response;
   a proxy stripping headers breaks this. Verify via
   `POST /debug {"js":"self.crossOriginIsolated"}`.
3. **`voice install failed: timeout`** — harness page couldn't fetch the pack
   (is the `.zvoice` in `voices/`? run `tools/download-voices.mjs <lang>`),
   or engine internals changed after a Chrome update (re-copy engine files).
4. **Empty/silent audio** — usually a failed install; inspect
   `POST /debug {"js":"JSON.stringify(window.__err)"}` and
   `... {"js":"window.__tts.module.FS.readdir('/voices')"}`.
5. **`ffmpeg` mp3 errors** — needs `libmp3lame` in ffmpeg; `wav` always works.
6. **Port in use** — `node server.mjs <other-port>` (harness URLs are
   port-relative; no other config needed).
7. **Stale/broken voice cache** — `rm -rf .chrome-profile` (voices re-install
   from local `voices/` on next request).

## Rebuild / reinstall steps

```bash
# 1. Fresh engine files from an installed Chrome that opened Reading Mode once:
SRC=~/.config/google-chrome/WasmTtsEngine/*/   # highest version dir
cp $SRC/bindings_main.js $SRC/bindings_main.wasm $SRC/offscreen_compiled.js \
   $SRC/streaming_worklet_processor.js ~/chrome-tts-api/harness/
cp $SRC/voices.json ~/chrome-tts-api/voices.upstream.json
# 2. Voice packs for the languages you want (en-us ≈ 19 MB, all ≈ 486 MB):
cd ~/chrome-tts-api && node tools/download-voices.mjs en-us
#    (or: node tools/download-voices.mjs --all)
# 3. Drop the old voice cache and boot:
rm -rf .chrome-profile && node server.mjs 3733
```

Requires: Node ≥22 (native `WebSocket`/`fetch`), `google-chrome-stable`,
`ffmpeg` (mp3 only). No `npm install` (zero dependencies).
Full platform/hardware/runtime requirements: [AGENTS.md](AGENTS.md) §0.

## Smoke test

```bash
curl -s localhost:3733/health
# {"ok":true,"ready":true,"installedLangs":["en-us"],"voices":217}
curl -s -X POST localhost:3733/tts -H 'Content-Type: application/json' \
  -d '{"text":"The quick brown fox.","format":"json"}' | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print(d['sample_rate'], d['duration_ms'], len(d['words']))"
# 24000 1596 4
```

Verified 2026-10-09 on Chrome 154.0.8037.97: 1739-char article →
97.4 s audio in 16.9 s wall (~5.7× realtime), 322 timestamped words;
WAV levels healthy (peak 22079, RMS 3379); MP3 transcode OK.

## Appendix: how "Listen to this page" actually works (all platforms)

| Platform / path | Synthesis | Endpoint / mechanism | Auth |
|---|---|---|---|
| Desktop Reading Mode Read Aloud (this project) | On-device WASM + `.zvoice` packs | `redirector.gvt1.com/edgedl/android/tts/v26/…` (pack downloads only) | None (public edge cache, sha256-pinned) |
| ChromeOS Select-to-Speak enhanced voices | Server | `POST https://readaloud.googleapis.com//v1:generateAudioDocStream` (`X-Goog-Api-Key`, JSON `{text.text_parts, advanced_options.*, voice_settings.*}` → `[meta, {text.timingInfo}, {audio.bytes b64 mp3}]`) | ChromeOS-only API key (403 without) |
| New native ReadAloudService (gated, Android/desktop future) | Server via Optimization Guide | `POST https://chromemodelexecution-pa.googleapis.com/v1:Execute` (protobuf `ExecuteRequest{MODEL_EXECUTION_FEATURE_READ_ALOUD_SYNTHESIZE, ReadAloudSynthesizeRequest{text_chunk, voice_id, language_code}}`, voices `msf00006`/`msm00013`) | **OAuth required**, scope `https://www.googleapis.com/auth/chrome-model-execution` (403 without; fails when signed out) |
| Android classic "Listen to this page" (2024–) | Server, closed-source DFM (`chrome/android/modules/readaloud/impl` not in Chromium) | Not visible in open source | n/a |

Key source refs (Chromium @ main, Oct 2026): `chrome/browser/readaloud/`
(service + `audio_generation/speech_synthesis_broker.*`),
`chrome/browser/resources/side_panel/read_anything/` (UI),
`chrome/browser/component_updater/wasm_tts_engine_component_installer.*`,
`components/optimization_guide/core/model_execution/`,
`components/optimization_guide/proto/features/read_aloud_synthesize.proto`,
`chromeos/ash/components/enhanced_network_tts/`.
