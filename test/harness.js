// Shared browser stub for the headless tests.
//
// This exists because every test used to hand-roll its own `document` and
// `window`, and they drifted: when game.js started listening for
// `visibilitychange`, the stubs that lacked `document.addEventListener` threw
// while the one that had it passed. A single stub means a new browser API is
// added once, here, and every test sees it.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

// Captured before any test swaps the global in, so repeated install() calls
// never subclass a subclass.
const RealDate = Date;

function makeCtx2D() {
  // Records nothing; the tests assert on game state, not on pixels.
  return new Proxy({}, {
    get: (t, p) => {
      if (p === 'canvas') return { width: 0, height: 0 };
      if (p === 'createLinearGradient' || p === 'createRadialGradient') {
        return () => ({ addColorStop() {} });
      }
      if (p === 'globalAlpha' || p === 'lineWidth' || p === 'shadowBlur') return 1;
      return () => {};
    },
    set: () => true
  });
}

/**
 * Install a fake browser on the globals.
 *   opts.width / opts.height  viewport size
 *   opts.reduceMotion         what matchMedia reports
 *   opts.audio                AudioContext constructor, if the test wants sound
 *   opts.date                 local wall-clock the game should see
 * Returns handles the test drives the game through.
 */
function install(opts = {}) {
  const {
    width = 393, height = 852, dpr = 2,
    reduceMotion = false, audio = null,
    date = '2026-09-24T12:00:00'
  } = opts;

  // The cave is generated from the local date, so an unpinned clock would make
  // every terrain assertion in this suite expire at midnight. Pin it.
  const fixed = RealDate.parse(date);
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(fixed); }
    static now() { return fixed; }
  }
  global.Date = FakeDate;

  const el = {
    getContext: () => makeCtx2D(),
    classList: { add() {}, remove() {} },
    style: {},
    textContent: ''
  };

  const winH = {};       // window listeners
  const docH = {};       // document listeners
  const state = { hidden: false, now: 0 };
  const store = {};

  global.document = {
    getElementById: () => el,
    addEventListener: (k, f) => { (docH[k] ||= []).push(f); },
    removeEventListener: (k, f) => {
      if (docH[k]) docH[k] = docH[k].filter(x => x !== f);
    },
    get hidden() { return state.hidden; }
  };

  global.window = {
    innerWidth: width,
    innerHeight: height,
    devicePixelRatio: dpr,
    addEventListener: (k, f) => { (winH[k] ||= []).push(f); },
    removeEventListener: (k, f) => {
      if (winH[k]) winH[k] = winH[k].filter(x => x !== f);
    },
    matchMedia: () => ({
      matches: reduceMotion,
      addEventListener() {},
      removeEventListener() {}
    }),
    AudioContext: audio || undefined
  };

  global.navigator = { vibrate() {} };
  global.localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; }
  };
  global.performance = { now: () => state.now };

  let raf = null;
  global.requestAnimationFrame = f => { raf = f; };

  return {
    store, state, el,
    // Fire a window / document event by name.
    win: (k, ev = {}) => (winH[k] || []).forEach(f => f(ev)),
    doc: (k, ev = {}) => (docH[k] || []).forEach(f => f(ev)),
    has: k => !!(winH[k] && winH[k].length),
    pointerDown: (x, y) => (winH.pointerdown || [])
      .forEach(f => f({ preventDefault() {}, clientX: x, clientY: y })),
    pointerUp: () => (winH.pointerup || []).forEach(f => f({})),
    hide: () => { state.hidden = true; (docH.visibilitychange || []).forEach(f => f()); },
    show: () => { state.hidden = false; (docH.visibilitychange || []).forEach(f => f()); },
    // Advance n frames at 60fps.
    step: n => { for (let i = 0; i < n; i++) { state.now += 1000 / 60; if (raf) raf(state.now); } },
    seed: s => { let x = s; Math.random = () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; }; }
  };
}

// Load a source file the way a <script> tag would: top-level `const` becomes
// global, rather than being trapped in a CommonJS module scope.
function loadScript(relPath) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, relPath), 'utf8'), { filename: relPath });
}

// Load game.js with internals exposed, without shipping debug hooks in the
// real file. The probe line is injected at load time only.
function loadGame(expose = []) {
  let src = fs.readFileSync(path.join(ROOT, 'game.js'), 'utf8');
  const getters = expose.map(n => `get ${n}(){return ${n}}`).join(', ');
  src = src.replace(/^  reset\(\);$/m, `  globalThis.__F = { ${getters} };\n  reset();`);
  vm.runInThisContext(src, { filename: 'game.js' });
  return globalThis.__F;
}

module.exports = { install, loadScript, loadGame, ROOT };
