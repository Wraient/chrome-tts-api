// Alignment: text -> (chunks, per-word timings, per-sentence spans).
//
// Pure functions only — no I/O, no server state — so they can be imported and
// regression-tested directly (see tools/test-sentences.mjs). server.mjs drives
// these from the engine's timepoints.
//
// Two tokenization shapes are handled, because the engine emits both:
//   1. standalone punctuation fragments carrying trailing whitespace ('. ')
//   2. punctuation attached to the preceding word ('Dr.', 'Washington.')

export const MAX_CHUNK = 1200;

// Split into engine-sized chunks, each an exact substring of the input with its
// true offset. Paragraph breaks (blank lines) are preserved inside chunk text:
// they are what drives sentence boundaries and pause sizing downstream, and the
// engine treats a newline exactly like a space anyway (measured: 0 ms).
// Offsets must stay exact — the previous version rebuilt the text by joining
// chunks with ' ', which silently collapsed every blank line to one space.
function splitText(text) {
  const full = String(text);
  const paras = [];
  let start = 0;
  const re = /\n[ \t]*\n/g;
  let m;
  while ((m = re.exec(full)) !== null) {
    paras.push([start, m.index]);
    start = m.index + m[0].length;
  }
  paras.push([start, full.length]);

  // An over-long paragraph has to be broken at whitespace so we never cut
  // mid-word, which would mispronounce it.
  const emit = (from, to) => {
    let a = from;
    while (a < to) {
      let b = Math.min(to, a + MAX_CHUNK);
      if (b < to) {
        const sp = full.lastIndexOf(' ', b);
        if (sp > a) b = sp;
      }
      if (!full.slice(a, b).trim()) return;
      chunks.push({ text: full.slice(a, b), start: a });
      a = b;
      while (a < to && /\s/.test(full[a])) a++;
    }
  };

  const chunks = [];
  let curStart = null, curEnd = null;
  for (const [ps, pe] of paras) {
    if (!full.slice(ps, pe).trim()) continue;
    if (curStart === null) { curStart = ps; curEnd = pe; continue; }
    if (pe - curStart <= MAX_CHUNK) { curEnd = pe; continue; }
    emit(curStart, curEnd);
    curStart = ps; curEnd = pe;
  }
  if (curStart !== null) emit(curStart, curEnd);
  return chunks;
}

function wordsFrom(fullText, chunks, results) {
  const words = [];
  for (let ci = 0; ci < chunks.length; ci++) {
    const { start: charBase, msBase } = chunks[ci];
    const tps = results[ci].timepoints;
    for (let i = 0; i < tps.length; i++) {
      const tp = tps[i];
      const next = tps[i + 1];
      const startMs = msBase + tp.t * 1000;
      words.push({
        word: fullText.substr(charBase + tp.i, tp.l),
        start_ms: Math.round(startMs),
        end_ms: Math.round(next ? msBase + next.t * 1000 : msBase + results[ci].ms),
        char_index: charBase + tp.i,
        length: tp.l,
      });
    }
  }
  // The engine also emits pause/whitespace fragments; API consumers want words.
  return words.filter((w) => w.word.trim().length > 0);
}

// Group words into sentences for sentence-level highlighting.
//
// The engine emits punctuation in two shapes, and both must be handled:
//   1. standalone fragments carrying trailing whitespace — '. ' '? ' '! '
//   2. attached to the preceding word — 'Dr.' 'Washington.' 'done."'
// A period attached to a word is only terminal when it is not an
// abbreviation / initial / decimal and the next word starts a new clause.
// Characters allowed between terminal punctuation and the fragment's trailing
// whitespace. Dashes and bullets matter: the engine emits `'. - '` as ONE
// fragment for list items, so excluding them merged whole bullet lists into
// the preceding sentence. `\s*` inside the pattern crosses the space between
// the period and the marker ('. - '), and every class char is escaped.
const CLOSERS = '”’"\'\\)\\]\\-—–•‣·';
const ABBREV_TAIL = new RegExp(`^([A-Za-z][A-Za-z.]*)([.!?…])[.!?…]*\\s*[${CLOSERS}]*\\s*$`);
const TERMINAL_FRAG = new RegExp(`^[.!?…]+\\s*[${CLOSERS}]*\\s*$`);

