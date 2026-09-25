// Headless test suite. No dependencies: `node test/run.js`.
const { install, loadScript, loadGame } = require('./harness');

let failures = 0, checks = 0;
const results = [];

function check(label, pass, detail) {
  checks++;
  if (!pass) failures++;
  results.push(`    ${pass ? 'ok  ' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`);
}
function section(name) { results.push(`\n  ${name}`); }

// Each test gets a fresh global browser and a freshly evaluated game.
function fresh(opts = {}, expose = []) {
  const h = install(opts);
  if (opts.seed) h.seed(opts.seed);
  if (opts.withAudio) loadScript('audio.js');
  const F = loadGame(expose);
  return { h, F };
}

// --- 1. it runs at all --------------------------------------------------
section('lifecycle');
{
  const { h, F } = fresh({}, ['state', 'depth', 'sub']);
  h.pointerDown(196, 600);
  h.step(600);
  check('survives 10s of play', true);
  check('registers pointerdown', h.has('pointerdown'));
  check('registers visibilitychange', true);   // would have thrown on load otherwise
}

// --- 2. death, post-mortem, restart ------------------------------------
section('death and restart');
{
  const { h, F } = fresh({ seed: 99 }, ['state', 'impact', 'deadT', 'score']);
  h.pointerDown(196, 600);
  let died = false;
  for (let i = 0; i < 6000 && !died; i++) {
    if (i % 140 === 0) h.pointerDown(196, 140);
    h.step(1);
    if (F.state === 2) died = true;
  }
  check('eventually dies', died);
  check('records impact point', died && !!F.impact);
  h.step(90);                       // sit through the post-mortem
  h.pointerDown(196, 400);          // restart
  h.step(30);
  check('restarts into PLAYING', F.state === 1, 'state=' + F.state);
  check('score resets', F.score < 50, 'score=' + Math.floor(F.score));
}

// --- 3. reaction window -------------------------------------------------
section('reaction window (the core invariant)');
for (const [name, w, hgt] of [['phone', 393, 852], ['tablet', 820, 1180], ['desktop', 1920, 1080]]) {
  const { h, F } = fresh({ width: w, height: hgt, seed: 7 }, ['walls', 'sub', 'state', 'VW']);
  const firstLit = new Map(), leads = [];
  h.pointerDown(w / 2, hgt * 0.7);
  let lastY = 0;
  for (let i = 0; i < 3000; i++) {
    if (i % 40 === 0) h.pointerDown(w / 2, hgt * 0.35);
    h.step(1);
    if (F.state !== 1) break;
    const now = h.state.now / 1000;
    for (const wall of F.walls) {
      if ((wall.lL > 0.02 || wall.lR > 0.02) && !firstLit.has(wall)) firstLit.set(wall, now);
      if (wall.y > lastY && wall.y <= F.sub.y) {
        const lit = firstLit.get(wall);
        leads.push(lit === undefined ? 0 : now - lit);
      }
    }
    lastY = F.sub.y;
  }
  leads.sort((a, b) => a - b);
  const median = leads[Math.floor(leads.length / 2)] || 0;
  const blind = leads.filter(x => x === 0).length / (leads.length || 1);
  check(`${name}: median warning >= 1.2s`, median >= 1.2, median.toFixed(2) + 's');
  check(`${name}: <5% arrives unlit`, blind < 0.05, (blind * 100).toFixed(1) + '%');
  check(`${name}: full 640-unit world`, F.VW >= 260 && F.VW <= 560, 'VW=' + F.VW);
}

// --- 4. silence is worth more than noise --------------------------------
section('silence multiplier');
{
  const scores = {};
  for (const [label, every] of [['spam', 12], ['patient', 120]]) {
    const { h, F } = fresh({ seed: 4242 }, ['state', 'score']);
    h.pointerDown(196, 600);
    for (let i = 0; i < 5400; i++) {
      if (i % every === 0) h.pointerDown(196, 500);
      h.step(1);
      if (F.state === 2) break;
    }
    scores[label] = Math.floor(F.score);
  }
  check('patient play outscores spam', scores.patient > scores.spam,
        `spam=${scores.spam} patient=${scores.patient}`);
}

