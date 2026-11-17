// End-to-end check in headless Chromium with fake camera and microphone.
// Usage: node test/e2e.js [outDir]
// Generates a Morse WAV and a flashing-light Y4M video, feeds them to the
// browser as its microphone and camera, and checks the decoded text. Also
// records the screen-flash sender's timing and decodes it as a loopback.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const M = require('../morse.js');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'morse-e2e'));
fs.mkdirSync(OUT, { recursive: true });

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

/* ---------- media generation ---------- */

function makeWav(file, text, wpm, freq, { snrDb = 25, lead = 1.5, tail = 2 } = {}) {
  const sr = 48000;
  const sch = M.schedule(text, wpm);
  const total = lead + sch.total / 1000 + tail;
  const n = Math.round(total * sr);
  const buf = Buffer.alloc(44 + n * 2);
  const r = rng(42);
  const amp = 0.3, noiseAmp = amp / Math.pow(10, snrDb / 20) * 3;
  const on = new Uint8Array(n);
  for (const s of sch.segments) if (s.on) {
    const a = Math.round((lead + s.start / 1000) * sr), b = Math.round((lead + (s.start + s.dur) / 1000) * sr);
    on.fill(1, a, b);
  }
  let env = 0;
  for (let i = 0; i < n; i++) {
    env += ((on[i] ? 1 : 0) - env) * 0.02; // soft edges like a real speaker
    // Noise: white plus a low hum and a little voice-band rumble.
    const noise = (r() * 2 - 1) * noiseAmp + 0.05 * Math.sin(2 * Math.PI * 120 * i / sr);
    const v = env * amp * Math.sin(2 * Math.PI * freq * i / sr) + noise;
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 32767))), 44 + i * 2);
  }
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  fs.writeFileSync(file, buf);
}

// Raw Y4M video: dark noisy room, a steady lamp, and a flashing light.
function makeY4m(file, text, wpm, { fps = 30, w = 320, h = 240, light = { x: 220, y: 90, size: 40 }, lead = 1.5, tail = 2 } = {}) {
  const sch = M.schedule(text, wpm);
  const total = lead + sch.total / 1000 + tail;
  const frames = Math.round(total * fps);
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, `YUV4MPEG2 W${w} H${h} F${fps}:1 Ip A1:1 C420jpeg\n`);
  const ySize = w * h, cSize = (w / 2) * (h / 2);
  const frame = Buffer.alloc(ySize + 2 * cSize);
  const r = rng(7);
  const isOn = tMs => {
    const t = tMs - lead * 1000;
    return sch.segments.some(s => s.on && t >= s.start && t < s.start + s.dur);
  };
  for (let f = 0; f < frames; f++) {
    // Frame shows the light state at the frame's mid-exposure time.
    const lit = isOn((f + 0.5) * 1000 / fps);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = 40 + (r() * 10 - 5);
      if (x > 30 && x < 90 && y > 150 && y < 200) v = 150; // steady lamp
      const dx = x - light.x, dy = y - light.y;
      if (Math.abs(dx) < light.size / 2 && Math.abs(dy) < light.size / 2) v = lit ? 245 : 55;
      frame[y * w + x] = Math.max(0, Math.min(255, v));
    }
    frame.fill(128, ySize);
    fs.writeSync(fd, 'FRAME\n');
    fs.writeSync(fd, frame);
  }
  fs.closeSync(fd);
}

/* ---------- static server ---------- */

function serve() {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(ok => srv.listen(0, '127.0.0.1', () => ok(srv)));
}

function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

// The fake device loops its file, so the decoded text repeats. Look for the
// expected phrase anywhere in it.
function bestMatch(got, want) {
  let best = Infinity;
  for (let i = 0; i + 1 <= Math.max(1, got.length - want.length + 1); i++) {
    best = Math.min(best, editDistance(got.slice(i, i + want.length), want));
  }
  return best;
}

