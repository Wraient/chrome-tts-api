// api.js — runs AFTER offscreen_compiled.js. Drives the captured
// chrome.runtime.onMessage listener like the background page would, and
// exposes a promise API for CDP callers.
'use strict';

(function () {
  const st = window.__tts;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function send(msg) {
    return new Promise((resolve) => {
      st.listener(msg, { id: 'harness' }, (resp) => resolve(resp));
    });
  }

  // Resolves when the wasm module is up and voices.json is parsed.
  window.__ttsReady = (async function () {
    for (let i = 0; i < 200 && !st.listener; i++) await sleep(50);
    if (!st.listener) throw new Error('offscreen listener never registered');
    await send({ type: 'init' });
    for (let i = 0; i < 300; i++) {
      if (st.events.some((e) => e && e.type === 'offscreenVoicesResponse')) break;
      await sleep(100);
    }
    if (!st.events.some((e) => e && e.type === 'offscreenVoicesResponse')) {
      throw new Error('engine init timed out (no offscreenVoicesResponse)');
    }
    return true;
  })();

  // Install every voice pack for a language ('en-us'). Downloads .zvoice
  // files, verifies sha256, unpacks into IDBFS. Resolves to status string.
  window.__ttsInstall = function (lang) {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve('timeout'), 180000);
      // NOTE: install status arrives via the send() callback, not the
      // event bus (onInstallLanguageRequest resolves its response).
      send({ type: 'installLanguage', lang }).then((resp) => {
        clearTimeout(t);
        resolve(resp && resp.status ? resp.status : 'no-status');
      }).catch((e) => {
        clearTimeout(t);
        resolve('error: ' + e);
      });
    });
  };

  // Synthesize one utterance. Resolves with 24kHz mono PCM + word timings.
  // options: { voiceName, lang, rate (0.1-10), pitch (~0.5-2, 1=normal),
  //            volume (0-1, applied in post) }
  window.__ttsSpeak = function (utterance, options) {
    options = options || {};
    return new Promise((resolve, reject) => {
      const mark = st.events.length;
      const timer = setTimeout(() => {
        if (st.synthDone) {
          st.synthDone = null;
          reject(new Error('speak timed out after 120s'));
        }
      }, 120000);

      st.synthDone = () => {
        clearTimeout(timer);
        try {
          const bufs = st.buffers.splice(0);
          let total = 0;
          for (const b of bufs) total += b.length;
          const pcm = new Float32Array(total);
          let o = 0;
          for (const b of bufs) { pcm.set(b, o); o += b.length; }
          // Trim trailing silence from the partially-filled final chunk.
          let end = pcm.length;
          while (end > 0 && pcm[end - 1] === 0) end--;
          const vol = typeof options.volume === 'number' ? Math.min(Math.max(options.volume, 0), 1) : 1;
          const i16 = new Int16Array(end);
          for (let i = 0; i < end; i++) {
            const s = Math.min(1, Math.max(-1, pcm[i] * vol));
            i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }
          const u8 = new Uint8Array(i16.buffer);
          let bin = '';
          for (let i = 0; i < u8.length; i += 8192) {
            bin += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
          }
          resolve({
            sampleRate: 24000,
            samples: i16.length,
            pcm16Base64: btoa(bin),
            timepoints: st.timepoints.slice(),
            events: st.events.slice(mark).filter((e) => e && (e.type === 'word' || e.type === 'error')),
          });
        } catch (e) {
          reject(e);
        }
      };

      try {
        send({ type: 'speak', utterance, options });
      } catch (e) {
        clearTimeout(timer);
        st.synthDone = null;
        reject(e);
      }
    });
  };
})();