const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'ft', 'rev', 'hon',
  'gen', 'col', 'capt', 'lt', 'sgt', 'gov', 'sen', 'rep', 'pres', 'supt',
  'vs', 'etc', 'al', 'inc', 'ltd', 'co', 'corp', 'dept', 'est', 'fig', 'no',
  'vol', 'approx', 'ex', 'eg', 'ie', 'cf', 'ca', 'min', 'max', 'avg', 'misc',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun',
]);

function endsSentence(word, nextWord) {
  const w = String(word || '');
  // (1) standalone punctuation fragment: '. ' '? ' '..."' '. - '
  if (TERMINAL_FRAG.test(w)) return true;
  // (2) punctuation attached to a word: 'Washington.' 'done."'
  const m = ABBREV_TAIL.exec(w);
  if (!m) return false;
  const stem = m[1].toLowerCase().replace(/\./g, '');
  const punct = m[2];
  if (punct === '.') {
    if (ABBREVIATIONS.has(stem)) return false;
    if (stem.length === 1) return false;                       // initial: 'J. Smith'
    if (/^\d/.test(stem) && nextWord && /^\d/.test(nextWord)) return false; // '3.5'
    // A single period followed by a lowercase word is mid-sentence
    // ('U.S. economy'). Multiple periods ('Wait...') are a real ellipsis.
    const periods = (w.match(/\./g) || []).length;
    if (nextWord && periods === 1 && /^[a-z]/.test(nextWord)) return false;
  }
  return true;
}

// Punctuation that may sit after the last tokenized word of a sentence. A
// trailing '.' at the very end of the input frequently gets no timepoint at
// all, so spans are extended over it for display purposes.
const TRAIL_PUNCT = new Set(['.', ',', ';', ':', '!', '?', '…',
  '"', '”', '’', "'", ')', ']', '—', '-', '*', ' ']);

