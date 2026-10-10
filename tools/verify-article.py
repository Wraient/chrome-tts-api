#!/usr/bin/env python3
"""Verify a real article's read-along alignment against a running server.

    python3 tools/verify-article.py path/to/article.txt [more.txt ...]

Run it on the output of whatever extracts text from a URL (Readability, etc.)
before wiring the result into a player. It catches the failures that matter for
highlighting: spans that skip characters, split in the wrong place, or disagree
with the audio.

Asserts, per article:
  * sentence spans cover exactly the same characters as the input. The
    comparison is whitespace-insensitive because spans can be exactly adjacent,
    so joining them with a separator invents a space the source never had;
    exact spacing is pinned by the gap and edge checks instead.
  * spans are ordered, non-overlapping, and leave no non-whitespace in a gap
  * nothing real sits before the first or after the last span
  * word timings are monotonic, and no word starts after the audio ends
  * every word falls inside some sentence

Then reports quality outliers: over-split (<3 words), oversized (>70 words),
and missed terminators. "Missed" is a sentence of more than six words with no
terminal punctuation; shorter unpunctuated spans are reported separately as
headings, which are legitimately unpunctuated. Long section titles still show
up as misses, so read the samples rather than trusting the count.

Needs the server up (`node server.mjs 3733`). Synthesis is ~5-6x realtime, so
a 20k-word article takes ~25 minutes.
"""
import functools
import json
import os
import re
import sys
import time
import urllib.request

print = functools.partial(print, flush=True)

URL = "http://127.0.0.1:3733/tts"
TERMINAL = re.compile(r'[.!?…][”"’\')\]]*$')
FOOTER = ('Back to top', 'Privacy policy')


def clean(path):
    t = open(path, encoding='utf-8').read()
    lines = t.split('\n')
    # drop a title duplicated by the extractor
    if len(lines) > 1 and lines[0] == lines[1]:
        lines.pop(0)
    return '\n'.join(l for l in lines if l.strip() not in FOOTER).strip()


def fetch(text):
    body = json.dumps({"text": text, "format": "timings"}).encode()
    req = urllib.request.Request(URL, data=body,
                                 headers={'Content-Type': 'application/json'})
    return json.loads(urllib.request.urlopen(req, timeout=7200).read())


def verify(label, text):
    print(f"[start] {label}: {len(text)} chars")
    t0 = time.time()
    d = fetch(text)
    wall = time.time() - t0
    norm, sents, words = d['text'], d['sentences'], d['words']
    dur = d['duration_ms']
    problems = []

    # 1. no real character is lost or duplicated by the spans
    recon = "".join(norm[s['char_index']:s['char_end']] for s in sents)
    if re.sub(r'\s+', '', recon) != re.sub(r'\s+', '', norm):
        problems.append("SPANS DO NOT COVER THE SAME CHARACTERS AS THE INPUT")

    # 2. ordered, non-overlapping, gap-free of real text
    for i in range(1, len(sents)):
        a, b = sents[i - 1], sents[i]
        if b['char_index'] <= a['char_index']:
            problems.append(f"order violated at sentence {i}")
        if b['char_index'] < a['char_end']:
            problems.append(f"overlap at sentence {i}")
        if norm[a['char_end']:b['char_index']].strip():
            problems.append(f"gap with text at sentence {i}: "
                            f"{norm[a['char_end']:b['char_index']][:40]!r}")

    # 3. nothing real left outside the first/last span
    if sents and (norm[:sents[0]['char_index']].strip()
                  or norm[sents[-1]['char_end']:].strip()):
        problems.append("text uncovered before the first or after the last sentence")

    # 4. timings monotonic; words inside the audio
    for i in range(1, len(sents)):
        if sents[i]['start_ms'] < sents[i - 1]['end_ms'] - 60:
            problems.append(f"timing regression at sentence {i}")
    if [w for w in words if w['start_ms'] > dur + 500]:
        problems.append("words start after the audio ends")
    if [w for w in words
            if not any(s['char_index'] <= w['char_index'] < s['char_end'] for s in sents)]:
        problems.append("words fall outside every sentence span")

    # 5. quality outliers
    tiny = [s for s in sents if len(s['text'].split()) < 3]
    huge = [s for s in sents if len(s['text'].split()) > 70]
    # A sentence with no terminal punctuation is either a heading (legitimately
    # unpunctuated) or a terminator we missed. Short ones are headings; only a
    # long unpunctuated span suggests a real miss.
    unpunctuated = [s for s in sents[:-1] if not TERMINAL.search(s['text'].rstrip())]
    headings = [s for s in unpunctuated if len(s['text'].split()) <= 6]
    dangling = [s for s in unpunctuated if len(s['text'].split()) > 6]
    wc = [len(s['text'].split()) for s in sents]

    print(f"\n{'='*74}\n{label}")
    print(f"  chars {len(norm):>7}   words {len(norm.split()):>6}   sentences {len(sents):>5}")
    print(f"  audio  {dur/60000:>6.1f} min   wall {wall/60:>5.1f} min"
          f"   ({dur/1000/max(wall, 0.01):.1f}x realtime)")
    print(f"  last sentence ends {dur - sents[-1]['end_ms']} ms before audio end")
    print(f"  avg {len(norm.split())/len(sents):.1f} words/sentence"
          f"   max {max(wc)}   min {min(wc)}")
    print(f"  over-split (<3 words): {len(tiny)}")
    print(f"  oversized  (>70 words): {len(huge)}")
    print(f"  headings (short, unpunctuated): {len(headings)}")
    print(f"  MISSED SPLITS (>6 words, no terminal punctuation): {len(dangling)}")
    for s in tiny[:4]:
        print(f"      tiny: {s['text']!r}")
    for s in huge[:3]:
        print(f"      HUGE: {s['text'][:150]!r}")
    for s in dangling[:6]:
        print(f"      MISSED: ...{s['text'][-90:]!r}")
    print(f"  PROBLEMS: {len(problems)}")
    for p in problems[:10]:
        print(f"      !! {p}")
    return not problems


if __name__ == "__main__":
    ok_all = True
    for path in (sys.argv[1:] or ['/tmp/adol.txt', '/tmp/mlg.txt']):
        try:
            ok_all &= verify(os.path.basename(path), clean(path))
        except Exception as e:
            ok_all = False
            print(f"\n{path}: FETCH FAILED: {type(e).__name__}: {e}")
    print(f"\n{'='*74}\n{'ALL CHECKS PASSED' if ok_all else 'FAILURES PRESENT'}")
    sys.exit(0 if ok_all else 1)