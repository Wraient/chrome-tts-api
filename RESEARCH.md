# RESEARCH.md — how Chrome's "Listen to this page" works

Complete reverse-engineering notes (Oct 2026, Chrome 154). Nothing here
should need rediscovery: sources, endpoints, protocols, file formats,
and every non-obvious behavior found while building this project.

## TL;DR

Chrome's read-aloud voices are **platform-specific backends**, not one API:

| Backend | Where | Synthesis | Reusable? |
|---|---|---|---|
| WASM TTS engine component | Desktop Reading Mode | On-device (wasm + `.zvoice` packs) | **Yes — this project** |
| Enhanced Network TTS | ChromeOS Select-to-Speak | Server `readaloud.googleapis.com` | Needs ChromeOS-only API key |
| Native ReadAloudService | New, flag-gated (all platforms) | Server `chromemodelexecution-pa.googleapis.com` | Needs Google OAuth token |
| PlaybackHooks DFM | Android "Listen to this page" | Server, closed source | No (impl not in Chromium) |

The beloved `Google * (Natural)` desktop voices are the on-device path:
public engine files + public voice-pack URLs + an undocumented wasm API.

## 1. Desktop: on-device WASM engine (this project's backend)

### 1.1 Delivery

- Chromium registers a component-updater component at every startup on
  Win/Mac/Linux:
  `chrome/browser/component_updater/wasm_tts_engine_component_installer.cc`
  (`RegisterWasmTtsEngineComponent`, called from `registration.cc`).
- Omaha app/extension id: `bjbcblmdcnggnibecjikpoljcgkbgphl`
  (SHA256-of-SPKI → `crx_file::id_util::GenerateIdFromHash`; id is also
  spelled out in a comment above `kWasmTtsEnginePublicKeySHA256`).
  (Two older constants exist in `extension_constants.h` —
  `kTTSEngineExtensionId=kfgd…`, `kComponentUpdaterTTSEngineExtensionId=gjja…`
  — the live component uses the `bjbc…` id.)
- On-demand download is triggered when Reading Mode opens:
  `chrome/browser/ui/read_anything/read_anything_service.cc` →
  `UpdateWasmComponentOnDemand()` (unless
  `IsWasmTtsEngineAutoInstallDisabled()`).
- Install dir: `<profile>/WasmTtsEngine/<version>/`. Observed version
  `20260917.1`, engine (inner) version `13.2`, name
  "Chrome built-in text-to-speech extension".
- Update check endpoint (standard Omaha): 
  `https://update.googleapis.com/service/update2/json`
  (confirmed in a `--log-net-log` capture).

### 1.2 Component contents

| File | Size | Role |
|---|---|---|
| `bindings_main.wasm` | 23 MB | Emscripten build, **pthreads** (needs cross-origin isolation) |
| `bindings_main.js` | 250 KB | Emscripten MODULARIZE glue, UMD factory `loadWasmTtsBindings` (works in browser and Node) |
| `offscreen_compiled.js` | 67 KB | Engine driver (Closure-compiled). All API knowledge comes from here |
| `background_compiled.js` | 19 KB | MV3 service worker: `chrome.ttsEngine` ↔ offscreen message bridge |
| `streaming_worklet_processor.js` | 2.3 KB | AudioWorklet that plays 128-sample Float32 chunks |
| `voices.json` | 50 KB | Pack catalog: 66 packs, see §1.3 |
| `wasm_tts_manifest_v3.json` | 1.1 KB | Real MV3 manifest (`ttsEngine`, `offscreen`, `unlimitedStorage` permissions; host perms `https://*.gvt1.com/`, `https://dl.google.com/`; CSP `script-src 'self' 'wasm-unsafe-eval'`) |
| `offscreen.html` | 115 B | Loads `bindings_main.js` + `offscreen_compiled.js` |

### 1.3 voices.json schema (66 packs, 217 speakers, ~486 MB total)

