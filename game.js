(() => {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const hint = document.getElementById('hint');

  // The world is 640 virtual units TALL on every device — reaction time depends
  // on how far ahead you can see, so that number must never vary. Width instead
  // follows the real aspect ratio, and the cave is centred on world x = 0, so a
  // resize only changes how much empty water you see beside it.
  const VH = 640;
  const MIN_VW = 260, MAX_VW = 560;
  const CAVE_SPAN = 360;      // the corridor's own coordinate space, viewport-independent
  let VW = 360;
  let scale = 1, offX = 0, offY = 0, dpr = 1;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = window.innerWidth, h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    VW = Math.max(MIN_VW, Math.min(MAX_VW, Math.round(VH * (w / h))));
    // Contain, never cover: cropping the world would cost the player warning time.
    scale = Math.min(w / VW, h / VH);
    offX = (w - VW * scale) / 2;
    offY = (h - VH * scale) / 2;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', resize);
  resize();

  // --- tuning -------------------------------------------------------------
  const GRAVITY = 172;        // gentle sink; you are buoyant, not falling
  const THRUST = 262;         // impulse per tap, toward the touch point
  const DRAG = 0.79;          // per-second velocity retention — lower = tighter
  const MAX_SPEED = 300;      // so a panic burst can't fling you into a wall
  const MAX_FALL = 235;       // hard cap on descent: you must never outrun your own sonar
  const SUB_R = 8;
  const PING_SPEED = 880;     // ~3.7x max fall speed, so the reveal always arrives early
  const PING_MAX = 430;       // reaches far enough ahead to be a warning, not a surprise
  const PING_BAND = 13;       // wave thickness — what it touches, it lights
  const DOWN_REACH = 1.5;     // the array is aimed down: it sees further the way you're going
  const FADE = 0.30;          // lit geometry lingers, so your mental map stays usable
  const GLOW_R = 40;          // permanent hull light, so you are never fully blind
  const GLOW_DOWN = 104;      // running light throws further below: minimum warning, always on
  const SAMPLE = 11;          // vertical spacing of wall sample points
  const NOISE_PER_PING = 0.16;
  const NOISE_DECAY = 0.22;
  const SILENT_RAMP = 1.7;    // seconds of silence per +1.0 of multiplier
  const MULT_MAX = 3;
  const DEATH_R = 132;        // how much of the cave the post-mortem reveals
  const CAM_Y = VH * 0.33;    // sub sits above centre; you see more of what's below

  const STATE = { READY: 0, PLAYING: 1, DEAD: 2 };
  let state, sub, pings, walls, hunters, motes, depth, best, noise, deadT, flash, shake, topY;
  let score, mult, silent, lastDepth, multBreak, impact;
  let camLead = 0;

  best = +(localStorage.getItem('fathom.best') || 0);

  // --- cave ---------------------------------------------------------------
  // The cave is a column of sample rows. Each row is one slice of tunnel:
  // a centre that wanders and a half-width that tightens as you descend.
  let genY, wander, wanderV;

  function halfWidthAt(d) {
    // Wide and forgiving at the surface, tightening slowly with depth.
    return Math.max(52, 132 - d * 0.0072);
  }

  function genRow() {
    const d = genY;
    wanderV += (Math.random() - 0.5) * 26;
    wanderV *= 0.92;
    wander += wanderV * 0.06;
    const hw = halfWidthAt(d);
    const limit = CAVE_SPAN / 2 - hw - 6;
    if (wander > limit) { wander = limit; wanderV *= -0.4; }
    if (wander < -limit) { wander = -limit; wanderV *= -0.4; }
    const cx = wander;

    const row = { y: genY, cx, hw, lL: 0, lR: 0 };

    // Occasional pillar splitting the channel — only once it's worth the scare.
    if (d > 1400 && Math.random() < 0.010) {
      const side = Math.random() < 0.5 ? -1 : 1;
      row.spike = { x: cx + side * hw, w: hw * (0.35 + Math.random() * 0.3) * -side, l: 0 };
    }
    walls.push(row);
    genY += SAMPLE;

    if (d > 900 && Math.random() < 0.0075) spawnHunter(cx, genY + VH * 0.5);
  }

  function rowAt(y) {
    const i = Math.floor((y - walls[0].y) / SAMPLE);
    return walls[Math.max(0, Math.min(walls.length - 1, i))];
  }

  function spawnHunter(x, y) {
    hunters.push({ x, y, vx: 0, vy: 0, tx: x, ty: y, lit: 0, alert: 0, ph: Math.random() * 6.28 });
  }

  // --- lifecycle ----------------------------------------------------------
  function reset() {
    state = STATE.READY;
    sub = { x: 0, y: 0, vx: 0, vy: 0, a: 0 };
    pings = []; walls = []; hunters = []; motes = [];
    depth = 0; noise = 0; deadT = 0; flash = 0; shake = 0;
    score = 0; mult = 1; silent = 0; lastDepth = 0; multBreak = 0; camLead = 0;
    impact = null;
    genY = -VH; wander = 0; wanderV = 0;
    while (genY < VH * 1.6) genRow();
    topY = walls[0].y;
    for (let i = 0; i < 70; i++) {
      motes.push({ x: (Math.random() - 0.5) * (MAX_VW + 120), y: -VH + Math.random() * VH * 3, r: Math.random() * 1.2 + 0.3, ph: Math.random() * 6.28 });
    }
    hint.textContent = 'tap to ping';
    hint.classList.remove('hidden');
  }

  function ping(x, y) {
    pings.push({ x, y, t: 0, pr: 0 });
    noise = Math.min(1, noise + NOISE_PER_PING);
    // Seeing costs three things: light, noise, and everything you'd banked.
    if (state === STATE.PLAYING && mult > 1.05) multBreak = 1;
    silent = 0;
    // Every hunter that can hear it now knows roughly where you were.
    for (const h of hunters) {
      const d = Math.hypot(h.x - x, h.y - y);
      if (d < 260 + noise * 200) {
        h.tx = x; h.ty = y;
        h.alert = 1;
      }
    }
  }

  function tap(px, py) {
    // Screen point -> virtual world point.
    const vx = (px - offX) / scale - VW / 2;
    const vy = (py - offY) / scale + (sub.y - CAM_Y + camLead);

    if (state === STATE.READY) {
      state = STATE.PLAYING;
      hint.classList.add('hidden');
    } else if (state === STATE.DEAD) {
      if (deadT > 0.7) reset();
      return;
    }
    // Thrust toward the finger, and ping from the hull.
    const dx = vx - sub.x, dy = vy - sub.y;
    const len = Math.hypot(dx, dy) || 1;
    sub.vx += (dx / len) * THRUST;
    sub.vy += (dy / len) * THRUST;
    ping(sub.x, sub.y);
    if (navigator.vibrate) navigator.vibrate(8);
  }

  window.addEventListener('pointerdown', e => { e.preventDefault(); tap(e.clientX, e.clientY); }, { passive: false });
  window.addEventListener('touchstart', e => {
    e.preventDefault();
    const t = e.changedTouches[0];
    tap(t.clientX, t.clientY);
  }, { passive: false });
  window.addEventListener('keydown', e => {
    if (e.code === 'Space') { e.preventDefault(); tap(window.innerWidth / 2, window.innerHeight * 0.2); }
  });

  function die(reason) {
    if (state !== STATE.PLAYING) return;
    state = STATE.DEAD;
    deadT = 0; flash = 1; shake = 1;
    impact = { x: sub.x, y: sub.y, hunter: reason === 'hunter' };
    hint.textContent = 'tap to dive again';
    hint.classList.remove('hidden');
    if (score > best) { best = Math.floor(score); localStorage.setItem('fathom.best', best); }
    if (navigator.vibrate) navigator.vibrate(reason === 'hunter' ? [30, 40, 60] : 45);
  }

  // --- update -------------------------------------------------------------
  function update(dt) {
    for (let i = pings.length - 1; i >= 0; i--) {
      pings[i].pr = pings[i].t * PING_SPEED;   // where the wave was last frame
      pings[i].t += dt;
      if (pings[i].t * PING_SPEED > PING_MAX) pings.splice(i, 1);
    }
    lightGeometry();

    for (const w of walls) {
      w.lL = Math.max(0, w.lL - FADE * dt);
      w.lR = Math.max(0, w.lR - FADE * dt);
      if (w.spike) w.spike.l = Math.max(0, w.spike.l - FADE * dt);
    }
    for (const h of hunters) h.lit = Math.max(0, h.lit - FADE * dt);

    if (state === STATE.READY) {
      sub.y += Math.sin(performance.now() / 700) * 0.15;
      if (pings.length === 0 && Math.random() < 0.012) ping(sub.x, sub.y);
      noise = Math.max(0, noise - NOISE_DECAY * dt);
      return;
    }
    if (state === STATE.DEAD) {
      deadT += dt;
      flash = Math.max(0, flash - dt * 3);
      shake = Math.max(0, shake - dt * 3);
      sub.vy += GRAVITY * dt * 0.4;
      sub.y += sub.vy * dt * 0.3;
      updateHunters(dt);
      return;
    }

    noise = Math.max(0, noise - NOISE_DECAY * dt);

    sub.vy += GRAVITY * dt;
    const k = Math.pow(DRAG, dt);
    sub.vx *= k; sub.vy *= k;
    const sp = Math.hypot(sub.vx, sub.vy);
    if (sp > MAX_SPEED) { sub.vx = sub.vx / sp * MAX_SPEED; sub.vy = sub.vy / sp * MAX_SPEED; }
    if (sub.vy > MAX_FALL) sub.vy = MAX_FALL;
    // Look ahead where you're heading, so speed buys sight instead of spending it.
    const wantLead = Math.max(-40, Math.min(96, sub.vy * 0.30));
    camLead += (wantLead - camLead) * Math.min(1, dt * 3);
    sub.x += sub.vx * dt;
    sub.y += sub.vy * dt;
    sub.a = Math.atan2(sub.vy, sub.vx);

    depth = Math.max(depth, sub.y / 10);
    // Distance covered blind is worth more than distance covered lit.
    silent += dt;
    mult = Math.min(MULT_MAX, 1 + silent / SILENT_RAMP);
    score += Math.max(0, depth - lastDepth) * mult;
    lastDepth = depth;
    multBreak = Math.max(0, multBreak - dt * 2.5);

    // Extend the cave downward and retire rows that scrolled off the top.
    while (genY < sub.y + VH * 1.4) genRow();
    while (walls.length > 4 && walls[0].y < sub.y - VH) walls.shift();
    topY = walls[0].y;

    const row = rowAt(sub.y);
    if (Math.abs(sub.x - row.cx) > row.hw - SUB_R) { die('wall'); return; }
    if (row.spike) {
      const x0 = Math.min(row.spike.x, row.spike.x + row.spike.w);
      const x1 = Math.max(row.spike.x, row.spike.x + row.spike.w);
      if (sub.x + SUB_R > x0 && sub.x - SUB_R < x1) { die('wall'); return; }
    }

    updateHunters(dt);
    for (const h of hunters) {
      if (Math.hypot(h.x - sub.x, h.y - sub.y) < SUB_R + 9) { die('hunter'); return; }
    }

    for (let i = hunters.length - 1; i >= 0; i--) {
      if (hunters[i].y < sub.y - VH) hunters.splice(i, 1);
    }
  }

  function updateHunters(dt) {
    for (const h of hunters) {
      h.ph += dt * 2;
      h.alert = Math.max(0, h.alert - dt * 0.25);
      // Idle drift becomes a directed hunt once it has heard something.
      const speed = 16 + h.alert * (40 + noise * 60);
      const dx = h.tx - h.x, dy = h.ty - h.y;
      const len = Math.hypot(dx, dy) || 1;
      h.vx += (dx / len) * speed * dt * 2.2 + Math.cos(h.ph) * 6 * dt;
      h.vy += (dy / len) * speed * dt * 2.2 + Math.sin(h.ph * 0.7) * 6 * dt;
      const kk = Math.pow(0.9, dt);
      h.vx *= kk; h.vy *= kk;
      h.x += h.vx * dt; h.y += h.vy * dt;
      if (len < 14) { h.tx = h.x + (Math.random() - .5) * 90; h.ty = h.y + (Math.random() - .5) * 90; }
    }
  }

  // A ping is a ring, not a floodlight: only geometry the wave is crossing
  // right now gets lit, which is why the cave arrives in slices.
  // Vertically-elongated lobe: the array is aimed along your line of travel,
  // so it reaches DOWN_REACH times further up and down than it does sideways.
  function lobeDist(dx, dy) {
    return Math.hypot(dx, dy / DOWN_REACH);
  }

  function lightGeometry() {
    for (const p of pings) {
      const r = p.t * PING_SPEED;
      // Sweep the whole span the wave crossed this frame. A fixed-width band
      // would step straight over geometry at this speed.
      const lo = p.pr - PING_BAND * 0.5, hi = r + PING_BAND * 0.5;
      // Distant geometry stays bright — the far reveal is the whole point of it.
      const fade = Math.max(0, 1 - Math.pow(r / PING_MAX, 2.5));
      const reach = r * DOWN_REACH + PING_BAND;
      for (const w of walls) {
        const dy = w.y - p.y;
        if (Math.abs(dy) > reach) continue;
        const lx = w.cx - w.hw, rx = w.cx + w.hw;
        const dL = lobeDist(lx - p.x, dy), dR = lobeDist(rx - p.x, dy);
        if (dL >= lo && dL <= hi) w.lL = Math.max(w.lL, fade);
        if (dR >= lo && dR <= hi) w.lR = Math.max(w.lR, fade);
        if (w.spike) {
          const d = lobeDist(w.spike.x + w.spike.w / 2 - p.x, dy);
          if (d >= lo && d <= hi) w.spike.l = Math.max(w.spike.l, fade);
        }
      }
      for (const h of hunters) {
        const d = lobeDist(h.x - p.x, h.y - p.y);
        if (d >= lo - 6 && d <= hi + 6) h.lit = Math.max(h.lit, fade);
      }
    }
  }

  // --- render -------------------------------------------------------------
  function draw() {
    const w = window.innerWidth, h = window.innerHeight;
    ctx.save();
    ctx.fillStyle = '#03070d';
    ctx.fillRect(0, 0, w, h);
    if (shake > 0) ctx.translate((Math.random() - .5) * 12 * shake, (Math.random() - .5) * 12 * shake);
    ctx.translate(offX, offY);
    ctx.scale(scale, scale);
    ctx.beginPath(); ctx.rect(0, 0, VW, VH); ctx.clip();

    ctx.save();
    ctx.translate(VW / 2, CAM_Y - sub.y - camLead);

    drawMotes();
    drawWalls();
    drawPings();
    drawHunters();
    drawImpact();
    drawSub();

    ctx.restore();
    drawHUD();

    if (flash > 0) {
      ctx.fillStyle = `rgba(255,90,80,${flash * 0.5})`;
      ctx.fillRect(0, 0, VW, VH);
    }
    if (offX > 6) {
      ctx.strokeStyle = 'rgba(90,190,190,.16)';
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 0.5, VW - 1, VH - 1);
    }
    ctx.restore();
  }

  function drawMotes() {
    // Suspended particles: the only thing always faintly visible, so the
    // dark reads as water rather than as an empty screen.
    for (const m of motes) {
      let y = m.y;
      const span = VH * 3;
      y = topY + ((y - topY) % span + span) % span;
      const d = Math.hypot(m.x - sub.x, y - sub.y);
      const near = Math.max(0, 1 - d / 150);
      ctx.fillStyle = `rgba(120,190,220,${0.05 + near * 0.28})`;
      ctx.beginPath();
      ctx.arc(m.x, y, m.r, 0, 6.283);
      ctx.fill();
    }
  }

  function drawWalls() {
    ctx.lineCap = 'round';
    for (let i = 1; i < walls.length; i++) {
      const a = walls[i - 1], b = walls[i];
      if (b.y < sub.y - CAM_Y + camLead - 20 || a.y > sub.y + VH + camLead) continue;
      seg(a.cx - a.hw, a.y, b.cx - b.hw, b.y, Math.max(a.lL, b.lL), a);
      seg(a.cx + a.hw, a.y, b.cx + b.hw, b.y, Math.max(a.lR, b.lR), a);
      if (a.spike) {
        const l = a.spike.l;
        if (l > 0.01) {
          ctx.strokeStyle = `rgba(150,255,215,${l})`;
          ctx.lineWidth = 4;
          ctx.beginPath();
          ctx.moveTo(a.spike.x, a.y);
          ctx.lineTo(a.spike.x + a.spike.w, a.y + SAMPLE * 0.5);
          ctx.stroke();
        }
      }
    }
  }

  function seg(x1, y1, x2, y2, l, row) {
    // Hull glow keeps the immediate surroundings barely readable.
    const dy = row.y - sub.y;
    // Downward-biased hull light: a floor of warning even when running silent.
    const reach = dy > 0 ? GLOW_DOWN : GLOW_R;
    let amb = Math.max(0, 1 - Math.abs(dy) / reach) * (dy > 0 ? 0.30 : 0.32);
    // On death, flood the area you died in so you can see what you hit.
    // Holds bright for a beat, then fades — the lesson, not a punishment.
    if (impact) {
      const md = Math.hypot((x1 + x2) / 2 - impact.x, row.y - impact.y);
      const hold = deadT < 1.4 ? Math.min(1, deadT * 5) : Math.max(0, 1 - (deadT - 1.4) * 0.7);
      amb = Math.max(amb, Math.max(0, 1 - md / DEATH_R) * hold);
    }
    const v = Math.max(l, amb);
    if (v < 0.02) return;
    ctx.strokeStyle = `rgba(130,245,220,${v})`;
    ctx.lineWidth = 2.5;
    ctx.shadowColor = 'rgba(90,230,210,.9)';
    ctx.shadowBlur = 10 * v;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  function drawPings() {
    for (const p of pings) {
      const r = p.t * PING_SPEED;
      const a = Math.max(0, 1 - Math.pow(r / PING_MAX, 2.5)) * 0.45;
      if (a <= 0) continue;
      ctx.strokeStyle = `rgba(120,255,235,${a})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, r, r * DOWN_REACH, 0, 0, 6.283);
      ctx.stroke();
    }
  }

  function drawHunters() {
    for (const h of hunters) {
      const amb = Math.max(0, 1 - Math.hypot(h.x - sub.x, h.y - sub.y) / 70) * 0.3;
      const v = Math.max(h.lit, amb);
      if (v < 0.02) continue;
      ctx.fillStyle = `rgba(255,120,140,${v})`;
      ctx.shadowColor = 'rgba(255,70,100,.9)';
      ctx.shadowBlur = 14 * v;
      ctx.beginPath();
      ctx.arc(h.x, h.y, 7, 0, 6.283);
      ctx.fill();
      // Trailing tendrils, so a hunter never reads as a harmless dot.
      ctx.strokeStyle = `rgba(255,120,140,${v * 0.7})`;
      ctx.lineWidth = 1.5;
      for (let i = 0; i < 4; i++) {
        const ang = h.ph + i * 1.57;
        ctx.beginPath();
        ctx.moveTo(h.x, h.y);
        ctx.quadraticCurveTo(
          h.x + Math.cos(ang) * 10, h.y + Math.sin(ang) * 10,
          h.x + Math.cos(ang) * 17, h.y + Math.sin(ang) * 17 + Math.sin(h.ph * 2) * 3);
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
    }
  }

  function drawImpact() {
    if (!impact) return;
    const hold = deadT < 1.4 ? 1 : Math.max(0, 1 - (deadT - 1.4) * 0.7);
    if (hold <= 0) return;
    const col = impact.hunter ? '255,120,140' : '255,190,120';
    // Expanding shock ring, then a steady crosshair on the exact spot.
    const r = Math.min(deadT, 0.5) * 90;
    ctx.strokeStyle = `rgba(${col},${(1 - Math.min(1, deadT / 0.5)) * 0.7})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(impact.x, impact.y, r, 0, 6.283);
    ctx.stroke();

    ctx.strokeStyle = `rgba(${col},${hold * 0.85})`;
    ctx.lineWidth = 1.5;
    const g = 7;
    ctx.beginPath();
    ctx.moveTo(impact.x - g - 6, impact.y); ctx.lineTo(impact.x - g, impact.y);
    ctx.moveTo(impact.x + g, impact.y); ctx.lineTo(impact.x + g + 6, impact.y);
    ctx.moveTo(impact.x, impact.y - g - 6); ctx.lineTo(impact.x, impact.y - g);
    ctx.moveTo(impact.x, impact.y + g); ctx.lineTo(impact.x, impact.y + g + 6);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(impact.x, impact.y, g, 0, 6.283);
    ctx.stroke();
  }

  function drawSub() {
    ctx.save();
    ctx.translate(sub.x, sub.y);
    ctx.shadowColor = 'rgba(150,255,240,.9)';
    ctx.shadowBlur = 18;
    ctx.fillStyle = '#dffff8';
    ctx.beginPath();
    ctx.arc(0, 0, SUB_R * 0.55, 0, 6.283);
    ctx.fill();
    ctx.strokeStyle = 'rgba(150,255,240,.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, SUB_R, 0, 6.283);
    ctx.stroke();

    if (state === STATE.PLAYING && mult > 1.02) {
      const f = (mult - 1) / (MULT_MAX - 1);
      ctx.strokeStyle = `rgba(180,255,200,${0.25 + f * 0.6})`;
      ctx.lineWidth = 1 + f * 1.6;
      ctx.beginPath();
      ctx.arc(0, 0, SUB_R + 5 + f * 4, -1.571, -1.571 + 6.283 * f);
      ctx.stroke();
    }
    if (multBreak > 0) {
      ctx.strokeStyle = `rgba(255,170,120,${multBreak * 0.8})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, SUB_R + 8 + (1 - multBreak) * 22, 0, 6.283);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawHUD() {
    ctx.textAlign = 'center';
    if (state === STATE.READY) {
      ctx.fillStyle = 'rgba(190,255,245,.95)';
      ctx.font = '300 38px system-ui, sans-serif';
      ctx.letterSpacing = '10px';
      ctx.fillText('FATHOM', VW / 2, 150);
      ctx.letterSpacing = '0px';
      ctx.font = '13px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(150,220,215,.75)';
      ctx.fillText('every ping shows you the way', VW / 2, 186);
      ctx.fillText('and tells them where you are', VW / 2, 206);
      ctx.fillStyle = 'rgba(150,255,200,.7)';
      ctx.fillText('dive blind \u2014 silence pays up to \u00d73', VW / 2, 232);
      if (best > 0) {
        ctx.fillStyle = 'rgba(120,190,190,.55)';
        ctx.fillText('best  ' + best, VW / 2, 266);
      }
      return;
    }

    ctx.textAlign = 'left';
    ctx.font = '600 26px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(200,255,248,.92)';
    ctx.fillText(Math.floor(score), 18, 44);
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(140,200,200,.55)';
    ctx.fillText(Math.floor(depth) + 'm down', 18, 60);

    // Multiplier: the reward for staying dark, sitting right next to the score.
    const f = (mult - 1) / (MULT_MAX - 1);
    ctx.font = '600 17px system-ui, sans-serif';
    ctx.fillStyle = multBreak > 0
      ? `rgba(255,170,120,${0.5 + multBreak * 0.5})`
      : `rgba(${150 - f * 30},255,${200 + f * 30},${0.45 + f * 0.5})`;
    ctx.fillText('\u00d7' + mult.toFixed(1), 18, 84);

    // Noise meter — the visible price of seeing.
    const bw = 96, bx = VW - bw - 18, by = 34;
    ctx.fillStyle = 'rgba(255,255,255,.12)';
    ctx.fillRect(bx, by, bw, 5);
    const danger = noise > 0.6;
    ctx.fillStyle = danger ? 'rgba(255,110,130,.95)' : 'rgba(120,255,235,.8)';
    ctx.fillRect(bx, by, bw * noise, 5);
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = danger ? 'rgba(255,140,155,.9)' : 'rgba(150,220,215,.6)';
    ctx.textAlign = 'right';
    ctx.fillText(danger ? 'THEY HEAR YOU' : 'NOISE', VW - 18, by - 7);

    if (state === STATE.DEAD && deadT > 0.4) {
      const a = Math.min(1, (deadT - 0.4) * 2.5);
      ctx.globalAlpha = a;
      ctx.textAlign = 'center';
      ctx.font = '300 26px system-ui, sans-serif';
      ctx.letterSpacing = '6px';
      ctx.fillStyle = 'rgba(255,150,160,.95)';
      ctx.fillText('LOST', VW / 2, VH / 2 - 30);
      ctx.letterSpacing = '0px';
      ctx.font = '600 44px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(210,255,250,.95)';
      ctx.fillText(Math.floor(score), VW / 2, VH / 2 + 22);
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(150,220,215,.6)';
      ctx.fillText(Math.floor(depth) + 'm deep', VW / 2, VH / 2 + 44);
      ctx.fillStyle = impact && impact.hunter ? 'rgba(255,150,160,.75)' : 'rgba(255,190,140,.75)';
      ctx.fillText(impact && impact.hunter ? 'something found you' : 'you hit the wall here', VW / 2, VH / 2 + 66);
      ctx.fillStyle = 'rgba(150,220,215,.65)';
      ctx.fillText(Math.floor(score) >= best ? 'NEW RECORD' : 'best  ' + best, VW / 2, VH / 2 + 92);
      ctx.globalAlpha = 1;
    }
  }

  let last = performance.now();
  function loop(now) {
    const dt = Math.min((now - last) / 1000, 1 / 30);
    last = now;
    update(dt);
    draw();
    requestAnimationFrame(loop);
  }

  reset();
  requestAnimationFrame(loop);

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
})();
