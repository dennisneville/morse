// Run with: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const M = require('../morse.js');

// Small seeded PRNG so failures are reproducible.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }

/** Feed a schedule straight into the decoder as durations, with optional jitter. */
function decodeSegments(segments, opts = {}) {
  let out = '';
  const d = new M.Decoder({ wpm: opts.wpm || 0, onText: c => (out += c) });
  for (const s of segments) (s.on ? d.mark(s.dur) : d.gap(s.dur));
  d.idle(10000); // long silence at the end flushes the last letter
  return out.trim();
}

/** Hand-keyed variation: marks and gaps scaled randomly, plus a drifting speed. */
function handKey(segments, seed, markJitter, gapJitter) {
  const r = rng(seed);
  let drift = 1;
  return segments.map(s => {
    drift = Math.max(0.8, Math.min(1.25, drift + gauss(r) * 0.005));
    const j = s.on ? markJitter : gapJitter;
    const f = Math.max(0.4, 1 + gauss(r) * j);
    return { on: s.on, dur: s.dur * f * drift };
  });
}

const PHRASE = 'THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG 0123456789';

test('every character round-trips through encode and decode', () => {
  const chars = Object.keys(M.CODE).join(' ');
  const sch = M.schedule(chars, 20);
  assert.strictEqual(decodeSegments(sch.segments, { wpm: 20 }), chars);
});

test('pattern display', () => {
  assert.strictEqual(M.toPattern('SOS'), '... --- ...');
  assert.strictEqual(M.toPattern('hi  there'), '.... .. / - .... . .-. .');
  assert.strictEqual(M.toPattern('<SK>'), '...-.-');
});

test('unknown characters are skipped, whitespace collapses', () => {
  assert.deepStrictEqual(M.tokenize(' a#b \n\n c ').map(t => t.text), ['A', 'B', ' ', 'C']);
});

test('timing: PARIS is 50 units, Farnsworth stretches gaps only', () => {
  const sch = M.schedule('PARIS', 20);
  // PARIS + word gap = 50 units = 60 s / 20 wpm = 3 s
  assert.ok(Math.abs(sch.total + sch.timing.wordGap - 3000) < 1e-6);
  const f = M.timing(20, 10);
  assert.strictEqual(f.dot, 60);
  assert.ok(f.letterGap > 3 * 60 && f.wordGap > 7 * 60);
  // At 10 wpm effective, PARIS + word gap should take 6 s.
  const sf = M.schedule('PARIS', 20, 10);
  assert.ok(Math.abs(sf.total + sf.timing.wordGap - 6000) < 1);
});

for (const wpm of [5, 10, 15, 20, 25, 30]) {
  test(`auto speed, perfect timing at ${wpm} WPM`, () => {
    const sch = M.schedule(PHRASE, wpm);
    assert.strictEqual(decodeSegments(sch.segments), PHRASE);
  });
}

test('auto speed, hand-keyed timing (12% mark jitter, 15% gap jitter)', () => {
  let totalChars = 0, errors = 0;
  for (const wpm of [8, 12, 18, 25]) {
    for (let seed = 1; seed <= 5; seed++) {
      const sch = M.schedule(PHRASE, wpm);
      const got = decodeSegments(handKey(sch.segments, seed * 100 + wpm, 0.12, 0.15));
      totalChars += PHRASE.length;
      errors += editDistance(got, PHRASE);
    }
  }
  const rate = errors / totalChars;
  console.log(`  hand-keyed character error rate: ${(rate * 100).toFixed(2)}%`);
  assert.ok(rate < 0.03, `error rate ${rate}`);
});

test('auto speed follows a sender who speeds up mid-message', () => {
  const a = M.schedule('SLOW START HERE', 10).segments;
  const b = M.schedule('NOW MUCH FASTER TEXT', 20).segments;
  const segs = [...a, { on: false, dur: 7 * 120 }, ...b];
  const got = decodeSegments(segs);
  assert.ok(editDistance(got, 'SLOW START HERE NOW MUCH FASTER TEXT') <= 3, got);
});

test('Farnsworth-spaced sending decodes', () => {
  const sch = M.schedule(PHRASE, 20, 10);
  assert.strictEqual(decodeSegments(sch.segments), PHRASE);
});

test('short dropouts inside a mark are bridged', () => {
  const segs = [];
  for (const s of M.schedule('TEST', 15).segments) {
    if (s.on && s.dur > 100) {
      segs.push({ on: true, dur: s.dur / 2 - 6 }, { on: false, dur: 12 }, { on: true, dur: s.dur / 2 - 6 });
    } else segs.push(s);
  }
  assert.strictEqual(decodeSegments(segs, { wpm: 15 }), 'TEST');
});

test('prosigns decode', () => {
  assert.strictEqual(decodeSegments(M.schedule('<SK> <SOS>', 15).segments), '<SK> <SOS>');
});

/** Full pipeline: render a schedule to noisy level samples, run detector + decoder. */
function pipeline(text, wpm, { sampleMs, onLevel, offLevel, noise, contrast, debounce, seed, jitter }) {
  const r = rng(seed);
  let segs = M.schedule(text, wpm).segments;
  if (jitter) segs = handKey(segs, seed, 0.12, 0.15);
  let out = '';
  const dec = new M.Decoder({ onText: c => (out += c) });
  const det = new M.Detector({
    minContrast: contrast, debounce,
    onSegment: (on, dur) => (on ? dec.mark(dur) : dec.gap(dur)),
  });
  // 1.5 s of silence first so the detector learns the floor.
  const timeline = [{ on: false, dur: 1500 }, ...segs, { on: false, dur: 3000 }];
  let t = 0, segStart = 0, i = 0;
  const end = timeline.reduce((a, s) => a + s.dur, 0);
  for (t = 0; t < end; t += sampleMs) {
    while (t >= segStart + timeline[i].dur) { segStart += timeline[i].dur; i++; }
    const level = (timeline[i].on ? onLevel : offLevel) + gauss(r) * noise;
    det.push(t, level);
    if (!det.state) dec.idle(det.quietFor(t));
  }
  return out.trim();
}

test('audio-like pipeline: 8 ms blocks, 20 dB contrast with 3 dB noise', () => {
  for (const wpm of [10, 20, 30]) {
    const got = pipeline(PHRASE, wpm, { sampleMs: 8, onLevel: -40, offLevel: -60, noise: 3, contrast: 8, debounce: 10, seed: wpm });
    assert.ok(editDistance(got, PHRASE) <= 1, `${wpm} wpm: ${got}`);
  }
});

test('audio-like pipeline, hand keyed', () => {
  const got = pipeline(PHRASE, 15, { sampleMs: 8, onLevel: -35, offLevel: -60, noise: 3, contrast: 8, debounce: 10, seed: 7, jitter: true });
  assert.ok(editDistance(got, PHRASE) <= 2, got);
});

test('camera-like pipeline: 30 fps frames at 12 WPM', () => {
  const got = pipeline(PHRASE, 12, { sampleMs: 1000 / 30, onLevel: 200, offLevel: 60, noise: 4, contrast: 15, debounce: 0, seed: 3 });
  assert.ok(editDistance(got, PHRASE) <= 1, got);
});

test('detector ignores a steady signal with no flashing', () => {
  let segments = 0;
  const det = new M.Detector({ minContrast: 12, onSegment: () => segments++ });
  const r = rng(1);
  for (let t = 0; t < 10000; t += 33) det.push(t, 120 + gauss(r) * 2);
  assert.strictEqual(segments, 0);
});

function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}