const BLANK_LINE = /\n[ \t]*\n/;
const HAS_TERMINAL = /[.!?…]["”’')\]]*$/;

// Default silence inserted after a sentence, keyed by what follows it. The
// engine trims its own trailing silence and renders gapless, so pauses have to
// be added here in Node — punctuation alone does not produce them (an ellipsis
// and an em-dash both measure 0 ms). Callers may retune these per request, or
// set any of them to 0 to opt out.
export const DEFAULT_PAUSES = { sentence: 220, paragraph: 500, heading: 700 };

function sentencesFrom(fullText, words) {
  const out = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    // Cover trailing punctuation the engine did not tokenize, then drop the
    // whitespace the terminal fragment carried into char_end.
    let end = cur.char_end;
    while (end < fullText.length && !/\s/.test(fullText[end]) && TRAIL_PUNCT.has(fullText[end])) end++;
    while (end > cur.char_index && /\s/.test(fullText[end - 1])) end--;
    // A list marker belonging to the NEXT item rides along on the terminal
    // fragment ('. - '), which would leave 'Alpha one. -' highlighted. Hand it
    // back so the bullet starts with the sentence it introduces.
    while (end > cur.char_index && /[—–\-•‣·\s]/.test(fullText[end - 1])) end--;
    cur.char_end = end;
    cur.text = fullText.slice(cur.char_index, end);
    out.push(cur);
    cur = null;
  };
  let straddleStart = null;
  for (let k = 0; k < words.length; k++) {
    const w = words[k];
    // Some tokens straddle a block break: the engine emits '2026.\n\n1.2' as a
    // single token, blank line and all, which hid the boundary and welded the
    // next heading onto the previous sentence. If the text before the break
    // ends a sentence, close it here and restart after the separator.
    const nl = BLANK_LINE.exec(w.word);
    if (nl) {
      const head = w.word.slice(0, nl.index);
      if (HAS_TERMINAL.test(head)) {
        // The text before the break finishes the open sentence, so extend it
        // over the head first — otherwise '2026.' is left in a gap — then close
        // it and start the next sentence after the separator.
        if (cur) {
          cur.char_end = w.char_index + nl.index;
          flush();
        }
        straddleStart = w.char_index + nl.index + nl[0].length;
      }
    }
    // A blank line in the source is a hard block boundary. A heading carries no
    // terminal punctuation, so without this it would merge into the paragraph
    // after it — 'Executive summary\nThis system card…' came back as a single
    // 438-word sentence.
    if (cur && BLANK_LINE.test(fullText.slice(cur.char_end, w.char_index))) flush();
    if (!cur) {
      cur = {
        start_ms: w.start_ms, char_index: straddleStart ?? w.char_index,
        end_ms: w.end_ms, char_end: w.char_index + w.length,
      };
      straddleStart = null;
    } else {
      cur.end_ms = w.end_ms;
      cur.char_end = w.char_index + w.length;
    }
    if (endsSentence(w.word, words[k + 1] && words[k + 1].word)) flush();
  }
  flush();
  // A list marker belonging to the NEXT item rides along on the terminal
  // fragment ('. - '), so flush() drops it to keep the boundary clean. Move the
  // start of the following sentence back over it instead, or the marker ends up
  // owned by no sentence and the spans no longer tile the text.
  for (let i = 1; i < out.length; i++) {
    while (out[i].char_index > out[i - 1].char_end
      && /[—–\-•‣·\s]/.test(fullText[out[i].char_index - 1])) {
      // Claim intra-paragraph whitespace and markers, but never cross a blank
      // line: that separator is what marks a block boundary, and swallowing it
      // would merge a heading into the paragraph after it.
      if (BLANK_LINE.test(fullText.slice(out[i - 1].char_end, out[i].char_index))) break;
      out[i].char_index--;
    }
    out[i].text = fullText.slice(out[i].char_index, out[i].char_end);
  }
  // The engine emits no timepoint for some leading non-word characters, which
  // would strand them in a gap — e.g. the '[' of "[Figure 6.2.1.A]" starts a
  // block, so nothing owned it and the spans stopped tiling the text. Claim
  // the run of punctuation directly before the next sentence, stopping at
  // whitespace so a blank-line separator is never swallowed.
  for (let i = 1; i < out.length; i++) {
    let q = out[i].char_index;
    while (q > out[i - 1].char_end && /[^\p{L}\p{N}\s]/u.test(fullText[q - 1])) q--;
    out[i].char_index = q;
    out[i].text = fullText.slice(out[i].char_index, out[i].char_end);
  }
  // Same before the very first sentence (a caption or quote that opens the text).
  if (out.length) {
    let q = out[0].char_index;
    while (q > 0 && /[^\p{L}\p{N}\s]/u.test(fullText[q - 1])) q--;
    out[0].char_index = q;
    out[0].text = fullText.slice(out[0].char_index, out[0].char_end);
  }
  // The straddling-token path can open a sentence that never gets any width
  // (char_index == char_end). Drop those: they would highlight nothing and
  // split a neighbour in two.
  for (let i = out.length - 1; i >= 0; i--) {
    if (!out[i].text || !out[i].text.trim()) out.splice(i, 1);
  }
  // Tag each sentence with the kind of break that FOLLOWS it, which sizes the
// silence inserted after it:
  //   'sentence'  next sentence continues the same paragraph  -> short breath
  //   'paragraph' a blank line follows                         -> real pause
  //   'heading'   THIS sentence is a heading (no terminal punctuation) and a
  //               blank line follows                           -> longest pause
  // A heading is the case that needs the room: it carries no punctuation of its
  // own, so without the gap it is indistinguishable from the text after it.
  for (let i = 0; i < out.length; i++) {
    let kind = 'sentence';
    const nxt = out[i + 1];
    if (nxt && BLANK_LINE.test(fullText.slice(out[i].char_end, nxt.char_index))) {
      kind = HAS_TERMINAL.test(out[i].text) ? 'paragraph' : 'heading';
    }
    out[i].break_after = kind;
  }
  return out;
}

// Silence to insert, as {atMs, ms} sorted by position. Derived purely from the
// sentences, so timing and audio cannot disagree about how long the gaps are.
function pausePlan(sentences, durations = DEFAULT_PAUSES) {
  const pauses = [];
  for (let i = 0; i < sentences.length - 1; i++) {
    const ms = Number(durations[sentences[i].break_after] ?? 0);
    if (ms > 0) pauses.push({ atMs: sentences[i].end_ms, ms });
  }
  return pauses;
}


export { splitText, wordsFrom, sentencesFrom, endsSentence, pausePlan };
