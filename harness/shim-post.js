// shim-post.js — runs AFTER bindings_main.js, BEFORE offscreen_compiled.js.
// Wraps the wasm module factory so we can:
//  1. scrape exact word timings from the GetTimepoints* getters, and
//  2. detect synthesis completion via FinalizeBuffered (the fake worklet
//     never emits the 'empty' message the bundle normally uses for this).
'use strict';

(function () {
  const origFactory = window.loadWasmTtsBindings;
  if (typeof origFactory !== 'function') {
    throw new Error('loadWasmTtsBindings not found; script order broken?');
  }

  window.loadWasmTtsBindings = function (opts) {
    return origFactory(opts).then((m) => {
      const st = window.__tts;
      st.module = m;

      const origInitBuffered = m._GoogleTtsInitBuffered.bind(m);
      m._GoogleTtsInitBuffered = function (...a) {
        st.inflight = true;
        st.timepoints.length = 0;
        st.buffers.length = 0;
        st.events.length = 0;
        return origInitBuffered(...a);
      };

      const origRead = m._GoogleTtsReadBuffered.bind(m);
      m._GoogleTtsReadBuffered = function (...a) {
        const r = origRead(...a);
        try {
          const n = m._GoogleTtsGetTimepointsCount();
          for (let i = 0; i < n; i++) {
            const tp = {
              t: m._GoogleTtsGetTimepointsTimeInSecsAtIndex(i),
              i: Number(m._GoogleTtsGetTimepointsCharIndexAtIndex(i)),
              l: Number(m._GoogleTtsGetTimepointsCharLengthAtIndex(i)),
            };
            // Guard against cumulative getter semantics (would double-add).
            const prev = st.timepoints[st.timepoints.length - 1];
            if (!prev || prev.i !== tp.i || prev.t !== tp.t) {
              st.timepoints.push(tp);
            }
          }
        } catch (e) {
          st.events.push({ type: 'timepointError', error: String(e) });
        }
        return r;
      };

      const origFin = m._GoogleTtsFinalizeBuffered.bind(m);
      m._GoogleTtsFinalizeBuffered = function (...a) {
        const was = st.inflight;
        st.inflight = false;
        const r = origFin(...a);
        if (was && st.synthDone) {
          const f = st.synthDone;
          st.synthDone = null;
          f();
        }
        return r;
      };

      return m;
    });
  };
})();
