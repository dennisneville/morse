/*
 * Morse core: code table, encoder (text to timed on/off segments),
 * signal detector (level samples to on/off segments) and an adaptive
 * decoder that copes with hand-keyed timing.
 *
 * No browser APIs in here, so it runs under Node for tests.
 */
(function (root) {
  'use strict';

  const CODE = {
    A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....',
    I: '..', J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.',
    Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-',
    Y: '-.--', Z: '--..',
    0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....',
    6: '-....', 7: '--...', 8: '---..', 9: '----.',
    '.': '.-.-.-', ',': '--..--', '?': '..--..', "'": '.----.', '!': '-.-.--',
    '/': '-..-.', '(': '-.--.', ')': '-.--.-', '&': '.-...', ':': '---...',
    ';': '-.-.-.', '=': '-...-', '+': '.-.-.', '-': '-....-', '_': '..--.-',
    '"': '.-..-.', '$': '...-..-', '@': '.--.-.',
  };

  // Prosigns that have no single-character equivalent in CODE.
  // (AR is the same as "+", BT the same as "=", so those decode as characters.)
  const PROSIGNS = {
    SK: '...-.-', SOS: '...---...', KN: '-.--.', ERR: '........', CT: '-.-.-', SN: '...-.',
  };

  const DECODE = {};
  for (const [k, v] of Object.entries(CODE)) DECODE[v] = k;
  // Prosigns only fill gaps; KN shares "(" so keep "(".
  for (const [k, v] of Object.entries(PROSIGNS)) if (!DECODE[v]) DECODE[v] = '<' + k + '>';

  /** Split text into sendable tokens: characters, prosigns (<SK>) and word breaks. */
  function tokenize(text) {
    const out = [];
    const s = String(text).toUpperCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (/\s/.test(ch)) {
        if (out.length && out[out.length - 1].type !== 'space') out.push({ type: 'space', text: ' ', src: i });
        while (i < s.length && /\s/.test(s[i])) i++;
        continue;
      }
      if (ch === '<') {
        const m = /^<([A-Z]{2,3})>/.exec(s.slice(i));
        if (m && PROSIGNS[m[1]]) {
          out.push({ type: 'char', text: m[0], code: PROSIGNS[m[1]], src: i });
          i += m[0].length;
          continue;
        }
      }
      if (CODE[ch]) out.push({ type: 'char', text: ch, code: CODE[ch], src: i });
      i++; // characters with no Morse equivalent are skipped
    }
    while (out.length && out[out.length - 1].type === 'space') out.pop();
    return out;
  }

  /** Dots and dashes for display, e.g. "SOS" -> "... --- ...". Words separated by " / ". */
  function toPattern(text) {
    return tokenize(text).map(t => (t.type === 'space' ? '/' : t.code)).join(' ');
  }

  /**
   * Timing in ms. wpm = character speed (PARIS standard, unit = 1200 / wpm).
   * fwpm = Farnsworth effective speed (<= wpm): characters stay at wpm, gaps stretch.
   */
  function timing(wpm, fwpm) {
    const u = 1200 / wpm;
    let letterGap = 3 * u, wordGap = 7 * u;
    if (fwpm && fwpm < wpm) {
      // ARRL Farnsworth formula: extra delay per word spread over the 19 gap units.
      const ta = (60 * wpm - 37.2 * fwpm) / (wpm * fwpm) * 1000;
      letterGap = (3 * ta) / 19;
      wordGap = (7 * ta) / 19;
    }
    return { unit: u, dot: u, dash: 3 * u, elementGap: u, letterGap, wordGap };
  }

  /**
   * Build an on/off schedule.
   * Returns { segments: [{on, start, dur, tok}], total, tokens }.
   * Segment times in ms from start; tok = index into tokens.
   */
  function schedule(text, wpm, fwpm) {
    const tm = timing(wpm, fwpm);
    const tokens = tokenize(text);
    const segments = [];
    let t = 0;
    tokens.forEach((tok, ti) => {
      if (tok.type === 'space') {
        // Replace the letter gap already added with a word gap.
        const last = segments[segments.length - 1];
        if (last && !last.on) { t -= last.dur; last.dur = tm.wordGap; t += last.dur; last.tok = ti; }
        return;
      }
      for (let e = 0; e < tok.code.length; e++) {
        const d = tok.code[e] === '.' ? tm.dot : tm.dash;
        segments.push({ on: true, start: t, dur: d, tok: ti });
        t += d;
        const gap = e < tok.code.length - 1 ? tm.elementGap : tm.letterGap;
        segments.push({ on: false, start: t, dur: gap, tok: ti });
        t += gap;
      }
    });
    // Drop the trailing gap so total ends at the last mark.
    if (segments.length && !segments[segments.length - 1].on) t -= segments.pop().dur;
    return { segments, total: t, tokens, timing: tm };
  }

  /* ---------------------------------------------------------------- */
  /* Detector: turns a stream of level samples into on/off segments.    */
  /* ---------------------------------------------------------------- */

  /**
   * opts.minContrast: smallest peak-floor difference that counts as a signal
   *   (dB for audio, 0..255 brightness for camera).
   * opts.debounce: ms a new state must hold before it is accepted.
   * opts.onSegment(on, durMs): called on each confirmed transition with the
   *   duration of the state that just ended.
   */
  class Detector {
    constructor(opts) {
      this.minContrast = opts.minContrast;
      this.debounce = opts.debounce || 0;
      this.onSegment = opts.onSegment || (() => {});
      this.reset();
    }
    reset() {
      this.floor = null;
      this.peak = null;
      this.dev = 0;
      this.state = false;
      this.stateSince = null;  // time the current state started
      this.candidate = null;   // time a pending flip first crossed the threshold
      this.lastT = null;
      this.level = 0;
      this.hasSignal = false;
    }
    get thresholds() {
      const span = this.peak - this.floor;
      const dev = this.dev || 0;
      return {
        on: this.floor + Math.max(0.5 * span, 0.8 * this.minContrast, 3.5 * dev),
        off: this.floor + Math.max(0.35 * span, 0.4 * this.minContrast, 2 * dev),
      };
    }
    push(t, level) {
      this.level = level;
      if (this.floor === null) {
        this.floor = level;
        this.dev = this.minContrast / 4;
        this.peak = level + this.minContrast;
        this.lastT = t;
        this.stateSince = t;
        this.startT = t;
        return;
      }
      const dt = Math.max(0, Math.min(200, t - this.lastT)) / 1000; // seconds
      this.lastT = t;
      const k = tc => 1 - Math.exp(-dt / tc); // smoothing factor for time constant tc

      // Track noise floor while off, signal peak while on. Fast toward the
      // extreme, slow back. Each also drifts slowly so the detector recovers
      // from a stuck light or a signal that stops.
      const th0 = this.thresholds;
      if (!this.state) {
        if (level < th0.on) {
          this.floor += (level - this.floor) * k(level < this.floor ? 0.1 : 0.4);
          // Typical noise wobble on the floor (mean absolute deviation).
          this.dev += (Math.abs(level - this.floor) - this.dev) * k(1);
        }
      } else {
        // While on, the floor creeps up; quickly if "on" has lasted far longer
        // than any Morse element (a steady tone or a light left on).
        this.floor += (level - this.floor) * k(t - this.stateSince > 2000 ? 0.7 : 15);
      }

      if (level > this.peak) this.peak += (level - this.peak) * k(0.02);
      else if (this.state) this.peak += (level - this.peak) * k(0.3);
      else this.peak += (this.floor + this.minContrast - this.peak) * k(8);

      if (this.peak < this.floor + this.minContrast) this.peak = this.floor + this.minContrast;
      this.hasSignal = this.peak - this.floor >= this.minContrast * 1.2;

      // Hysteresis: turn on above the on threshold, off below the off threshold.
      // A pending flip is only cancelled by a sample back past the other
      // threshold, so one noisy sample inside a dot does not lose it.
      const th = this.thresholds;
      if (t - this.startT < 300) { this.stateSince = t; return; } // learn the noise floor first
      if (this.candidate === null) {
        const flip = this.state ? level < th.off : level > th.on;
        if (flip) this.candidate = t;
      } else {
        const back = this.state ? level > th.on : level < th.off;
        if (back) this.candidate = null;
      }
      if (this.candidate !== null && t - this.candidate >= this.debounce) {
        const dur = this.candidate - this.stateSince;
        const was = this.state;
        this.state = !this.state;
        this.stateSince = this.candidate;
        this.candidate = null;
        if (dur > 0) this.onSegment(was, dur);
      }
    }
    /** How long the current state has lasted at time t. */
    elapsed(t) { return this.stateSince === null ? 0 : t - this.stateSince; }
    /** How long the line has been quiet, not counting a mark that is starting but not yet confirmed. */
    quietFor(t) {
      if (this.state || this.stateSince === null) return 0;
      return (this.candidate !== null ? this.candidate : t) - this.stateSince;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Decoder: on/off durations to text, adapting to the sender's speed. */
  /* ---------------------------------------------------------------- */

  /**
   * opts.wpm: 0 for auto speed, else a fixed speed.
   * opts.onText(str): called with each decoded character or ' '.
   * opts.onPattern(str): called when the in-progress dot/dash pattern changes.
   */
  class Decoder {
    constructor(opts = {}) {
      this.onText = opts.onText || (() => {});
      this.onPattern = opts.onPattern || (() => {});
      this.unit = 1200 / 15;
      this.setWpm(opts.wpm || 0);
      this.reset();
    }
    setWpm(wpm) {
      this.fixedWpm = wpm || 0;
      if (this.fixedWpm) this.unit = 1200 / this.fixedWpm;
      this.dashThreshold = 0;
    }
    reset() {
      this.marks = [];          // recent mark durations, for speed estimation
      this.gaps = [];           // recent gap durations, for letter and word gap estimation
      this.letterThreshold = 0;
      this.wordThreshold = 0;
      this.pattern = '';
      this.patternMarks = [];   // raw durations behind the current pattern
      this.elemGaps = [];       // recent gaps between elements, about one unit each
      this.prevGap = 0;
      this.pendingMark = null;  // mark waiting to see whether the next gap is a glitch
      this.heldGap = 0;
      this.gapLevel = 0;        // 0: nothing done for current gap, 1: letter flushed, 2: word space sent
      this.wroteText = false;
      this.warm = !!this.fixedWpm; // auto mode buffers a few elements to learn speed first
      this.buf = [];
      this.onPattern('');
    }
    get wpm() { return 1200 / this.unit; }
    get thresholds() {
      const u = this.unit;
      return {
        dash: this.dashThreshold || 2 * u,
        letter: this.letterThreshold || 2 * u,
        word: this.wordThreshold || 5 * u,
        glitch: Math.min(0.3 * u, 30),
      };
    }

    mark(d) {
      if (!this.warm) { this.buf.push([true, d]); this._tryWarm(false); return; }
      if (this.pendingMark !== null) this.pendingMark += this.heldGap + d;
      else this.pendingMark = d;
      this.heldGap = 0;
      this.gapLevel = 0;
    }

    gap(d) {
      if (!this.warm) {
        if (this.buf.length) { this.buf.push([false, d]); this._tryWarm(false); }
        return; // silence before the first mark tells us nothing
      }
      if (this.pendingMark !== null && d < this.thresholds.glitch) {
        this.heldGap = d; // dropout inside a mark: join it to the next mark
        return;
      }
      if (!this.fixedWpm && d < this.thresholds.letter) this._trackElementGap(d);
      this._handleGap(d);
      this.prevGap = d;
      if (!this.fixedWpm && !this.replaying) this._learnGap(d);
      this.gapLevel = 0;
    }

    /** Live update while the line is quiet, so letters appear without waiting for the next mark. */
    idle(d) {
      if (!this.warm) {
        if (!this.buf.length) return;
        const maxMark = Math.max(...this.buf.filter(e => e[0]).map(e => e[1]));
        if (d < Math.max(1000, 2.5 * maxMark)) return;
        this._tryWarm(true);
      }
      if (!this.fixedWpm && d > 6000 && this.wroteText) {
        // Long silence: likely a new transmission, maybe a new sender. Re-learn speed.
        this._handleGap(d);
        this.reset();
        return;
      }
      if (this.pendingMark === null && !this.pattern) {
        if (this.gapLevel < 2 && this.wroteText && d >= this.thresholds.word) { this.gapLevel = 2; this.onText(' '); }
        return;
      }
      if (this.pendingMark !== null && d < this.thresholds.glitch) return;
      this._handleGap(d);
    }

    _handleGap(d) {
      if (this.pendingMark !== null) {
        this._commitMark(this.pendingMark);
        this.pendingMark = null;
        this.heldGap = 0;
      }
      const th = this.thresholds;
      if (this.gapLevel < 1 && d >= th.letter) {
        this.gapLevel = 1;
        this._flushLetter();
      }
      if (this.gapLevel < 2 && d >= th.word) {
        this.gapLevel = 2;
        if (this.wroteText) this.onText(' ');
      }
    }

    _commitMark(d) {
      const isDash = d >= this.thresholds.dash;
      this.pattern += isDash ? '-' : '.';
      this.patternMarks.push({ d, gap: this.prevGap });
      this.onPattern(this.pattern);
      this._learn(d, isDash);
    }

    _flushLetter() {
      if (!this.pattern) return;
      const ch = DECODE[this.pattern] || '?';
      this.pattern = '';
      this.patternMarks = [];
      this.onPattern('');
      this.wroteText = true;
      this.onText(ch);
    }

    /**
     * Auto mode start-up: hold the first elements until the speed is clear,
     * then estimate it and replay them, so the first letters decode properly.
     */
    _tryWarm(force) {
      const marks = this.buf.filter(e => e[0]).map(e => e[1]);
      if (!marks.length) { if (force) this.buf = []; return; }
      const split = otsu(marks);
      const bimodal = split && split.ratio >= 2 && split.i >= 2 && marks.length - split.i >= 2;
      if (!bimodal && marks.length < 10 && !force) return;

      if (split && split.ratio >= 1.9) {
        this.unit = (split.lo * split.i + (split.hi / 3) * (marks.length - split.i)) / marks.length;
        this.dashThreshold = Math.sqrt(split.lo * split.hi);
      } else {
        // One kind of mark only. Compare with the shortest gaps (element gaps, about one unit).
        const m = marks.reduce((a, b) => a + b, 0) / marks.length;
        const gaps = this.buf.filter(e => !e[0]).map(e => e[1]).sort((a, b) => a - b);
        const g = gaps.length ? gaps[Math.floor(gaps.length * 0.2)] : this.unit;
        this.unit = m > 2 * g ? m / 3 : m;
        this.dashThreshold = 0;
      }
      this.unit = clampUnit(this.unit);
      const buf = this.buf;
      this.buf = [];
      this.warm = true;
      for (const [on, d] of buf) if (!on) this._learnGap(d);
      this.replaying = true;
      for (const [on, d] of buf) (on ? this.mark(d) : this.gap(d));
      this.replaying = false;
    }

    /**
     * Gaps between elements are about one unit whatever the sender does with
     * letter and word spacing, so they reveal a sudden change of speed sooner
     * than the dot/dash statistics do.
     */
    _trackElementGap(d) {
      this.elemGaps.push(d);
      if (this.elemGaps.length > 5) this.elemGaps.shift();
      if (this.elemGaps.length < 3) return;
      const sorted = [...this.elemGaps].sort((a, b) => a - b);
      const med = sorted[Math.floor(sorted.length / 2)];
      const r = med / this.unit;
      if (r > 0.6 && r < 1.6) return;
      this.unit = clampUnit(med);
      this.elemGaps = [];
      this.dashThreshold = 0;
      this.marks = [];
      this.gaps = [];
      this.letterThreshold = 0;
      this.wordThreshold = 0;
      // Re-read the letter in progress at the new speed. At the old speed its
      // letter gaps may have looked like element gaps, so split it again.
      const marks = this.patternMarks;
      this.pattern = '';
      this.patternMarks = [];
      marks.forEach((m, i) => {
        if (i > 0 && m.gap >= 2 * this.unit) {
          this._flushLetter();
          if (m.gap >= 5 * this.unit && this.wroteText) this.onText(' ');
        }
        this.pattern += m.d >= 2 * this.unit ? '-' : '.';
        this.patternMarks.push(m);
      });
      this.onPattern(this.pattern);
    }

    /** Update the speed estimate from recent marks (auto mode only). */
    _learn(d, isDash) {
      if (this.fixedWpm) return;
      this.marks.push(d);
      if (this.marks.length > 24) this.marks.shift();
      const split = otsu(this.marks);
      if (split && split.ratio >= 1.9) {
        // Two clear groups: dots and dashes. Weight by count so a long run of
        // one type does not swamp the estimate.
        const n = this.marks.length;
        const target = (split.lo * split.i + (split.hi / 3) * (n - split.i)) / n;
        this.unit += (target - this.unit) * 0.5;
        this.dashThreshold = Math.sqrt(split.lo * split.hi);
      } else {
        // Only one kind seen lately: nudge the unit using this mark's classification.
        const target = isDash ? d / 3 : d;
        this.unit += (target - this.unit) * 0.3;
        this.dashThreshold = 0;
      }
      this.unit = clampUnit(this.unit);
    }

    /**
     * Gaps come in three sizes: between elements (1 unit), letters (3) and
     * words (7). Farnsworth and hand senders stretch or squeeze them, so
     * split the gaps actually seen: first element gaps from the rest, then
     * letter gaps from word gaps. Thresholds sit between the group means.
     */
    _learnGap(d) {
      // A pause between transmissions is not a word gap; keep it out of the stats.
      if (this.wordThreshold && d > 3 * this.wordThreshold) return;
      this.gaps.push(d);
      if (this.gaps.length > 40) this.gaps.shift();
      if (this.gaps.length < 6) return;
      const u = this.unit;
      const s1 = otsu(this.gaps);
      if (!s1 || s1.ratio < 2) return;
      const e = s1.lo;
      const long = this.gaps.filter(g => g > Math.sqrt(s1.lo * s1.hi));
      const s2 = otsu(long);
      let l, w;
      if (s2 && s2.ratio >= 1.7 && long.length - s2.i >= 1) { l = s2.lo; w = s2.hi; }
      else { l = s1.hi; w = Math.max(7 * e, 2.3 * l); } // one group: letter gaps are far more common
      this.letterThreshold = Math.max(1.4 * u, Math.min(6 * u, Math.sqrt(e * l)));
      this.wordThreshold = Math.max(1.5 * this.letterThreshold, Math.sqrt(l * w));
    }
  }

  function clampUnit(u) { return Math.max(20, Math.min(400, u)); } // 3 to 60 WPM

  /** Best two-group split of durations (on a log scale). Returns group means and ratio. */
  function otsu(values) {
    const logs = values.map(Math.log).sort((a, b) => a - b);
    const n = logs.length;
    if (n < 2) return null;
    const total = logs.reduce((a, b) => a + b, 0);
    let left = 0, best = null;
    for (let i = 1; i < n; i++) {
      left += logs[i - 1];
      const m1 = left / i, m2 = (total - left) / (n - i);
      const score = i * (n - i) * (m2 - m1) * (m2 - m1);
      if (!best || score > best.score) best = { score, m1, m2, i };
    }
    return { i: best.i, lo: Math.exp(best.m1), hi: Math.exp(best.m2), ratio: Math.exp(best.m2 - best.m1) };
  }

  const api = { CODE, PROSIGNS, DECODE, tokenize, toPattern, timing, schedule, Detector, Decoder };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Morse = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
