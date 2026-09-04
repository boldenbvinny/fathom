// Sonar audio. Kept separate from game.js because it is a self-contained
// output device: the game tells it what happened, it never reads game state.
//
// The important idea here is that echo DELAY encodes distance. A ping's return
// blip is scheduled at the round-trip time to whatever it bounced off, so a
// close wall answers immediately and a far one answers late. That makes sound
// a real second information channel rather than decoration — you can hear the
// shape of the space you're in before the light reaches it.
const Sfx = (() => {
  let ctx = null, master = null, muted = false, drone = null, droneFilter = null;
  let hunterVoices = [];

  try { muted = localStorage.getItem('fathom.muted') === '1'; } catch (e) {}

  // Browsers only allow audio to start inside a user gesture.
  function init() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 1;
    master.connect(ctx.destination);
  }

  function isMuted() { return muted; }

  function setMuted(m) {
    muted = m;
    try { localStorage.setItem('fathom.muted', m ? '1' : '0'); } catch (e) {}
    if (master) master.gain.setTargetAtTime(m ? 0 : 1, ctx.currentTime, 0.02);
  }

  function panner(pan) {
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      return p;
    }
    return ctx.createGain();   // Safari fallback: mono, still audible
  }

  // The outgoing ping: a bright downward chirp.
  function ping() {
    if (!ctx || muted) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(940, t);
    o.frequency.exponentialRampToValueAtTime(370, t + 0.13);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.19);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + 0.2);
  }

  // One return. `delay` is the round trip in seconds, `amp` falls off with range.
  function echo(delay, pan, amp) {
    if (!ctx || muted || amp <= 0.01) return;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    const p = panner(pan);
    o.type = 'triangle';
    o.frequency.setValueAtTime(560 + amp * 180, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, 0.13 * amp), t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    o.connect(g); g.connect(p); p.connect(master);
    o.start(t); o.stop(t + 0.14);
  }

  // Hull drone. Its filter closes as the trench narrows, so the walls
  // pressing in is something you hear before you see it.
  function startDrone() {
    if (!ctx || drone) return;
    drone = ctx.createOscillator();
    droneFilter = ctx.createBiquadFilter();
    const g = ctx.createGain();
    drone.type = 'sawtooth';
    drone.frequency.value = 41;
    droneFilter.type = 'lowpass';
    droneFilter.frequency.value = 260;
    g.gain.value = 0.075;
    drone.connect(droneFilter); droneFilter.connect(g); g.connect(master);
    drone.start();
  }

  function stopDrone() {
    if (!drone) return;
    try { drone.stop(); } catch (e) {}
    drone = null; droneFilter = null;
  }

  // tightness: 0 = wide open, 1 = as narrow as it gets.
  function setTightness(tightness) {
    if (!droneFilter || !ctx) return;
    droneFilter.frequency.setTargetAtTime(300 - tightness * 190, ctx.currentTime, 0.3);
  }

  // Hunters are audible before they are visible: a dissonant tone per hunter,
  // panned to its side and rising as it closes.
  function setHunters(list) {
    if (!ctx || muted) { return; }
    while (hunterVoices.length < list.length) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      const p = panner(0);
      o.type = 'sawtooth';
      o.frequency.value = 150;
      g.gain.value = 0;
      o.connect(g); g.connect(p); p.connect(master);
      o.start();
      hunterVoices.push({ o, g, p });
    }
    for (let i = 0; i < hunterVoices.length; i++) {
      const v = hunterVoices[i], h = list[i];
      const now = ctx.currentTime;
      if (!h) { v.g.gain.setTargetAtTime(0, now, 0.15); continue; }
      v.g.gain.setTargetAtTime(0.055 * h.near, now, 0.12);
      v.o.frequency.setTargetAtTime(118 + h.near * 95 + h.alert * 60, now, 0.2);
      if (v.p.pan) v.p.pan.setTargetAtTime(Math.max(-1, Math.min(1, h.pan)), now, 0.1);
    }
  }

  function silenceHunters() {
    if (!ctx) return;
    for (const v of hunterVoices) v.g.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
  }

  function death(byHunter) {
    if (!ctx || muted) return;
    const t = ctx.currentTime;
    // Impact: a filtered noise burst, pitched down over half a second.
    const len = Math.floor(ctx.sampleRate * 0.6);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    const f = ctx.createBiquadFilter();
    const g = ctx.createGain();
    src.buffer = buf;
    f.type = 'lowpass';
    f.frequency.setValueAtTime(byHunter ? 1400 : 900, t);
    f.frequency.exponentialRampToValueAtTime(90, t + 0.55);
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t);
    silenceHunters();
  }

  return { init, ping, echo, startDrone, stopDrone, setTightness, setHunters, silenceHunters, death, setMuted, isMuted };
})();