```json
[{
  "id": "en-us-x-multi-seanet",
  "fileId": "en-us-x-multi-seanet-r84",
  "url": "https://redirector.gvt1.com/edgedl/android/tts/v26/en-us/en-us-x-multi-seanet-r84.zvoice",
  "sha256Checksum": "…",
  "compressedSize": 4255209,
  "speakers": [{"speaker": "iob", "name": "Google US English 1 (Natural)", "gender": "female"}],
  "dependentVoiceId": "en-us-x-multi",
  "remote": true
}]
```

- Every pack has `remote: true`. Packs come in pairs: a **base** pack
  (`<lang>-x-multi`, speakers named `Chrome OS …`, contains the full
  text-norm + acoustic stack) and a **seanet** pack
  (`<lang>-x-multi-seanet`, speakers named `Google … (Natural)`,
  `dependentVoiceId` → base pack). The `(Natural)` voices users hear are
  the seanet speakers; installing one installs its base pack first
  (resolved in offscreen `Vh()` via the `D` name→dependent map).
- Display names in Chromium's `voice_nature_naming.ts`
  (`VOICE_NATURE_NAMING_BY_LOCALE`, 109 entries: Pebble/Mesa/Slate/…) match
  these speaker names exactly. 33 locales in
  `AVAILABLE_GOOGLE_TTS_LOCALES`.
- URLs are Google's public edge cache (`edgedl`, same CDN family as
  Android TTS data). No auth; **verified by download + sha256 match**
  (see `tools/download-voices.mjs`).

### 1.4 .zvoice format

Plain ZIP (store/deflate). en-us base = 43 files, e.g.:

- Text normalization: `lettuce_model.fb`, `lettuce_classify_*.far`,
  `en_us.hlex.bin`, `*_phonology.pb`, `en_verbalize_spec.pb`,
  `g2p_m3_syls0_stress0_en-US.fst`, `en_morphology` (2.7 MB)
- Acoustic model: `burdock_valerian_model.tflite` (1.8 MB),
  `en_us_x_embedded_valerian_vocoded.pipeline.pb` (+ `_backend` variant),
  `backend_pipeline.pb`
- `InstallVoice` unpacks the zip into `/voices/<fileId>/` inside the
  wasm FS and persists via IDBFS (`FS.syncfs`). Post-install check is
  `FS.stat("/voices/<fileId>/pipeline.pb")`.

### 1.5 wasm C API (from Emscripten exports)

```
GoogleTtsInit(pipelinePathPtr, voiceDirPtr) -> 1 on success
GoogleTtsInstallVoice(dirPathPtr, zipBytesPtr, zipLen) -> 1 on success
GoogleTtsInitBuffered(reqProtoPtr, speakerProtoPtr, reqLen, speakerLen) -> truthy
GoogleTtsReadBuffered() -> >0 more data | 0 done | -1 error
GoogleTtsGetTimepointsCount()
GoogleTtsGetTimepointsTimeInSecsAtIndex(i) -> float seconds
GoogleTtsGetTimepointsCharIndexAtIndex(i)  -> int
GoogleTtsGetTimepointsCharLengthAtIndex(i) -> int
GoogleTtsGetEventBufferPtr() / GoogleTtsGetEventBufferLen()
GoogleTtsFinalizeBuffered()
GoogleTtsShutdown()
```

### 1.6 Speak flow (traced from offscreen_compiled.js)

`onSpeak(utterance, {voiceName, lang, rate, pitch, volume})`:

1. `init()` once: `loadWasmTtsBindings()` → mount IDBFS at `/voices` +
   `syncfs(load)` → fetch `voices.json` → build maps
   (`N`: name→packId, `G`: name→fileId, `O`: name→speakerCode,
   `S`: name→url, `D`: name→dependentPackId) → start AudioWorklet.
2. Ensure voice (`Eh`): if `/voices/<fileId>/pipeline.pb` missing →
   install dependent pack first, then `fetch(url)` → verify sha256 +
   size → `mkdir` → `_GoogleTtsInstallVoice` → `syncfs(save)`.
3. `_GoogleTtsInit("/voices/<fileId>/pipeline.pb", "/voices/<fileId>")`
   (skipped if same voice as last utterance: `c.W===d` fast path).