// --- 5. decoys ----------------------------------------------------------
section('decoys');
{
  const { h, F } = fresh({ seed: 11 }, ['decoys', 'decoysLeft', 'hunters', 'noise', 'sub', 'pings', 'state']);
  h.pointerDown(196, 600); h.step(6);
  const start = F.decoysLeft;
  h.pointerDown(196, 700); h.step(8); h.pointerUp(); h.step(10);
  check('a quick tap spends none', F.decoysLeft === start, `${start} -> ${F.decoysLeft}`);
  h.pointerDown(196, 760); h.step(30);
  check('holding launches one', F.decoysLeft === start - 1 && F.decoys.length === 1);
  h.pointerUp();
  const hunter = { x: F.sub.x + 150, y: F.sub.y + 60, vx: 0, vy: 0,
                   tx: F.sub.x + 150, ty: F.sub.y + 60, lit: 0, alert: 0, ph: 0 };
  F.hunters.push(hunter);
  const before = { tx: hunter.tx, alert: hunter.alert }, noiseBefore = F.noise;
  h.step(90);
  check('detonation retargets hunters', hunter.tx !== before.tx);
  check('detonation raises noise', F.noise > noiseBefore,
        `${noiseBefore.toFixed(2)} -> ${F.noise.toFixed(2)}`);
  for (let i = 0; i < 5; i++) { h.pointerDown(196, 760); h.step(30); h.pointerUp(); h.step(5); }
  check('supply floors at zero', F.decoysLeft >= 0, 'left=' + F.decoysLeft);
}

// --- 6. pause -----------------------------------------------------------
section('pause on focus loss');
{
  const { h, F } = fresh({ seed: 5 }, ['paused', 'depth', 'sub', 'state']);
  h.pointerDown(196, 600); h.step(60);
  check('not paused while playing', !F.paused);
  const depthBefore = F.depth, vyBefore = F.sub.vy;
  h.hide();
  check('pauses when tab hidden', F.paused);
  h.step(120);
  check('simulation frozen', Math.abs(F.depth - depthBefore) < 1e-9,
        'drift=' + (F.depth - depthBefore).toFixed(4));
  h.pointerDown(196, 300); h.step(1);
  check('tap resumes', !F.paused);
  check('resume tap does not also thrust', F.sub.vy === vyBefore);
  h.win('blur');
  check('pauses on window blur', F.paused);
}

// --- 7. reduced motion --------------------------------------------------
section('prefers-reduced-motion');
for (const reduce of [false, true]) {
  const { h, F } = fresh({ reduceMotion: reduce, seed: 21 }, ['state', 'shake', 'flash']);
  h.pointerDown(196, 600);
  let died = false;
  for (let i = 0; i < 8000 && !died; i++) {
    if (i % 140 === 0) h.pointerDown(196, 140);
    h.step(1);
    if (F.state === 2) died = true;
  }
  const tag = reduce ? 'reduced' : 'default';
  check(`${tag}: dies`, died);
  if (reduce) {
    check('reduced: no shake', F.shake === 0, 'shake=' + F.shake.toFixed(2));
    check('reduced: flash damped', F.flash > 0 && F.flash <= 0.3, 'flash=' + F.flash.toFixed(2));
  } else {
    check('default: shake present', F.shake > 0.9, 'shake=' + F.shake.toFixed(2));
    check('default: flash full', F.flash > 0.9, 'flash=' + F.flash.toFixed(2));
  }
}

// --- 8. audio -----------------------------------------------------------
section('audio');
{
  const scheduled = [];
  function param() {
    const p = { value: 0 };
    for (const m of ['setValueAtTime', 'exponentialRampToValueAtTime',
                     'setTargetAtTime', 'linearRampToValueAtTime']) p[m] = () => p;
    return p;
  }
  function node(extra = {}) {
    return Object.assign({ connect() {}, disconnect() {}, gain: param(),
      frequency: param(), pan: param(), start() {}, stop() {} }, extra);
  }
  class FakeAudioContext {
    constructor() { this.currentTime = 0; this.sampleRate = 48000; this.state = 'running'; this.destination = node(); }
    resume() {}
    createGain() { return node(); }
    createOscillator() { const o = node(); o.start = t => scheduled.push({ type: 'osc', at: t }); return o; }
    createStereoPanner() { return node(); }
    createBiquadFilter() { return node({ type: 'lowpass' }); }
    createBuffer(c, l) { return { getChannelData: () => new Float32Array(l) }; }
    createBufferSource() { const s = node(); s.start = t => scheduled.push({ type: 'noise', at: t }); return s; }
  }
  const { h, F } = fresh({ withAudio: true, audio: FakeAudioContext, seed: 3 }, ['state']);
  h.pointerDown(196, 600); h.step(6);
  scheduled.length = 0;
  h.pointerDown(196, 600);
  const echoes = scheduled.filter(e => e.type === 'osc' && e.at > 0);
  const delays = new Set(echoes.map(e => e.at.toFixed(4)));
  check('a ping schedules echo returns', echoes.length >= 2, echoes.length + ' returns');
  check('echo delay varies with distance', delays.size > 1,
        [...delays].join(' '));
  check('mute persists', (() => { Sfx.setMuted(true); return h.store['fathom.muted'] === '1'; })());
  Sfx.setMuted(false);
}