async function run() {
  const results = [];
  const srv = await serve();
  const url = `http://127.0.0.1:${srv.address().port}/`;

  const AUDIO_TEXT = 'HELLO WORLD 73';
  const wav = path.join(OUT, 'tone.wav');
  makeWav(wav, AUDIO_TEXT, 18, 650);

  const VIDEO_TEXT = 'SOS TEST';
  const y4m = path.join(OUT, 'light.y4m');
  makeY4m(y4m, VIDEO_TEXT, 10);

  const browser = await chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${wav}`, `--use-file-for-fake-video-capture=${y4m}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  async function newPage(width = 390, scheme = 'light') {
    const ctx = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 2, colorScheme: scheme, permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'] });
    await ctx.addInitScript(() => localStorage.clear());
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(url);
    return { page, ctx, errors };
  }

  // 1. Microphone
  {
    const { page, ctx, errors } = await newPage();
    await page.click('#source button[data-v="mic"]');
    await page.click('#rxStart');
    await page.waitForTimeout(12000);
    const got = await page.textContent('#decoded');
    const status = await page.textContent('#rxStatus');
    await page.screenshot({ path: path.join(OUT, 'receive-mic.png') });
    const d = bestMatch(got, AUDIO_TEXT);
    results.push({ name: 'microphone decode', pass: d <= 1 && !errors.length, detail: `got "${got.trim()}" | status "${status}" | edits ${d} ${errors.join(' ')}` });
    await ctx.close();
  }

  // 2. Camera, whole frame
  {
    const { page, ctx, errors } = await newPage();
    await page.click('#rxStart');
    await page.waitForTimeout(18000);
    const got = await page.textContent('#decoded');
    const status = await page.textContent('#rxStatus');
    await page.screenshot({ path: path.join(OUT, 'receive-camera.png') });
    const d = bestMatch(got, VIDEO_TEXT);
    results.push({ name: 'camera decode (whole frame)', pass: d <= 1 && !errors.length, detail: `got "${got.trim()}" | status "${status}" | edits ${d} ${errors.join(' ')}` });

    // 3. Camera, tap to lock on the light
    await page.click('#clearText');
    const box = await page.locator('#cam').boundingBox();
    await page.mouse.click(box.x + box.width * (220 / 320), box.y + box.height * (90 / 240));
    await page.waitForTimeout(16000);
    const got2 = await page.textContent('#decoded');
    await page.screenshot({ path: path.join(OUT, 'receive-camera-locked.png') });
    const d2 = bestMatch(got2, VIDEO_TEXT);
    results.push({ name: 'camera decode (tap to lock)', pass: d2 <= 1 && !errors.length, detail: `got "${got2.trim()}" | edits ${d2}` });
    await ctx.close();
  }

  // 4. Screen sender loopback: record overlay transitions and decode them.
  {
    const { page, ctx, errors } = await newPage();
    await page.click('#tab-send');
    await page.fill('#txText', 'CQ DE VE3 TEST');
    await page.click('#out button[data-v="screen"]');
    await page.screenshot({ path: path.join(OUT, 'send.png') });
    await page.evaluate(() => {
      window.__flips = [];
      const f = document.getElementById('flash');
      new MutationObserver(() => window.__flips.push([performance.now(), f.style.background !== 'rgb(0, 0, 0)' && f.style.background !== '#000'])).observe(f, { attributes: true, attributeFilter: ['style'] });
    });
    await page.click('#txSend');
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, 'send-flash.png') });
    await page.waitForFunction(() => !window.__morse.tx.running, null, { timeout: 30000 });
    const flips = await page.evaluate(() => window.__flips);
    let out = '';
    const dec = new M.Decoder({ onText: c => (out += c) });
    for (let i = 1; i < flips.length; i++) {
      const [t0, on] = flips[i - 1], [t1] = flips[i];
      if (t1 - t0 <= 0) continue;
      on ? dec.mark(t1 - t0) : dec.gap(t1 - t0);
    }
    dec.idle(1e9);
    results.push({ name: 'screen sender loopback', pass: out.trim() === 'CQ DE VE3 TEST' && !errors.length, detail: `got "${out.trim()}" from ${flips.length} transitions ${errors.join(' ')}` });
    await ctx.close();
  }

  // 5. Sound and SOS start and stop without errors; layout screenshots.
  {
    const { page, ctx, errors } = await newPage(360, 'dark');
    await page.click('#tab-send');
    await page.click('#sos');
    await page.waitForTimeout(1500);
    const running = await page.evaluate(() => window.__morse.tx.running && window.__morse.tx.isSos);
    await page.click('#sos');
    const stopped = await page.evaluate(() => !window.__morse.tx.running);
    await page.click('#txSettings summary');
    await page.screenshot({ path: path.join(OUT, 'send-dark-360.png'), fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    await page.click('#tab-receive');
    await page.click('#rxSettings summary');
    await page.screenshot({ path: path.join(OUT, 'receive-dark-360.png'), fullPage: true });
    results.push({ name: 'SOS sound start/stop, no horizontal scroll at 360 px', pass: running && stopped && !overflow && !errors.length, detail: `running ${running} stopped ${stopped} overflow ${overflow} ${errors.join(' ')}` });
    await ctx.close();
  }

  await browser.close();
  srv.close();
  let ok = true;
  for (const r of results) { console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n      ${r.detail}`); ok = ok && r.pass; }
  console.log(`screenshots in ${OUT}`);
  process.exit(ok ? 0 : 1);
}

run().catch(e => { console.error(e); process.exit(1); });