4. Build two JSPB protobufs and `_GoogleTtsInitBuffered(req, speaker)`:
   - request proto: text (string field), rate float field 1
     (clamped 0.1–10, default 1), pitch-factor float field 6 =
     `2^((pitch-1)*20/12)` (pitch=1 → ×1). Volume is NOT in the proto
     (applied to a GainNode in Chrome; this project multiplies PCM).
   - speaker proto: speaker code string field 1 (e.g. `iob`).
   - Exact `.proto` sources are Google-internal (not in Chromium); the
     JSPB descriptors are embedded in the bundle. This project reuses
     the bundle verbatim instead of reimplementing them.
5. Poll loop (`Ah`, `setTimeout(0)`): `_GoogleTtsReadBuffered()`; after
   each call drain timepoints (`Count` + getters — semantics are
   per-call, not cumulative, but the harness dedupes defensively);
   read event buffer (`Ptr`/`Len` → Uint8Array → parse proto →
   `{sampleRate, pcmS16}`); sample rate MUST be 24000 or the chunk is
   dropped. int16 → float32 (/32768) → 128-sample worklet chunks.
6. `_GoogleTtsFinalizeBuffered()` on done (`ReadBuffered===0`) or error
   (`-1`). Normal `end` event comes from the worklet `empty` message
   (see harness notes §4.5).

### 1.7 Timing semantics

- Timepoints = word/phrase starts: `{timeSecs, charIndex, charLength}`.
  The engine also emits whitespace/punctuation fragments (`' '`, `', '`,
  trailing empty) — filter `word.trim()===''` for a words API.
- Word end time = next timepoint's start (last = audio end).
- Audio: **24000 Hz, mono, signed 16-bit PCM**. No header from the
  engine (this project adds WAV headers).

### 1.8 background ↔ offscreen ↔ Chrome wiring

- `background_compiled.js`: service worker, `chrome.ttsEngine.onSpeak/
  onStop/onPause/onResume/onInstallLanguageRequest/
  onLanguageStatusRequest/onUninstallLanguageRequest` listeners.
  Creates the offscreen document
  (`offscreen.createDocument({reasons:[AUDIO_PLAYBACK, USER_MEDIA]})`),
  forwards speak/stop/pause/resume/install messages, relays
  `offscreenVoicesResponse` → `ttsEngine.updateVoices`,
  `offscreenTtsEventResponse` → speak callbacks. Closes the offscreen
  doc after 5 min idle; purges unused languages after 90/140 days
  (`installedTimestamps`/`lastUsedTimestamps` in storage).
- Reading Mode UI (`chrome/browser/resources/side_panel/read_anything/`):
  plain Web Speech API (`SpeechSynthesisUtterance` + `speechSynthesis`),
  voices filtered by `getFilteredVoiceList`, natural-voice detection =
  name contains `(Natural)` (`voice_language_conversions.ts`).
  `MAX_SPEECH_LENGTH = 175` chars per utterance for remote voices.

## 2. ChromeOS server backend (not used here)

- Code: `chromeos/ash/components/enhanced_network_tts/`
  (`_constants.h`, `_impl.cc`, `_utils.cc`, `mojom/`).
- `POST https://readaloud.googleapis.com//v1:generateAudioDocStream`
  (note double slash, verbatim from source), header
  `X-Goog-Api-Key: <GetReadAloudAPIKey()>` (key compiled in, ChromeOS
  builds only), `Content-Type: application/json`, no cookies.
- Request: `{"text":{"text_parts":[utterance≤1000 chars]},
  "advanced_options":{"audio_generation_options":{"speed_factor":0.3–4.0 step 0.1},
  "force_language":lang},
  "voice_settings":{"voice_criteria_and_selections":
  [{"selection":{"default_voice":voice},"criteria":{"language":lang}}]}}`.
  Voices are Cloud-style names (mojom example: `aua-wavenet` + `en`).
  Long utterances are sentence/word-chunked client-side and sent serially.
- Response: 3-element JSON list
  `[metadata, {"text":{"timingInfo":[{text, location:{textLocation:{offset,length},
  timeLocation:{timeOffset,duration}}}] }}, {"audio":{"bytes": base64 mp3}}]`.
  MP3 @32 kbps, 5 MB cap.
- **Probed 202
...[truncated 5462 chars]