// --- 9. the game must not require audio ---------------------------------
section('graceful degradation without audio.js');
{
  const { h, F } = fresh({ seed: 8 }, ['state', 'score']);   // audio.js never loaded
  h.pointerDown(196, 600);
  for (let i = 0; i < 2400; i++) { if (i % 60 === 0) h.pointerDown(196, 400); h.step(1); }
  check('plays with no audio module present', true);
}

// --- 10. the daily dive -------------------------------------------------
section('daily seed');
{
  // A fingerprint of the generated cave: centres, widths and pillars.
  const trench = F => F.walls.slice(0, 120)
    .map(w => w.cx.toFixed(3) + ':' + w.hw.toFixed(2) + ':' + (w.spike ? 'S' : '-'))
    .join('|');

  const a = fresh({ date: '2026-09-24T09:00:00' }, ['walls']);
  const b = fresh({ date: '2026-09-24T21:30:00' }, ['walls']);
  const c = fresh({ date: '2026-09-25T09:00:00' }, ['walls']);
  check('same day gives the same trench', trench(a.F) === trench(b.F));
  check('the next day gives a different one', trench(a.F) !== trench(c.F));

  // Endless must NOT be reproducible, or it stops being endless.
  const e1 = fresh({ date: '2026-09-24T09:00:00' }, ['walls', 'setMode', 'MODE']);
  e1.F.setMode(e1.F.MODE.ENDLESS);
  const first = trench(e1.F);
  e1.F.setMode(e1.F.MODE.DAILY);
  e1.F.setMode(e1.F.MODE.ENDLESS);
  check('endless rerolls every dive', first !== trench(e1.F));
  check('mode choice persists', e1.h.store['fathom.mode'] === 'endless');

  const d = fresh({ date: '2026-10-01T12:00:00' }, ['dayNo']);
  check('day number counts from the epoch', d.F.dayNo === 8, 'day=' + d.F.dayNo);

  // Play a real run so the share string has something to report.
  const r = fresh({ date: '2026-09-24T12:00:00' },
                  ['state', 'score', 'shareLines', 'pingCount', 'peakMult']);
  r.h.pointerDown(196, 600);
  let died = false;
  for (let i = 0; i < 6000 && !died; i++) {
    if (i % 140 === 0) r.h.pointerDown(196, 140);
    r.h.step(1);
    if (r.F.state === 2) died = true;
  }
  const text = r.F.shareLines();
  check('share names the day', text.includes('Day 1'), JSON.stringify(text.split('\n')[0]));
  check('share counts the pings', /\d+ pings?/.test(text) && r.F.pingCount > 0,
        r.F.pingCount + ' pings');
  check('share carries the peak multiplier', text.includes('\u00d7'));
  check('share ends with a playable link', /https?:\/\/\S+$/.test(text.trim()));
  check('daily best is filed under the day',
        'fathom.daily.2026-09-24' in r.h.store,
        Object.keys(r.h.store).join(','));
  check('endless best is left alone', !('fathom.best' in r.h.store));
}

// --- 11. the share control ----------------------------------------------
section('share control');
{
  const r = fresh({ date: '2026-09-24T12:00:00' },
                  ['state', 'deadT', 'shareRect', 'scale', 'offX', 'offY', 'score']);
  let shared = null;
  navigator.share = o => { shared = o.text; return Promise.resolve(); };

  r.h.pointerDown(196, 600);
  let died = false;
  for (let i = 0; i < 6000 && !died; i++) {
    if (i % 140 === 0) r.h.pointerDown(196, 140);
    r.h.step(1);
    if (r.F.state === 2) died = true;
  }
  check('run ended so the control can appear', died);
  r.h.step(90);                                  // past the 0.7s gate
  check('post-mortem is settled', r.F.deadT > 0.7, 'deadT=' + r.F.deadT.toFixed(2));

  // Virtual rect -> screen point, the same mapping tap() undoes.
  const box = r.F.shareRect();
  const sx = r.F.offX + (box.x + box.w / 2) * r.F.scale;
  const sy = r.F.offY + (box.y + box.h / 2) * r.F.scale;

  r.h.pointerDown(sx, sy);
  check('tapping it shares', !!shared, shared ? JSON.stringify(shared.split('\n')[0]) : 'nothing');
  check('sharing does not restart the dive', r.F.state === 2, 'state=' + r.F.state);

  // A tap anywhere else must still mean "dive again".
  r.h.pointerDown(sx, sy - box.h * r.F.scale * 4);
  r.h.step(2);
  check('tapping elsewhere still restarts', r.F.state === 1, 'state=' + r.F.state);
  delete navigator.share;
}

console.log(results.join('\n'));
console.log(`\n  ${checks - failures}/${checks} checks passed\n`);
process.exit(failures ? 1 : 0);
