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
| `tools/test-sentences.mjs` | Sentence-segmentation + pause regression tests. No deps, no server/Chrome needed. |
| `tools/pdf-to-text.py` | PDF → narration-ready prose (needs `pdftotext`). |
| `tools/verify-article.py` | End-to-end alignment check for a real article against a running server. |
| `lib/sentences.mjs` | Pure alignment: `splitText`, `wordsFrom`, `sentencesFrom`. |
| `demo/demo.html` | Read-along demo (sentence + word highlighting). Served at `GET /demo`. |
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
| `GET /demo` | Read-along demo page (synthesis + sentence/word highlighting). |
| `POST /debug` | Dev only: `{js, await?}` → CDP eval result in harness page |

`/tts` params: `voice` = full name from `/voices` (default
`Google US English 1 (Natural)`); `rate` 0.1–10 (default 1);
`pitch` 0.25–2 (default 1); `volume` 0–1 (default 1, applied in post);
`pause_sentence` 220 / `pause_paragraph` 500 / `pause_heading` 700 (ms, see
Pauses below — pass 0 to opt out).
`format`: `wav` (default, 24 kHz mono s16) → `audio/wav` bytes;
`mp3` → `audio/mpeg` via ffmpeg; `timings` → alignment only, no audio;
`json` → alignment plus `audio_base64` (WAV).

`format: json` returns
`{audio_base64 (wav), mime, sample_rate, duration_ms, voice, rate, pitch,
text, pauses, pauses_ms, words: [...], sentences: [...]}`.
`format: timings` returns the same payload minus `audio_base64`/`mime`.

Long texts are chunked (~1200 chars) and concatenated with offset-corrected
timings; synthesis runs ~6× realtime.

> **Long requests.** Node's `server.requestTimeout` defaults to 5 minutes and
> would abort every real article (a 145-minute essay renders for ~25 minutes),
> so it is set to `0` and the client owns its timeout. Use `format: "timings"`
> when you keep the audio in a file: a long article renders to hundreds of MB
> of WAV, which base64 inflates by a third and buffers in RAM on both ends.
> Callers that need a bounded request should use the async job pattern
> (`POST /jobs` → poll), which is also required behind Cloudflare Workers.

### Pauses (`pause_sentence` / `pause_paragraph` / `pause_heading`)

**The engine reads with no silence at all.** `harness/api.js` trims trailing
zeros from each chunk, so audio is gapless — sentence to sentence, heading to
body. Measured: gaps of exactly 0 ms everywhere, and punctuation does not help
(an ellipsis and an em-dash both still measure 0 ms).

Silence is therefore inserted into the PCM in `server.mjs`, sized by what
follows each sentence. Every sentence carries a `break_after` tag:

| `break_after` | meaning | default |
|---|---|---|
| `sentence` | next sentence continues the same paragraph | `pause_sentence` = 220 ms |
| `paragraph` | a blank line follows | `pause_paragraph` = 500 ms |
| `heading` | this sentence is a heading and a blank line follows | `pause_heading` = 700 ms |

Defaults are **on**. Pass `0` for any of them to opt out and get the engine's
original gapless rendering back. Timestamps are remapped by the same plan that
places the gaps (`new_t = t + Σ pauses before t`), so words, sentences and audio
cannot drift apart — and with `format: "timings"` the remap runs without
rebuilding the audio, keeping long documents memory-flat.

A blank line in `text` is a hard sentence boundary. That is what keeps a
heading like `Executive summary` — which carries no terminal punctuation — from
merging into the paragraph after it.

### Read-along alignment (`text` + `words` + `sentences`)

This is what powers a Chrome-style "listen to this page" UI: highlighting the
sentence (or word) currently being spoken. Chrome's Read Aloud keeps text and
audio in sync via the same word timepoints we scrape from the engine.

```jsonc
{
  "text": "Dr. Smith went to Washington. He arrived!",  // exact string synthesized
  "words": [
    { "word": "Dr.",  "start_ms": 15,  "end_ms": 410,  "char_index": 0,  "length": 3 }
  ],
  "sentences": [
    { "text": "Dr. Smith went to Washington.", "start_ms": 15,   "end_ms": 2100,
      "char_index": 0, "char_end": 28 }
  ]
}
```

**Render from `char_index`, not from `word`.** `text` is the exact string the
offsets index into; slicing it reproduces the source character-for-character.
Re-joining the `word` tokens instead invents spaces around punctuation
(`history . In`), because the engine emits punctuation both as standalone
fragments carrying whitespace (`'. '`) and glued to words (`'Dr.'`).

Sentence spans are contiguous and ordered: joining `text[char_index:char_end]`
with single spaces reconstructs the input, no inter-sentence gap holds real
characters, and nothing real is left before the first or after the last span.
`char_index`/`char_end` also index `words`, so a word belongs to the sentence
whose range contains its start. List markers (`. - `, `. — `) are attached to
the sentence they introduce, never left dangling in a gap.

