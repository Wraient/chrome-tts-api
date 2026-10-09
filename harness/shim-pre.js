// shim-pre.js — runs BEFORE bindings_main.js and offscreen_compiled.js.
// Fakes the extension environment the offscreen TTS bundle expects:
// a chrome.runtime message bus and an AudioWorkletNode that captures PCM
// instead of playing it.
'use strict';

window.__tts = {
  listener: null,   // captured chrome.runtime.onMessage listener
  events: [],       // messages the bundle "sends" to the background page
  buffers: [],      // captured Float32Array(128) PCM chunks @24kHz
  timepoints: [],   // word timings scraped from the wasm getters
  synthDone: null,  // completion callback for the in-flight utterance
  inflight: false,  // true between InitBuffered and FinalizeBuffered
  module: null,     // wrapped wasm module instance
};

// --- chrome.runtime shim -------------------------------------------------
window.chrome = {
  runtime: {
    onMessage: {
      addListener(fn) { window.__tts.listener = fn; },
    },
    sendMessage(...args) {
      // offscreen always calls sendMessage(extensionId, msg)
      const msg = args[args.length - 1];
      window.__tts.events.push(msg);
      return Promise.resolve({});
    },
  },
};

// --- Fake AudioWorkletNode: sink PCM, never play --------------------------
// offscreen does: new AudioWorkletNode(ctx, name); .port.onmessage = ...;
// .port.postMessage({command:'addBuffer', buffer}); .connect(); .disconnect()
window.AudioWorkletNode = class FakeAudioWorkletNode {
  constructor(_ctx, _name) {
    this.port = {
      onmessage: null,
      postMessage(m) {
        if (m && m.command === 'addBuffer' && m.buffer) {
          window.__tts.buffers.push(m.buffer);
        }
      },
    };
  }
  connect() {}
  disconnect() {}
};
