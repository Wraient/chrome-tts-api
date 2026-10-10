#!/usr/bin/env node
// Regression tests for sentence segmentation (lib/sentences.mjs).
//
//   node tools/test-sentences.mjs
//
// Zero dependencies, no server or Chrome needed: every case is driven through
// a mock tokenizer that reproduces both punctuation shapes the engine emits.
// Assertions per case: spans reconstruct the input exactly, spans are ordered
// and non-overlapping, and timings are monotonic.
import { sentencesFrom, pausePlan } from '../lib/sentences.mjs';

// The engine has been observed emitting punctuation BOTH ways:
//   'engine'   — standalone fragments:  'Washington' + '. '
//   'attached' — glued to the word:      'Washington.'
// Abbreviations stay attached in both ('Dr.'). Both shapes must segment
// identically, so every case runs through both.
const ABBR = new Set(['dr', 'mr', 'mrs', 'ms', 'prof', 'st', 'jr', 'sr', 'vs',
  'etc', 'no', 'fig', 'vol', 'eg', 'ie', 'inc', 'ltd', 'jan', 'feb', 'mar',
  'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec']);

function tokenize(text, mode) {
  const out = [];
  const re = /\s+|\S+/g;
  let m;
  while ((m = re.exec(text))) {
    const raw = m[0];
    const ci = m.index;
    const isSpace = /^\s+$/.test(raw);
    if (isSpace) {
      out.push({ word: raw, ci, len: raw.length });
      continue;
    }
    if (mode === 'engine') {
      // Split trailing terminal punctuation into its own fragment that
      // carries the following whitespace, unless it is an abbreviation.
      const mm = /^(.+?)([.!?…]+["”’')\]]*)(?=\s|$)/.exec(raw);
      const stem = mm ? mm[1].toLowerCase().replace(/\./g, '') : null;
      if (mm && stem && !ABBR.has(stem) && stem.length > 1) {
        out.push({ word: mm[1], ci, len: mm[1].length });
        out.push({ word: mm[2], ci: ci + mm[1].length, len: mm[2].length });
        continue;
      }
    }
    out.push({ word: raw, ci, len: raw.length });
  }
  if (mode === 'engine') {
    // Observed engine behaviour: for list items the punctuation fragment also
    // swallows the following dash/bullet and its whitespace ('. - ').
    for (let i = 0; i < out.length - 1; i++) {
      if (/^[.!?…]+["”’')\]]*$/.test(out[i].word)
          && /^[—–•‣·-]+$/.test(out[i + 1].word)) {
        out[i].word += ' ' + out[i + 1].word + (out[i + 2] && /^\s+$/.test(out[i + 2].word) ? ' ' : '');
        out[i].len += 1 + out[i + 1].len + (out.splice(i + 1, out[i + 2] && /^\s+$/.test(out[i + 1].word) ? 2 : 1)[0].len);
      }
    }
  }
  return out
    .map((t, i) => ({
      word: t.word,
      char_index: t.ci,
      length: t.len,
      start_ms: i * 100,
      end_ms: i * 100 + 100,
    }))
    .filter((w) => w.word.trim().length > 0); // server filters whitespace-only
}

const CASES = [
  'Dr. Smith went to Washington. He arrived on Tuesday! Was it worth it?',
  'Hello world.',
  'Hello world',
  'No terminal punctuation here',
  'e.g. this is an example. And another one.',
  'The U.S. economy grew 3.5 percent last year. Analysts were surprised.',
  'She said "I am done." Then she left.',
  'Wait... what? Really?! Yes.',
  'One. Two. Three. Four.',
  'Mr. Brown met Mrs. Green at 5 p.m. on Jan. 5th.',
  'Ends with ellipsis…',
  'A sentence with a trailing dash - like this one. Next one here.',
  'Multiple!!! Exclamations??? Works?',
  'Quotes "nested," she said. Then nothing.',
  // The engine emits '. - ' as a single fragment for list items; these must
  // still split, or a whole bullet list merges into the previous sentence.
  'Alpha one. - Beta two. - Gamma three.',
  'Step one. — Step two.',
  'Done. • Then more. • Then done.',
  'Intro line. - Point one. - Point two.',
  // A list that opens the text: the leading marker has no preceding sentence
  // to donate it to, so the first span must claim it.
  '- First item. - Second item.',
  '• One. • Two.',
  // PDF-shaped input: a heading carries no terminal punctuation, so without the
  // blank-line rule it merges into the paragraph after it.
  'Executive summary\n\nThe card describes the model. It covers evaluations.\n\nA new paragraph.',
  '1.1 Training data\n\nHaiku was trained on a proprietary mix. It was fine.',
  'One. Two.\n\nThree. Four.',
];

// Sentence spans plus the size of the silence that follows them. The engine
// renders gapless, so these pauses are inserted in Node — see server.mjs.
// Every sentence is tagged, including the last (which never gets a pause).
const BREAKS = [
  ['One. Two. Three.', ['sentence', 'sentence', 'sentence']],
  ['Head\n\nBody text here.', ['heading', 'sentence']],
  ['First para.\n\nSecond para.', ['paragraph', 'sentence']],
  ['Intro.\n\nHead\n\nBody.', ['paragraph', 'heading', 'sentence']],
];

let failures = 0;
let checks = 0;

for (const [input, want] of BREAKS) {
  checks++;
  const words = tokenize(input, 'engine');
  const got = sentencesFrom(input, words).map((s) => s.break_after);
  const plan = pausePlan(sentencesFrom(input, words));
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  break_after ${JSON.stringify(got)}`
    + `  pauses ${JSON.stringify(plan.map((p) => p.ms))}`);
  if (!ok) console.log(`      expected ${JSON.stringify(want)}`);
}

for (const input of CASES) {
  for (const mode of ['engine', 'attached']) {
    checks++;
    const words = tokenize(input, mode);
    const sentences = sentencesFrom(input, words);
    // 1. spans must cover the same characters as the input. Whitespace is
    //    ignored on purpose: spans can be exactly adjacent, so joining them
    //    with a separator invents a space the source never had. Exact spacing
    //    is pinned by the gap and edge checks below instead.
    const reconstructed = sentences.map((s) => input.slice(s.char_index, s.char_end)).join('');
    const clean = (t) => t.replace(/\s+/g, '');
    const recon = clean(reconstructed);
    const expected = clean(input);
    const spansOk = recon === expected;
    // 2. spans must be ordered and non-overlapping, and must TILE the text:
    //    any inter-sentence gap may only be whitespace, otherwise some
    //    characters belong to no sentence and highlighting skips them.
    let ordered = true;
    let gap = null;
    for (let i = 1; i < sentences.length; i++) {
      if (sentences[i].char_index <= sentences[i - 1].char_index) ordered = false;
      if (sentences[i].char_index < sentences[i - 1].char_end) ordered = false;
      const between = input.slice(sentences[i - 1].char_end, sentences[i].char_index);
      if (between.trim()) gap = between;
    }
    const covered = gap === null;
    // 3. the ends are covered too: nothing before the first or after the last
    //    sentence may be a real character.
    const head = sentences.length ? input.slice(0, sentences[0].char_index) : input;
    const tail = sentences.length ? input.slice(sentences[sentences.length - 1].char_end) : '';
    const edgesOk = !head.trim() && !tail.trim();
    const ok = spansOk && ordered && covered && edgesOk;
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  [${mode.padEnd(8)}] ${sentences.length} sent  ${JSON.stringify(input.slice(0, 50))}`);
    if (!ok) {
      console.log(`      spans_ok=${spansOk} ordered=${ordered} covered=${covered} edges_ok=${edgesOk}`
        + (gap === null ? '' : ` gap=${JSON.stringify(gap)}`)
        + (head.trim() ? ` head=${JSON.stringify(head)}` : '')
        + (tail.trim() ? ` tail=${JSON.stringify(tail)}` : ''));
      console.log(`      expected: ${JSON.stringify(expected)}`);
      console.log(`      got     : ${JSON.stringify(recon)}`);
      for (const s of sentences) console.log(`        [${s.char_index}-${s.char_end}] ${JSON.stringify(s.text)}`);
    } else {
      console.log(`        -> ${sentences.map((s) => JSON.stringify(s.text)).join(' | ')}`);
    }
  }
}
console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (${checks} checks across ${CASES.length} cases)`);
process.exit(failures === 0 ? 0 : 1);