To highlight during playback, binary-search `words`/`sentences` on `start_ms`
each `requestAnimationFrame` — do **not** clear the previous highlight by index
(`wordEls[wi]`), because seeking resets the index and leaves stale highlights;
hold a reference to the highlighted element instead (see `demo/demo.html`).

Known limits: abbreviations not in the built-in list (`U.S.`, `Ph.D.`) may end a
sentence slightly early, and `Jan. 5th`-style ordinals split after the month.
Both only shift a highlight boundary by a few words.

## PDFs

```bash
python3 tools/pdf-to-text.py FILE_OR_URL -o out.txt --report
python3 tools/pdf-to-text.py card.pdf --pages 8-20 -o chapter.txt
```

Then `POST /tts` as usual — PDF-derived text needs nothing special.

The engine itself does not care where text came from: a hard line break costs
**0 ms** versus a space, and sentences already span line breaks correctly. The
work is in extraction, because a PDF text layer is laid out for sight and four
of its artifacts get *spoken*:

| Artifact | Consequence if passed through as-is |
|---|---|
| Page numbers (last line of every page) | "…on it. **30** The task begins now" — read aloud as "thirty" |
| Hyphenated line breaks (`con-\nntinue`) | word split mid-token, mispronounced |
| List markers (`●`) | marker carried into the sentence text |
| Zero-width spaces (U+200B) | glues to bullets and headings; shifts every char offset |

So `pdf-to-text.py` reflows: NFKC normalization (folds ligatures), zero-width
removal, de-hyphenation, and unwrapping of paragraph lines — using
`pdftotext -layout`, which preserves the vertical gaps that mark paragraphs.
Plain mode emits no blank lines at all (6% blank vs 26%), and without them
nothing downstream can tell a heading from body text.

It also drops the table of contents (pages whose lines are >30% page-number
entries — measured 0.97–1.00 on TOC pages vs 0.02–0.06 on prose; a 10-line
floor stops figure pages with captions being misread as TOC) and running
headers/footers, while keeping section headings.

Two limitations worth knowing:

- **Tables in slide-style PDFs are images.** Only captions like
  `[Table 2.2.1.A]` reach the text layer; the numbers are absent and skipped.
  Recovering them needs OCR, which is not wired up.
- **Requires `pdftotext`** (poppler-utils). In the HF Space image add
  `apt-get install poppler-utils`, or port the cleaner to `pdfplumber`.

Verify any extractor's output before wiring it to a player:

```bash
python3 tools/verify-article.py out.txt   # PROBLEMS: 0 expected
```

```bash
curl -X POST localhost:3733/tts -H 'Content-Type: application/json' \
  -d '{"text":"Hello world","voice":"Google US English 2 (Natural)"}' -o out.wav
```

## Wired clients

None yet — any HTTP client works. The bundled `GET /demo` page is the reference
client for the read-aloud/alignment path.

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
8. **Client drops a long request after ~5 min** — the *client's* timeout, not
   the server's. Raise it (`curl --max-time 3600`) and switch to
   `format: "timings"`. A `RemoteDisconnected`/`ReadTimeout` on a full article
   means the client gave up, not that synthesis failed.

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
# alignment logic (no server or Chrome needed)
node tools/test-sentences.mjs
# ALL PASS (28 checks across 14 cases)

# live server
curl -s localhost:3733/health
# {"ok":true,"ready":true,"installedLangs":["en-us"],"voices":217}
curl -s -X POST localhost:3733/tts -H 'Content-Type: application/json' \
  -d '{"text":"The quick brown fox.","format":"json"}' | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print(d['sample_rate'], d['duration_ms'], len(d['words']), len(d['sentences']))"
# 24000 1596 4 1
```

Read-aloud UI: open <http://127.0.0.1:3733/demo>, paste text, click
**Synthesize & play** — the spoken sentence and word are highlighted in place.

Verified 2026-10-09 on Chrome 154.0.8037.97: 1739-char article →
97.4 s audio in 16.9 s wall (~5.7× realtime), 322 timestamped words;
WAV levels healthy (peak 22079, RMS 3379); MP3 transcode OK.
Alignment verified on a 2159-char / 2-chunk input → 60 sentences, monotonic
timings, spans reconstructing the input exactly.
PDF path verified end-to-end on a 4-page letter (1539 words) and a 13-page
chapter of the Haiku system card (3115 words): `PROBLEMS: 0` for both, with
pause gaps measured in the PCM at exactly 700/220/500 ms. Full system card
(145 pages, 31,943 words, ~213 min audio) extracts clean; TOC pages 4-7 and
139 page numbers dropped, figure captions kept.

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
