/* Morse web app: UI, camera and microphone receivers, screen and sound senders. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);

  /* ------------------------------ Settings ------------------------------ */
  const DEFAULTS = {
    tab: 'receive', source: 'camera',
    rxAutoSpeed: true, rxWpm: 15, rxAutoTone: true, rxTone: 700,
    txWpm: 15, txFwpm: 15, txTone: 700, txVol: 0.6, flash: '#ffffff', repeat: false, out: 'sound', txText: '',
  };
  const KEY = 'morse.settings.v1';
  let S = { ...DEFAULTS };
  try { Object.assign(S, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { /* storage blocked */ }
  let saveTimer = 0;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* ignore */ } }, 200);
  }

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  /* Screen wake lock, shared by receive and send. */
  const wake = {
    holders: new Set(), lock: null,
    async get(who) {
      this.holders.add(who);
      if (this.lock || !('wakeLock' in navigator)) return;
      try { this.lock = await navigator.wakeLock.request('screen'); this.lock.addEventListener('release', () => (this.lock = null)); } catch (e) { /* not allowed */ }
    },
    release(who) {
      this.holders.delete(who);
      if (!this.holders.size && this.lock) { this.lock.release().catch(() => {}); this.lock = null; }
    },
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && wake.holders.size && !wake.lock) wake.get([...wake.holders][0]);
  });

  /* -------------------------------- Tabs -------------------------------- */
  function setTab(tab) {
    S.tab = tab; save();
    for (const t of ['receive', 'send']) {
      $('tab-' + t).setAttribute('aria-selected', String(t === tab));
      $(t).hidden = t !== tab;
    }
    if (tab === 'receive') requestAnimationFrame(sizeScope);
  }
  $('tab-receive').onclick = () => setTab('receive');
  $('tab-send').onclick = () => setTab('send');

  function segmented(el, value, onChange) {
    const btns = [...el.querySelectorAll('button')];
    const set = v => btns.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
    set(value);
    btns.forEach(b => (b.onclick = () => { set(b.dataset.v); onChange(b.dataset.v); }));
    return set;
  }

  /* ====================================================================== */
  /*                                RECEIVE                                 */
  /* ====================================================================== */

  const rx = {
    running: false, source: S.source, stream: null,
    det: null, dec: null, ac: null, worklet: null, analyser: null,
    tone: 0, toneVotes: null, roi: null, loopId: 0, statusTimer: 0, error: '',
    hist: [], // recent samples for the scope
  };

  const decodedEl = $('decoded');
  const patternEl = $('pattern');
  const pretty = p => p.replace(/\./g, '·').replace(/-/g, '−');

  function appendText(ch) {
    if (ch === ' ' && (!decodedEl.textContent || decodedEl.textContent.endsWith(' '))) return;
    let t = decodedEl.textContent + ch;
    if (t.length > 4000) t = t.slice(-3500);
    decodedEl.textContent = t;
    decodedEl.scrollTop = decodedEl.scrollHeight;
  }

  function makePipeline(kind) {
    rx.dec = new Morse.Decoder({
      wpm: S.rxAutoSpeed ? 0 : S.rxWpm,
      onText: appendText,
      onPattern: p => (patternEl.textContent = pretty(p)),
    });
    rx.det = new Morse.Detector({
      minContrast: kind === 'mic' ? 10 : 15,
      debounce: kind === 'mic' ? 10 : 0,
      onSegment: (on, dur) => (on ? rx.dec.mark(dur) : rx.dec.gap(dur)),
    });
    rx.hist = [];
  }

  function pushSample(t, level) {
    const det = rx.det;
    det.push(t, level);
    if (!det.state) rx.dec.idle(det.quietFor(t));
    const th = det.thresholds;
    rx.hist.push({ t, level, on: th.on, off: th.off, floor: det.floor, peak: det.peak, state: det.state });
    const cutoff = t - 6000;
    let drop = 0;
    while (drop < rx.hist.length && rx.hist[drop].t < cutoff) drop++;
    if (drop > 200) rx.hist.splice(0, drop);
  }

  segmented($('source'), S.source, v => {
    S.source = v; save();
    const was = rx.running;
    if (was) stopReceive();
    rx.source = v;
    updateSourceUI();
    if (was) startReceive();
  });

  function updateSourceUI() {
    const cam = rx.source === 'camera';
    $('cam').hidden = !cam;
    $('toneSetting').hidden = cam;
    $('roiClear').hidden = !(cam && rx.running && rx.roi);
  }

  $('rxStart').onclick = () => (rx.running ? stopReceive() : startReceive());

  async function startReceive() {
    rx.error = '';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showError('This browser cannot use the camera or microphone here. Open the page over https in Chrome.');
      return;
    }
    rx.running = true;
    $('rxStart').textContent = 'Stop';
    makePipeline(rx.source);
    try {
      if (rx.source === 'camera') await startCamera();
      else await startMic();
    } catch (e) {
      stopReceive();
      const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      showError(denied
        ? `${rx.source === 'camera' ? 'Camera' : 'Microphone'} access is blocked. Allow it in the browser's site settings, then try again.`
        : `Could not start the ${rx.source === 'camera' ? 'camera' : 'microphone'}: ${e && e.message ? e.message : e}`);
      return;
    }
    wake.get('rx');
    updateSourceUI();
    clearInterval(rx.statusTimer);
    rx.statusTimer = setInterval(updateStatus, 250);
    updateStatus();
    drawScopeLoop();
  }

  function stopReceive() {
    rx.running = false;
    $('rxStart').textContent = 'Start';
    cancelAnimationFrame(rx.loopId);
    if (rx.videoCb && $('video').cancelVideoFrameCallback) $('video').cancelVideoFrameCallback(rx.videoCb);
    rx.videoCb = 0;
    clearInterval(rx.statusTimer);
    clearInterval(rx.toneTimer);
    if (rx.stream) rx.stream.getTracks().forEach(t => t.stop());
    rx.stream = null;
    if (rx.ac) rx.ac.close().catch(() => {});
    rx.ac = null; rx.worklet = null; rx.analyser = null;
    const v = $('video');
    v.srcObject = null;
    $('camIdle').hidden = false;
    $('camHint').hidden = true;
    if (rx.dec) rx.dec.idle(1e9); // flush any letter in progress
    patternEl.textContent = '';
    wake.release('rx');
    updateSourceUI();
    if (!rx.error) setStatus('<span class="wait">Not listening</span>');
  }

  function showError(msg) {
    rx.error = msg;
    setStatus(`<span class="err">▲ ${escapeHtml(msg)}</span>`);
  }
  function setStatus(html) { $('rxStatus').innerHTML = html; }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function updateStatus() {
    if (!rx.running) return;
    const parts = [];
    const sig = rx.det && rx.det.hasSignal;
    if (rx.source === 'mic' && !rx.tone) parts.push('<span class="wait">Listening for a tone…</span>');
    else parts.push(sig ? '<span class="ok">✓ Signal</span>' : `<span class="wait">${rx.source === 'camera' ? 'Watching for flashes…' : 'Listening…'}</span>`);
    if (rx.source === 'mic' && rx.tone) parts.push(`<span>${Math.round(rx.tone)} Hz${S.rxAutoTone ? '' : ' (set)'}</span>`);
    if (rx.source === 'camera' && rx.fps) parts.push(`<span>${Math.round(rx.fps)} fps</span>`);
    if (rx.dec && rx.dec.warm) parts.push(`<span>about ${Math.round(rx.dec.wpm)} WPM${S.rxAutoSpeed ? '' : ' (set)'}</span>`);
    setStatus(parts.join(''));
  }

  /* ------------------------------- Camera ------------------------------- */

  const SMALL_W = 96; // analysis width in pixels; small keeps it fast
  let smallCanvas, smallCtx;

  async function startCamera() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60, min: 15 } },
    }).catch(() => navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' } } }));
    rx.stream = stream;
    const v = $('video');
    v.srcObject = stream;
    await v.play();
    const vw = v.videoWidth || 640, vh = v.videoHeight || 480;
    $('cam').style.aspectRatio = `${vw} / ${vh}`;
    smallCanvas = smallCanvas || document.createElement('canvas');
    smallCanvas.width = SMALL_W;
    smallCanvas.height = Math.max(1, Math.round(SMALL_W * vh / vw));
    smallCtx = smallCanvas.getContext('2d', { willReadFrequently: true });
    $('camIdle').hidden = true;
    $('camHint').hidden = false;
    rx.frameTimes = [];
    placeRoi();
    scheduleFrame();
  }

  function scheduleFrame() {
    const v = $('video');
    if (!rx.running) return;
    if (v.requestVideoFrameCallback) rx.videoCb = v.requestVideoFrameCallback(onFrame);
    else rx.loopId2 = requestAnimationFrame(t => onFrame(t, null));
  }

  let lastMediaTime = -1;
  function onFrame(now, meta) {
    if (!rx.running || rx.source !== 'camera') return;
    const v = $('video');
    // Skip repeats of the same camera frame (rAF fallback can run faster than the camera).
    const mt = meta ? meta.mediaTime : v.currentTime;
    if (mt === lastMediaTime) { scheduleFrame(); return; }
    lastMediaTime = mt;
    const t = meta && meta.captureTime ? meta.captureTime : now;

    const W = smallCanvas.width, H = smallCanvas.height;
    smallCtx.drawImage(v, 0, 0, W, H);
    const px = smallCtx.getImageData(0, 0, W, H).data;
    pushSample(t, brightness(px, W, H));

    rx.frameTimes.push(t);
    if (rx.frameTimes.length > 30) rx.frameTimes.shift();
    if (rx.frameTimes.length > 5) rx.fps = 1000 * (rx.frameTimes.length - 1) / (t - rx.frameTimes[0]);
    scheduleFrame();
  }

  // Brightness of the light: the mean of the brightest pixels, either in the
  // tapped box or across the whole frame. Using the brightest pixels rather
  // than the average keeps a small light visible against a large background.
  const histo = new Uint32Array(256);
  function brightness(px, W, H) {
    let x0 = 0, y0 = 0, x1 = W, y1 = H, frac = 0.03;
    if (rx.roi) {
      const half = Math.max(3, Math.round(W * 0.08));
      const cx = Math.round(rx.roi.x * W), cy = Math.round(rx.roi.y * H);
      x0 = Math.max(0, cx - half); x1 = Math.min(W, cx + half + 1);
      y0 = Math.max(0, cy - half); y1 = Math.min(H, cy + half + 1);
      frac = 0.25;
    }
    histo.fill(0);
    let n = 0;
    for (let y = y0; y < y1; y++) {
      let i = (y * W + x0) * 4;
      for (let x = x0; x < x1; x++, i += 4) {
        histo[(px[i] * 2 + px[i + 1] * 5 + px[i + 2]) >> 3]++;
        n++;
      }
    }
    let want = Math.max(1, Math.round(n * frac)), sum = 0, got = 0;
    for (let b = 255; b >= 0 && got < want; b--) {
      const take = Math.min(histo[b], want - got);
      sum += take * b; got += take;
    }
    return sum / got;
  }

  $('cam').addEventListener('click', e => {
    if (!rx.running || rx.source !== 'camera') return;
    const r = $('cam').getBoundingClientRect();
    rx.roi = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    placeRoi();
    rx.det.reset();
    $('camHint').hidden = true;
    updateSourceUI();
  });
  $('roiClear').onclick = () => {
    rx.roi = null; placeRoi(); if (rx.det) rx.det.reset();
    $('camHint').hidden = !rx.running;
    updateSourceUI();
  };
  function placeRoi() {
    const box = $('roi');
    if (!rx.roi || !smallCanvas) { box.style.display = 'none'; return; }
    const W = smallCanvas.width, H = smallCanvas.height;
    const half = Math.max(3, Math.round(W * 0.08)) + 0.5;
    box.style.display = 'block';
    box.style.left = `${(rx.roi.x - half / W) * 100}%`;
    box.style.top = `${(rx.roi.y - half / H) * 100}%`;
    box.style.width = `${(2 * half / W) * 100}%`;
    box.style.height = `${(2 * half / H) * 100}%`;
  }

  /* ----------------------------- Microphone ----------------------------- */

  // Runs on the audio thread: measures the strength of one frequency in
  // 8 ms blocks (Goertzel filter) and posts [time, power, time, power, ...].
  // Runs on the audio thread: measures the strength of one frequency in
  // 8 ms blocks (Goertzel filter) and posts {gen, data: [time, power, ...]}.
  // Keeps the last 3 s of raw audio so that, once the tone is found, the start
  // of the message can be re-measured at the right pitch instead of lost.
  const WORKLET = `
  class ToneMeter extends AudioWorkletProcessor {
    constructor() {
      super();
      this.N = Math.round(sampleRate * 0.008);
      this.ring = new Float32Array(Math.round(sampleRate * 3));
      this.w = 0; this.count = 0; this.end = 0;
      this.gen = 0;
      this.setFreq(700);
      this.out = [];
      this.port.onmessage = e => {
        const m = e.data || {};
        if (!m.freq) return;
        this.gen = m.gen; this.setFreq(m.freq); this.out = [];
        if (m.replay) this.replay();
      };
    }
    setFreq(f) { this.coeff = 2 * Math.cos(2 * Math.PI * f / sampleRate); this.s1 = 0; this.s2 = 0; this.n = 0; }
    replay() {
      const L = this.ring.length, n = Math.min(this.count, L), N = this.N, c = this.coeff, data = [];
      let s1 = 0, s2 = 0, k = 0;
      for (let j = 0; j < n; j++) {
        const x = this.ring[(this.w - n + j + L) % L];
        const s0 = x + c * s1 - s2; s2 = s1; s1 = s0;
        if (++k >= N) {
          data.push(this.end - (n - j - 1) / sampleRate, (s1 * s1 + s2 * s2 - c * s1 * s2) / (N * N));
          s1 = 0; s2 = 0; k = 0;
        }
      }
      this.port.postMessage({ gen: this.gen, data });
    }
    process(inputs) {
      const ch = inputs[0] && inputs[0][0];
      if (ch) {
        const L = this.ring.length;
        for (let i = 0; i < ch.length; i++) {
          const x = ch[i];
          if (!this.live) { if (x === 0) continue; this.live = true; } // skip start-up silence
          this.ring[this.w] = x; this.w = (this.w + 1) % L;
          this.count++;
          const s0 = x + this.coeff * this.s1 - this.s2;
          this.s2 = this.s1; this.s1 = s0;
          if (++this.n >= this.N) {
            const p = (this.s1 * this.s1 + this.s2 * this.s2 - this.coeff * this.s1 * this.s2) / (this.N * this.N);
            this.out.push(currentTime + (i + 1) / sampleRate, p);
            this.s1 = 0; this.s2 = 0; this.n = 0;
          }
        }
        this.end = currentTime + ch.length / sampleRate;
        if (this.out.length >= 8) { this.port.postMessage({ gen: this.gen, data: this.out }); this.out = []; }
      }
      return true;
    }
  }
  registerProcessor('tone-meter', ToneMeter);`;

  async function startMic() {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    rx.stream = stream;
    const ac = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    rx.ac = ac;
    if (ac.state === 'suspended') await ac.resume();
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    await ac.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const src = ac.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ac, 'tone-meter', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    const mute = ac.createGain();
    mute.gain.value = 0;
    src.connect(node); node.connect(mute); mute.connect(ac.destination); // keeps the node running, silently
    rx.worklet = node;
    rx.gen = 0;
    node.port.onmessage = e => {
      const { gen, data } = e.data;
      if (!rx.running || !rx.tone || gen !== rx.gen) return; // drop results measured at an old pitch
      for (let i = 0; i < data.length; i += 2) pushSample(data[i] * 1000, Math.max(-100, 10 * Math.log10(data[i + 1] + 1e-15))); // ignore digital silence
    };

    const an = ac.createAnalyser();
    an.fftSize = 4096;
    an.smoothingTimeConstant = 0;
    src.connect(an);
    rx.analyser = an;
    rx.spec = new Float32Array(an.frequencyBinCount);
    rx.toneVotes = new Float32Array(an.frequencyBinCount);
    rx.tone = 0;
    if (!S.rxAutoTone) setTone(S.rxTone);
    clearInterval(rx.toneTimer);
    rx.toneTimer = setInterval(findTone, 50);
  }

  function setTone(f) {
    const first = !rx.tone; // first lock: re-measure the last few seconds so the opening letters are not lost
    rx.tone = f;
    rx.gen++;
    if (rx.det) rx.det.reset();
    rx.hist = [];
    if (rx.worklet) rx.worklet.port.postMessage({ freq: f, gen: rx.gen, replay: first });
  }

  // Auto tone: look for a strong narrow peak between 300 and 1500 Hz and keep
  // a decaying vote per frequency bin, so one stray noise does not move it.
  function findTone() {
    if (!rx.analyser || !S.rxAutoTone) return;
    const an = rx.analyser, spec = rx.spec, votes = rx.toneVotes;
    an.getFloatFrequencyData(spec);
    const hz = rx.ac.sampleRate / an.fftSize;
    const lo = Math.ceil(300 / hz), hi = Math.floor(1500 / hz);
    let best = lo;
    for (let i = lo; i <= hi; i++) if (spec[i] > spec[best]) best = i;
    const band = Array.from(spec.subarray(lo, hi + 1)).sort((a, b) => a - b);
    const median = band[band.length >> 1];
    for (let i = lo; i <= hi; i++) votes[i] *= 0.985;
    if (spec[best] - median > 20 && spec[best] > -90) {
      votes[best] += 1;
      if (best > lo) votes[best - 1] += 0.5;
      if (best < hi) votes[best + 1] += 0.5;
    }
    let top = lo;
    for (let i = lo; i <= hi; i++) if (votes[i] > votes[top]) top = i;
    if (votes[top] < 3) return;
    // Parabolic interpolation on the spectrum around the winning bin.
    const a = spec[top - 1], b = spec[top], c = spec[top + 1];
    const off = (a - 2 * b + c) !== 0 ? 0.5 * (a - c) / (a - 2 * b + c) : 0;
    const f = (top + Math.max(-0.5, Math.min(0.5, off))) * hz;
    if (!rx.tone || Math.abs(f - rx.tone) > 1.5 * hz) setTone(f);
  }

  /* -------------------------------- Scope ------------------------------- */

  const scope = $('scope');
  function sizeScope() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(scope.clientWidth * dpr), h = Math.round(scope.clientHeight * dpr);
    if (w && (scope.width !== w || scope.height !== h)) { scope.width = w; scope.height = h; }
    drawScope();
  }
  window.addEventListener('resize', sizeScope);

  function drawScopeLoop() {
    cancelAnimationFrame(rx.loopId);
    const step = () => { drawScope(); if (rx.running) rx.loopId = requestAnimationFrame(step); };
    rx.loopId = requestAnimationFrame(step);
  }

  function drawScope() {
    const ctx = scope.getContext('2d');
    const W = scope.width, H = scope.height;
    const css = getComputedStyle(document.documentElement);
    ctx.clearRect(0, 0, W, H);
    const h = rx.hist;
    if (!h.length) return;
    const tEnd = h[h.length - 1].t, span = 6000;
    let lo = Infinity, hi = -Infinity;
    for (const s of h) { lo = Math.min(lo, s.floor, s.level); hi = Math.max(hi, s.peak, s.level); }
    const pad = (hi - lo) * 0.1 + 1e-6; lo -= pad; hi += pad;
    const X = t => W - ((tEnd - t) / span) * W;
    const Y = v => H - ((v - lo) / (hi - lo)) * H;
    // On-state shading
    ctx.fillStyle = css.getPropertyValue('--blue').trim();
    ctx.globalAlpha = 0.15;
    for (let i = 1; i < h.length; i++) if (h[i].state) ctx.fillRect(X(h[i - 1].t), 0, Math.max(1, X(h[i].t) - X(h[i - 1].t)), H);
    ctx.globalAlpha = 1;
    // Threshold
    ctx.strokeStyle = css.getPropertyValue('--muted').trim();
    ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
    ctx.beginPath();
    h.forEach((s, i) => (i ? ctx.lineTo(X(s.t), Y(s.on)) : ctx.moveTo(X(s.t), Y(s.on))));
    ctx.stroke();
    ctx.setLineDash([]);
    // Level
    ctx.strokeStyle = css.getPropertyValue('--blue').trim();
    ctx.lineWidth = Math.max(1.5, (window.devicePixelRatio || 1) * 1.2);
    ctx.beginPath();
    h.forEach((s, i) => (i ? ctx.lineTo(X(s.t), Y(s.level)) : ctx.moveTo(X(s.t), Y(s.level))));
    ctx.stroke();
  }

  /* --------------------------- Receive settings ------------------------- */

  function bindRange(id, key, fmt, onChange) {
    const el = $(id), val = $(id + 'Val');
    el.value = S[key];
    const show = () => { if (val) val.textContent = fmt(+el.value); };
    show();
    el.addEventListener('input', () => { S[key] = +el.value; save(); show(); onChange && onChange(+el.value); });
    return { el, show };
  }
  function bindCheck(id, key, onChange) {
    const el = $(id);
    el.checked = !!S[key];
    el.addEventListener('change', () => { S[key] = el.checked; save(); onChange && onChange(el.checked); });
    return el;
  }

  const rxWpm = bindRange('rxWpm', 'rxWpm', v => (S.rxAutoSpeed ? 'Auto' : `${v} WPM`), v => { if (rx.dec && !S.rxAutoSpeed) rx.dec.setWpm(v); });
  bindCheck('rxAutoSpeed', 'rxAutoSpeed', on => {
    rxWpm.el.disabled = on; rxWpm.show();
    if (rx.dec) { rx.dec.setWpm(on ? 0 : S.rxWpm); rx.dec.reset(); }
  });
  rxWpm.el.disabled = S.rxAutoSpeed;

  const rxTone = bindRange('rxTone', 'rxTone', v => (S.rxAutoTone ? 'Auto' : `${v} Hz`), v => { if (!S.rxAutoTone && rx.worklet) setTone(v); });
  bindCheck('rxAutoTone', 'rxAutoTone', on => {
    rxTone.el.disabled = on; rxTone.show();
    if (!rx.worklet) return;
    if (on) { rx.toneVotes.fill(0); rx.tone = 0; } else setTone(S.rxTone);
  });
  rxTone.el.disabled = S.rxAutoTone;

  $('copyText').onclick = async () => {
    const t = decodedEl.textContent.trim();
    if (!t) { toast('Nothing to copy yet'); return; }
    try { await navigator.clipboard.writeText(t); toast('Copied'); } catch (e) { toast('Copy blocked by the browser'); }
  };
  $('clearText').onclick = () => { decodedEl.textContent = ''; patternEl.textContent = ''; };

  /* ====================================================================== */
  /*                                  SEND                                  */
  /* ====================================================================== */

  const tx = { running: false, ac: null, osc: null, gain: null, loopId: 0 };
  const txText = $('txText');
  txText.value = S.txText;

  function updatePreview() {
    S.txText = txText.value; save();
    const p = Morse.toPattern(txText.value);
    $('txPreview').textContent = p ? pretty(p) : '';
  }
  txText.addEventListener('input', updatePreview);
  updatePreview();

  $('paste').onclick = async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (!t) { toast('Clipboard is empty'); return; }
      txText.value = t; updatePreview();
    } catch (e) {
      txText.focus();
      toast('Long-press the box and choose Paste');
    }
  };
  $('txClear').onclick = () => { txText.value = ''; updatePreview(); txText.focus(); };

  segmented($('out'), S.out, v => { S.out = v; save(); });

  const fwpm = bindRange('txFwpm', 'txFwpm', v => (v >= S.txWpm ? 'Off' : `${v} WPM effective`));
  bindRange('txWpm', 'txWpm', v => `${v} WPM`, v => {
    fwpm.el.max = v;
    if (S.txFwpm > v) { S.txFwpm = v; fwpm.el.value = v; }
    fwpm.show();
  });
  fwpm.el.max = S.txWpm;
  fwpm.el.value = Math.min(S.txFwpm, S.txWpm);
  fwpm.show();
  bindRange('txTone', 'txTone', v => `${v} Hz`, v => { if (tx.osc) tx.osc.frequency.value = v; });
  bindRange('txVol', 'txVol', v => `${Math.round(v * 100)}%`, v => { tx.vol = v; });
  bindCheck('txRepeat', 'txRepeat');
  segmented($('swatches'), S.flash, v => { S.flash = v; save(); });

  $('txSend').onclick = () => {
    if (tx.running) { stopSend(); return; }
    startSend(txText.value, S.txRepeat);
  };
  $('sos').onclick = () => {
    if (tx.running && tx.isSos) { stopSend(); return; }
    if (tx.running) stopSend();
    startSend('<SOS>', true, true);
  };
  $('flash').onclick = () => stopSend();

  function outputAudioContext() {
    if (!tx.ac) tx.ac = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    if (tx.ac.state === 'suspended') tx.ac.resume();
    return tx.ac;
  }

  function startSend(text, loop, isSos) {
    const sch = Morse.schedule(text, S.txWpm, S.txFwpm < S.txWpm ? S.txFwpm : 0);
    if (!sch.segments.length) { toast('Type a message first'); return; }
    const sound = S.out !== 'screen', screen = S.out !== 'sound';
    tx.running = true; tx.isSos = !!isSos; tx.sch = sch; tx.loop = loop; tx.sound = sound; tx.screen = screen;
    tx.period = sch.total + sch.timing.wordGap; // pause between repeats
    tx.vol = S.txVol;
    $('txSend').textContent = 'Stop';
    $('sos').textContent = isSos ? 'Stop' : 'SOS';
    renderNow(-1);

    if (sound) {
      const ac = outputAudioContext();
      const osc = ac.createOscillator(), gain = ac.createGain();
      osc.type = 'sine';
      osc.frequency.value = S.txTone;
      gain.gain.value = 0;
      osc.connect(gain); gain.connect(ac.destination);
      osc.start();
      tx.osc = osc; tx.gain = gain;
      tx.t0 = ac.currentTime + 0.12;
      tx.scheduledReps = 0;
      scheduleAudioRep(0);
      // Screen follows what is heard, allowing for output delay.
      const lat = (ac.outputLatency || ac.baseLatency || 0);
      tx.clock = () => (ac.currentTime - tx.t0 - (screen ? lat : 0)) * 1000;
    } else {
      const start = performance.now() + 50;
      tx.clock = () => performance.now() - start;
    }

    if (screen) {
      const f = $('flash');
      f.classList.add('show');
      f.style.background = '#000';
      $('flashChar').textContent = '';
      if (f.requestFullscreen) f.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
    }
    wake.get('tx');
    cancelAnimationFrame(tx.loopId);
    tx.lastTok = -2; tx.lastOn = null;
    tx.loopId = requestAnimationFrame(sendTick);
  }

  // Envelope for one repetition. Short ramps avoid clicks.
  function scheduleAudioRep(rep) {
    const g = tx.gain.gain, base = tx.t0 + (rep * tx.period) / 1000;
    for (const s of tx.sch.segments) {
      if (!s.on) continue;
      const a = base + s.start / 1000, d = s.dur / 1000, r = Math.min(0.005, d / 4);
      g.setValueAtTime(0, a);
      g.linearRampToValueAtTime(tx.vol, a + r);
      g.setValueAtTime(tx.vol, a + d - r);
      g.linearRampToValueAtTime(0, a + d);
    }
    tx.scheduledReps = rep + 1;
  }

  function sendTick() {
    if (!tx.running) return;
    const el = tx.clock();
    const sch = tx.sch;
    const rep = Math.max(0, Math.floor(el / tx.period));
    if (!tx.loop && el >= sch.total) { stopSend(); return; }
    // Keep about one repetition of audio queued ahead.
    if (tx.sound && tx.loop && el > (tx.scheduledReps - 1) * tx.period + tx.period - 1500) scheduleAudioRep(tx.scheduledReps);

    const within = el - rep * tx.period;
    let on = false, tok = -1;
    if (within >= 0) {
      for (const s of sch.segments) {
        if (within < s.start) break;
        if (within < s.start + s.dur) { on = s.on; tok = s.tok; break; }
      }
    }
    if (tx.screen && on !== tx.lastOn) {
      $('flash').style.background = on ? S.flash : '#000';
      tx.lastOn = on;
    }
    if (tok !== tx.lastTok) { renderNow(tok); tx.lastTok = tok; }
    tx.loopId = requestAnimationFrame(sendTick);
  }

  function renderNow(cur) {
    const toks = tx.sch ? tx.sch.tokens : [];
    const html = toks.map((t, i) => {
      const txt = escapeHtml(t.text === '<SOS>' ? 'SOS' : t.text);
      return i === cur ? `<span class="cur">${txt}</span>` : (cur >= 0 && i < cur ? `<span class="done">${txt}</span>` : txt);
    }).join('');
    $('txNow').innerHTML = tx.running ? html : '';
    const t = toks[cur];
    $('flashChar').textContent = t && t.type === 'char' ? (t.text === '<SOS>' ? 'SOS' : t.text) : '';
  }

  function stopSend() {
    if (!tx.running) return;
    tx.running = false;
    cancelAnimationFrame(tx.loopId);
    if (tx.gain && tx.ac) {
      const g = tx.gain.gain, now = tx.ac.currentTime;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0, now + 0.01);
      const osc = tx.osc;
      setTimeout(() => { try { osc.stop(); osc.disconnect(); } catch (e) { /* already stopped */ } }, 50);
    }
    tx.osc = null; tx.gain = null;
    const f = $('flash');
    f.style.background = '#000';
    f.classList.remove('show');
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    wake.release('tx');
    $('txSend').textContent = 'Send';
    $('sos').textContent = 'SOS';
    $('txNow').innerHTML = '';
  }

  document.addEventListener('fullscreenchange', () => {
    // Back button or swipe out of full screen ends a screen send.
    if (!document.fullscreenElement && tx.running && tx.screen && !tx.sound) stopSend();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (rx.running) stopReceive();
      if (tx.running) stopSend();
    }
  });

  /* -------------------------------- Start ------------------------------- */
  rx.source = S.source;
  updateSourceUI();
  setTab(S.tab);
  sizeScope();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // Hooks for automated tests.
  window.__morse = { rx, tx, S };
})();
