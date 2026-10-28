// Wave & Wheel: two sequencers sharing one transport.
//  - Wave: each track is a sum of sine partials scrolling past a playhead;
//    a sample fires whenever the wave crosses its threshold.
//  - Wheel: concentric ring roads rotate at their own speeds; each car
//    plays its note when it drives through the crossing at 12 o'clock.
(function () {
  'use strict';

  const STORAGE_KEY = 'wave-wheel-v1';
  const LOOKAHEAD = 0.12;      // seconds of audio scheduled ahead
  const TICK_MS = 25;
  const EVAL_STEP = 0.001;     // wave sampling resolution in seconds
  const HYSTERESIS = 0.04;
  const VIEW_BARS = 2;         // bars visible in the wave view
  const PLAYHEAD_X = 0.3;

  const SPEEDS = [0.25, 1 / 3, 0.5, 2 / 3, 0.75, 1, 1.25, 4 / 3, 1.5, 2, 3];
  const SPEED_LABELS = ['1/4', '1/3', '1/2', '2/3', '3/4', '1', '5/4', '4/3', '3/2', '2', '3'];
  const RATES = [0, 0.125, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];
  const EDGES = ['rise', 'fall', 'both', 'peak'];
  const LANE_HUES = [8, 40, 190, 140, 280, 330, 60, 220];

  // ---------------------------------------------------------------- state

  function track(sample, partials, extra) {
    const ps = partials.map(([f, a, p]) => ({ f, a, p }));
    while (ps.length < 3) ps.push({ f: 1, a: 0, p: 0 });
    return Object.assign({
      sample, gain: 0.8, pan: 0, edge: 'rise', threshold: 0,
      partials: ps, octave: 0, melodyDepth: 0, melodyRate: 0.5, mute: false,
    }, extra);
  }

  function ring(inst, slots, speedIdx, notes, extra) {
    const cars = new Array(slots).fill(null);
    for (const [slot, deg] of notes) cars[slot] = deg;
    return Object.assign({ inst, gain: 0.7, pan: 0, speedIdx, dir: 1, octave: 0, cars, mute: false }, extra);
  }

  function defaultState() {
    return {
      mode: 'wave', bpm: 96, root: 57, scale: 'minor pent',
      tracks: [
        track('kick', [[4, 1, 0]], { gain: 0.95 }),
        track('snare', [[2, 1, 0.5]], { gain: 0.7 }),
        track('hat', [[8, 1, 0], [1, 0.45, 0.25]], { edge: 'both', threshold: 0.25, gain: 0.5, pan: 0.3 }),
        track('bass', [[3, 1, 0], [1.25, 0.5, 0]], { octave: -1, melodyDepth: 3, melodyRate: 0.5, gain: 0.7 }),
        track('marimba', [[5, 1, 0], [0.75, 0.6, 0.1]], { edge: 'peak', threshold: 0.3, melodyDepth: 5, melodyRate: 0.75, pan: -0.3, gain: 0.6 }),
        track('rim', [[6, 1, 0], [1.5, 0.8, 0]], { threshold: 0.7, gain: 0.5, pan: 0.5 }),
      ],
      rings: [
        ring('marimba', 16, 5, [[0, 0], [3, 2], [6, 4], [8, 3], [11, 1], [14, 5]], { pan: -0.2 }),
        ring('bell', 12, 4, [[0, 4], [5, 7], [8, 6]], { octave: 1, gain: 0.45, pan: 0.3 }),
        ring('bass', 8, 2, [[0, 0], [3, -2], [5, 2]], { octave: -1, gain: 0.8 }),
        ring('pluck', 6, 7, [[0, 2], [2, 4], [4, 0]], { dir: -1, gain: 0.55 }),
      ],
    };
  }

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (s && Array.isArray(s.tracks) && Array.isArray(s.rings)) return s;
    } catch (e) { /* fall through to defaults */ }
    return null;
  }

  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* storage unavailable */ }
    }, 300);
  }

  let state = load() || defaultState();
  let selTrack = 0, selRing = 0, selRow = 0, cursorSlot = 0;

  // ---------------------------------------------------------------- audio

  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const kit = new Kit(ctx);

  // Transport: song position in bars is anchored to an AudioContext time so
  // tempo changes stay continuous.
  let playing = false;
  let anchor = { time: 0, bars: 0 };
  let evalTime = 0;
  let schedTimer = null;
  let detectors = [];
  let ringPhase = [];      // revolutions, at evalTime
  let flashes = [];        // visual events: {kind, idx, time, vel, slot}

  function barDur() { return 240 / state.bpm; }
  function posAt(t) { return anchor.bars + (t - anchor.time) / barDur(); }

  function setBpm(bpm) {
    bpm = Math.max(40, Math.min(220, Math.round(bpm)));
    if (playing) anchor = { time: evalTime, bars: posAt(evalTime) };
    state.bpm = bpm;
    save();
  }

  function waveValue(t, p) {
    let sum = 0, norm = 0;
    for (const q of t.partials) {
      if (q.a <= 0) continue;
      sum += q.a * Math.sin(2 * Math.PI * (q.f * p + q.p));
      norm += q.a;
    }
    return norm > 0 ? sum / norm : 0;
  }

  function maxSlope(t) {
    let s = 0, norm = 0;
    for (const q of t.partials) { s += 2 * Math.PI * q.a * q.f; norm += q.a; }
    return norm > 0 && s > 0 ? s / norm : 1;
  }

  // Stateful threshold detector. step() is fed successive samples and returns
  // {frac, vel} when a trigger lands between the previous sample and this one.
  function makeDetector(t) {
    let prev = null, prevSlope = 0, armedUp = false, armedDown = false;
    const ms = maxSlope(t);
    return function step(v, dp) {
      let hit = null;
      if (prev !== null) {
        const th = t.threshold;
        const slope = (v - prev) / dp;
        const slopeVel = 0.3 + 0.7 * Math.min(1, Math.abs(slope) / ms);
        if (t.edge === 'peak') {
          if (prevSlope > 0 && slope <= 0 && prev >= th) hit = { frac: 0, vel: 0.3 + 0.35 * (prev + 1) };
        } else {
          if (prev < th - HYSTERESIS) armedUp = true;
          if (prev > th + HYSTERESIS) armedDown = true;
          if ((t.edge === 'rise' || t.edge === 'both') && armedUp && prev < th && v >= th) {
            hit = { frac: (th - prev) / (v - prev), vel: slopeVel };
            armedUp = false;
          } else if ((t.edge === 'fall' || t.edge === 'both') && armedDown && prev > th && v <= th) {
            hit = { frac: (prev - th) / (prev - v), vel: slopeVel };
            armedDown = false;
          }
        }
        prevSlope = slope;
      }
      prev = v;
      return hit;
    };
  }

  function trackMidi(t, p) {
    const deg = t.melodyDepth > 0 && t.melodyRate > 0
      ? Math.round(t.melodyDepth * Math.sin(2 * Math.PI * t.melodyRate * p)) : 0;
    return Music.degreeToMidi(state.root + 12 * t.octave, state.scale, deg);
  }

  function ringMidi(r, deg) {
    return Music.degreeToMidi(state.root + 12 * r.octave, state.scale, deg);
  }

  function start() {
    if (ctx.state !== 'running') ctx.resume();
    playing = true;
    evalTime = ctx.currentTime + 0.05;
    // Start a hair before bar 0 and prime the detectors on the lead-in so
    // events that land exactly on the downbeat still fire.
    const dp = EVAL_STEP / barDur();
    anchor = { time: evalTime, bars: -2 * dp };
    detectors = state.tracks.map((t) => {
      const det = makeDetector(t);
      for (let p = -0.1; p <= -2 * dp; p += dp) det(waveValue(t, p), dp);
      return det;
    });
    ringPhase = state.rings.map((r) => (r.dir > 0 ? -1e-9 : 0));
    flashes = [];
    schedTimer = setInterval(schedule, TICK_MS);
    schedule();
  }

  function stop() {
    playing = false;
    clearInterval(schedTimer);
  }

  function rebuildDetector(i) {
    if (playing) detectors[i] = makeDetector(state.tracks[i]);
  }

  function schedule() {
    const horizon = ctx.currentTime + LOOKAHEAD;
    if (horizon <= evalTime) return;

    // Wave tracks: sample each wave on a fine grid and look for crossings.
    state.tracks.forEach((t, i) => {
      if (!detectors[i]) detectors[i] = makeDetector(t);
      const det = detectors[i];
      for (let time = evalTime; time < horizon; time += EVAL_STEP) {
        const p = posAt(time + EVAL_STEP);
        const hit = det(waveValue(t, p), EVAL_STEP / barDur());
        if (!hit) continue;
        const when = time + hit.frac * EVAL_STEP;
        if (!t.mute) kit.play(t.sample, when, { gain: t.gain * hit.vel, pan: t.pan, midi: trackMidi(t, p) });
        flashes.push({ kind: 'wave', idx: i, time: when, vel: hit.vel, pos: posAt(when) });
      }
    });

    // Rings: a car fires when (slot offset + ring phase) crosses an integer.
    const dBars = posAt(horizon) - posAt(evalTime);
    state.rings.forEach((r, i) => {
      const speed = SPEEDS[r.speedIdx] * r.dir;
      const ph0 = ringPhase[i] || 0;
      const ph1 = ph0 + speed * dBars;
      r.cars.forEach((deg, slot) => {
        if (deg === null) return;
        const x0 = slot / r.cars.length + ph0, x1 = slot / r.cars.length + ph1;
        if (Math.floor(x0) === Math.floor(x1)) return;
        const boundary = speed > 0 ? Math.floor(x1) : Math.floor(x0);
        const when = evalTime + ((boundary - x0) / (x1 - x0)) * (horizon - evalTime);
        if (!r.mute) kit.play(r.inst, when, { gain: r.gain, pan: r.pan, midi: ringMidi(r, deg) });
        flashes.push({ kind: 'ring', idx: i, slot, time: when, vel: 1 });
      });
      ringPhase[i] = ph1 - Math.floor(ph1);
    });

    evalTime = horizon;
    const now = ctx.currentTime;
    flashes = flashes.filter((f) => f.time > now - 1);
  }

  // Ring phase at an arbitrary time, extrapolated back from evalTime.
  function ringPhaseAt(i, time) {
    if (!playing) return ringPhase[i] || 0;
    const r = state.rings[i];
    return (ringPhase[i] || 0) - SPEEDS[r.speedIdx] * r.dir * (posAt(evalTime) - posAt(time));
  }

  // ---------------------------------------------------------------- editing

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function round(v, step) { return Math.round(v / step) * step; }
  function cycle(list, cur, d) { const i = list.indexOf(cur); return list[(i + d + list.length) % list.length]; }
  function fmt(v, digits = 2) { return (Math.round(v * 100) / 100).toFixed(digits); }

  function randomizeTrack(t) {
    const fs = [0.5, 1, 1.5, 2, 3, 4, 5, 6, 8];
    t.partials = [0, 1, 2].map((k) => ({
      f: k === 0 ? fs[2 + Math.floor(Math.random() * 7)] : fs[Math.floor(Math.random() * fs.length)] * (Math.random() < 0.3 ? 0.75 : 1),
      a: k === 0 ? 1 : round(Math.random() * 0.7, 0.05),
      p: round(Math.random(), 1 / 16),
    }));
    t.edge = EDGES[Math.floor(Math.random() * EDGES.length)];
    t.threshold = round(Math.random() * 1.2 - 0.4, 0.05);
    if (kit.isPitched(t.sample)) { t.melodyDepth = 1 + Math.floor(Math.random() * 6); t.melodyRate = RATES[1 + Math.floor(Math.random() * 8)]; }
  }

  function randomizeRing(r) {
    let walk = 0;
    r.cars = r.cars.map(() => {
      if (Math.random() > 0.4) return null;
      walk = clamp(walk + Math.floor(Math.random() * 5) - 2, -4, 9);
      return walk;
    });
    if (r.cars.every((c) => c === null)) r.cars[0] = 0;
    r.speedIdx = Math.floor(Math.random() * SPEEDS.length);
  }

  function resizeRing(r, slots) {
    const cars = new Array(slots).fill(null);
    r.cars.forEach((deg, i) => {
      if (deg === null) return;
      const j = Math.round((i / r.cars.length) * slots) % slots;
      if (cars[j] === null) cars[j] = deg;
    });
    r.cars = cars;
    cursorSlot = Math.min(cursorSlot, slots - 1);
  }

  // Panel rows. Each row: label, value() string, nudge(d), optional dim().
  function trackRows() {
    const t = state.tracks[selTrack];
    const rows = [
      { label: 'Sample', value: () => t.sample, nudge: (d) => { t.sample = cycle(kit.names(), t.sample, d); } },
      { label: 'Volume', value: () => fmt(t.gain), nudge: (d) => { t.gain = clamp(round(t.gain + d * 0.05, 0.05), 0, 1); } },
      { label: 'Pan', value: () => fmt(t.pan, 1), nudge: (d) => { t.pan = clamp(round(t.pan + d * 0.1, 0.1), -1, 1); } },
      { label: 'Trigger on', value: () => t.edge, nudge: (d) => { t.edge = cycle(EDGES, t.edge, d); rebuildDetector(selTrack); } },
      { label: 'Threshold', value: () => fmt(t.threshold), nudge: (d) => { t.threshold = clamp(round(t.threshold + d * 0.05, 0.05), -0.95, 0.95); } },
    ];
    t.partials.forEach((q, k) => {
      rows.push(
        { label: `Wave ${k + 1} cycles/bar`, value: () => fmt(q.f), nudge: (d) => { q.f = clamp(round(q.f + d * 0.25, 0.25), 0, 16); rebuildDetector(selTrack); } },
        { label: `Wave ${k + 1} amount`, value: () => fmt(q.a), nudge: (d) => { q.a = clamp(round(q.a + d * 0.05, 0.05), 0, 1); rebuildDetector(selTrack); } },
        { label: `Wave ${k + 1} phase`, value: () => fmt(q.p), nudge: (d) => { q.p = round((q.p + d / 32 + 1) % 1, 1 / 32); } },
      );
    });
    const pitched = () => kit.isPitched(t.sample);
    rows.push(
      { label: 'Octave', value: () => (t.octave > 0 ? '+' : '') + t.octave, nudge: (d) => { t.octave = clamp(t.octave + d, -3, 3); }, dim: () => !pitched() },
      { label: 'Melody depth', value: () => String(t.melodyDepth), nudge: (d) => { t.melodyDepth = clamp(t.melodyDepth + d, 0, 8); }, dim: () => !pitched() },
      { label: 'Melody cycles/bar', value: () => String(t.melodyRate), nudge: (d) => { t.melodyRate = cycle(RATES, t.melodyRate, d); }, dim: () => !pitched() },
      { label: 'Mute', value: () => (t.mute ? 'muted' : 'on'), nudge: () => { t.mute = !t.mute; } },
      { label: 'Randomize', value: () => '◀ ▶', nudge: () => { randomizeTrack(t); rebuildDetector(selTrack); } },
    );
    return rows.concat(globalRows());
  }

  function ringRows() {
    const r = state.rings[selRing];
    return [
      { label: 'Instrument', value: () => r.inst, nudge: (d) => { r.inst = cycle(kit.names(), r.inst, d); } },
      { label: 'Volume', value: () => fmt(r.gain), nudge: (d) => { r.gain = clamp(round(r.gain + d * 0.05, 0.05), 0, 1); } },
      { label: 'Pan', value: () => fmt(r.pan, 1), nudge: (d) => { r.pan = clamp(round(r.pan + d * 0.1, 0.1), -1, 1); } },
      { label: 'Laps/bar', value: () => SPEED_LABELS[r.speedIdx], nudge: (d) => { r.speedIdx = clamp(r.speedIdx + d, 0, SPEEDS.length - 1); } },
      { label: 'Direction', value: () => (r.dir > 0 ? 'clockwise' : 'counter'), nudge: () => { r.dir = -r.dir; } },
      { label: 'Parking spots', value: () => String(r.cars.length), nudge: (d) => { resizeRing(r, clamp(r.cars.length + d, 3, 32)); } },
      { label: 'Octave', value: () => (r.octave > 0 ? '+' : '') + r.octave, nudge: (d) => { r.octave = clamp(r.octave + d, -3, 3); } },
      { label: 'Mute', value: () => (r.mute ? 'muted' : 'on'), nudge: () => { r.mute = !r.mute; } },
      { label: 'Clear ring', value: () => '◀ ▶', nudge: () => { r.cars = r.cars.map(() => null); } },
      { label: 'Randomize', value: () => '◀ ▶', nudge: () => randomizeRing(r) },
    ].concat(globalRows());
  }

  function globalRows() {
    return [
      { label: 'Key (all)', value: () => Music.noteName(state.root), nudge: (d) => { state.root = clamp(state.root + d, 36, 72); }, global: true },
      { label: 'Scale (all)', value: () => state.scale, nudge: (d) => { state.scale = cycle(Object.keys(Music.SCALES), state.scale, d); }, global: true },
      { label: 'Reset everything', value: () => (resetArmed ? 'press again' : '◀ ▶'), nudge: () => { if (resetArmed) resetAll(); else resetArmed = true; }, global: true },
    ];
  }

  let resetArmed = false;

  function rows() { return state.mode === 'wave' ? trackRows() : ringRows(); }

  function resetAll() {
    const wasPlaying = playing;
    stop();
    state = defaultState();
    selTrack = selRing = selRow = cursorSlot = 0;
    save();
    if (wasPlaying) start();
  }

  // ---------------------------------------------------------------- DOM

  const canvas = document.getElementById('stage');
  const g = canvas.getContext('2d');
  const panelEl = document.getElementById('panel');
  const panelTitle = document.getElementById('panel-title');
  const bpmEl = document.getElementById('bpm');
  const playBtn = document.getElementById('play');
  const padEl = document.getElementById('pad');
  const helpEl = document.getElementById('help');
  const overlay = document.getElementById('overlay');
  const tabs = document.querySelectorAll('[data-mode]');

  function togglePlay() { if (playing) stop(); else start(); }

  function setMode(mode) {
    state.mode = mode;
    selRow = 0;
    save();
  }

  playBtn.addEventListener('click', togglePlay);
  tabs.forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  document.getElementById('bpm-down').addEventListener('click', () => setBpm(state.bpm - 1));
  document.getElementById('bpm-up').addEventListener('click', () => setBpm(state.bpm + 1));

  function unlockAudio() {
    ctx.resume().then(() => { if (ctx.state === 'running') overlay.hidden = true; });
  }
  if (ctx.state === 'running') overlay.hidden = true;
  overlay.addEventListener('click', unlockAudio);
  window.addEventListener('keydown', unlockAudio, { once: true });
  window.addEventListener('pointerdown', unlockAudio, { once: true });

  let lastRowsKey = '';
  function renderPanel() {
    const rs = rows();
    selRow = clamp(selRow, 0, rs.length - 1);
    const key = state.mode + selTrack + selRing + rs.length;
    if (key !== lastRowsKey) {
      panelEl.innerHTML = '';
      rs.forEach((r, i) => {
        const el = document.createElement('div');
        el.className = 'row' + (r.global ? ' global' : '');
        el.innerHTML = '<button class="nudge" data-d="-1" aria-label="decrease">◀</button>'
          + '<span class="label"></span><span class="value"></span>'
          + '<button class="nudge" data-d="1" aria-label="increase">▶</button>';
        el.querySelector('.label').textContent = r.label;
        el.addEventListener('click', (e) => {
          selRow = i;
          const d = e.target.dataset && e.target.dataset.d;
          if (d) { rows()[i].nudge(Number(d)); save(); }
        });
        panelEl.appendChild(el);
      });
      lastRowsKey = key;
    }
    const els = panelEl.children;
    rs.forEach((r, i) => {
      const el = els[i];
      el.querySelector('.value').textContent = r.value();
      el.classList.toggle('sel', i === selRow);
      el.classList.toggle('dim', !!(r.dim && r.dim()));
    });
    if (els[selRow] && els[selRow].scrollIntoView && selRowChanged) {
      els[selRow].scrollIntoView({ block: 'nearest' });
      selRowChanged = false;
    }
    if (state.mode === 'wave') {
      const t = state.tracks[selTrack];
      panelTitle.textContent = `Track ${selTrack + 1} · ${t.sample}`;
      panelTitle.style.color = `hsl(${LANE_HUES[selTrack % LANE_HUES.length]} 80% 65%)`;
    } else {
      const r = state.rings[selRing];
      panelTitle.textContent = `Ring ${selRing + 1} · ${r.inst}`;
      panelTitle.style.color = `hsl(${LANE_HUES[(selRing + 2) % LANE_HUES.length]} 80% 65%)`;
    }
    bpmEl.textContent = state.bpm;
    playBtn.textContent = playing ? '■ Stop' : '▶ Play';
    playBtn.classList.toggle('on', playing);
    tabs.forEach((b) => b.classList.toggle('on', b.dataset.mode === state.mode));
    const pad = Input.padName();
    padEl.textContent = pad ? '🎮 ' + pad.replace(/\(.*\)/, '').trim().slice(0, 32) : 'No gamepad (keyboard: see help)';
    const help = state.mode === 'wave' ? HELP_WAVE : HELP_WHEEL;
    if (helpEl.innerHTML !== help) helpEl.innerHTML = help;
  }
  let selRowChanged = false;

  const HELP_COMMON = '<b>Start</b> play/stop · <b>Select</b> switch Wave/Wheel · <b>LT/RT</b> tempo · <b>B</b> mute';
  const HELP_WAVE = HELP_COMMON + '<br><b>LB/RB</b> or <b>right stick ↕</b> track · <b>D-pad ↕</b> setting · <b>D-pad ↔</b> change · <b>A</b> audition'
    + '<br><span class="keys">Keys: arrows · Z=A X=B C=X V=Y · Q/E=LB/RB · 1/3=LT/RT · Enter=Start · Tab=Select · IJKL=right stick</span>';
  const HELP_WHEEL = HELP_COMMON + '<br><b>D-pad ↕</b> ring · <b>D-pad ↔</b> move cursor · <b>A</b> park/remove car · <b>X/Y</b> note down/up · <b>LB/RB</b> laps/bar'
    + '<br><b>Right stick ↕</b> setting · <b>right stick ↔</b> change'
    + '<br><span class="keys">Keys: arrows · Z=A X=B C=X V=Y · Q/E=LB/RB · 1/3=LT/RT · Enter=Start · Tab=Select · IJKL=right stick</span>';

  // ---------------------------------------------------------------- input

  function handleInput() {
    Input.update();
    if (ctx.state !== 'running') {
      // Some browsers let a gamepad press unlock audio; try on any button.
      for (const b of ['a', 'b', 'x', 'y', 'start']) if (Input.pressed(b)) unlockAudio();
    }

    let changed = false;
    if (Input.pressed('start')) togglePlay();
    if (Input.pressed('select')) { setMode(state.mode === 'wave' ? 'wheel' : 'wave'); }
    if (Input.pressed('lt')) { setBpm(state.bpm - 1); }
    if (Input.pressed('rt')) { setBpm(state.bpm + 1); }

    const nudgeRow = (d) => { rows()[selRow].nudge(d); changed = true; };
    const moveRow = (d) => { resetArmed = false; selRow = clamp(selRow + d, 0, rows().length - 1); selRowChanged = true; };

    if (state.mode === 'wave') {
      const n = state.tracks.length;
      if (Input.pressed('lb') || Input.pressed('rup')) { selTrack = (selTrack - 1 + n) % n; }
      if (Input.pressed('rb') || Input.pressed('rdown')) { selTrack = (selTrack + 1) % n; }
      if (Input.pressed('up')) moveRow(-1);
      if (Input.pressed('down')) moveRow(1);
      if (Input.pressed('left') || Input.pressed('rleft')) nudgeRow(-1);
      if (Input.pressed('right') || Input.pressed('rright')) nudgeRow(1);
      const t = state.tracks[selTrack];
      if (Input.pressed('a')) kit.play(t.sample, ctx.currentTime, { gain: t.gain, pan: t.pan, midi: trackMidi(t, 0) });
      if (Input.pressed('b')) { t.mute = !t.mute; changed = true; }
    } else {
      const n = state.rings.length;
      const r = state.rings[selRing];
      if (Input.pressed('up')) { selRing = (selRing - 1 + n) % n; cursorSlot = Math.min(cursorSlot, state.rings[selRing].cars.length - 1); }
      if (Input.pressed('down')) { selRing = (selRing + 1) % n; cursorSlot = Math.min(cursorSlot, state.rings[selRing].cars.length - 1); }
      if (Input.pressed('left')) cursorSlot = (cursorSlot - 1 + r.cars.length) % r.cars.length;
      if (Input.pressed('right')) cursorSlot = (cursorSlot + 1) % r.cars.length;
      if (Input.pressed('a')) {
        r.cars[cursorSlot] = r.cars[cursorSlot] === null ? lastDegree : null;
        if (r.cars[cursorSlot] !== null) previewCar(r, r.cars[cursorSlot]);
        changed = true;
      }
      for (const [btn, d] of [['x', -1], ['y', 1]]) {
        if (!Input.pressed(btn)) continue;
        const cur = r.cars[cursorSlot];
        r.cars[cursorSlot] = clamp((cur === null ? lastDegree : cur) + (cur === null ? 0 : d), -10, 20);
        lastDegree = r.cars[cursorSlot];
        previewCar(r, lastDegree);
        changed = true;
      }
      if (Input.pressed('lb')) { r.speedIdx = clamp(r.speedIdx - 1, 0, SPEEDS.length - 1); changed = true; }
      if (Input.pressed('rb')) { r.speedIdx = clamp(r.speedIdx + 1, 0, SPEEDS.length - 1); changed = true; }
      if (Input.pressed('rup')) moveRow(-1);
      if (Input.pressed('rdown')) moveRow(1);
      if (Input.pressed('rleft')) nudgeRow(-1);
      if (Input.pressed('rright')) nudgeRow(1);
      if (Input.pressed('b')) { r.mute = !r.mute; changed = true; }
    }
    if (changed || Input.pressed('lt') || Input.pressed('rt')) save();
  }
  let lastDegree = 0;

  function previewCar(r, deg) {
    kit.play(r.inst, ctx.currentTime, { gain: r.gain * 0.8, pan: r.pan, midi: ringMidi(r, deg) });
  }

  // Mouse: click lanes to select; click ring slots to park/remove cars;
  // scroll over a car to change its note.
  function wheelGeometry() {
    const w = canvas.width / dpr, h = canvas.height / dpr;
    const cx = w / 2, cy = h / 2 + 10;
    const outer = Math.min(w, h) / 2 - 30;
    const n = state.rings.length;
    const band = Math.min(56, (outer * 0.78) / n);
    return { cx, cy, n, band, radius: (i) => outer - band * (i + 0.5) };
  }

  function slotAt(x, y) {
    const geo = wheelGeometry();
    const dx = x - geo.cx, dy = y - geo.cy;
    const dist = Math.hypot(dx, dy);
    for (let i = 0; i < geo.n; i++) {
      if (Math.abs(dist - geo.radius(i)) > geo.band / 2) continue;
      const r = state.rings[i];
      // Angle from 12 o'clock, clockwise, in revolutions.
      let rev = (Math.atan2(dy, dx) + Math.PI / 2) / (2 * Math.PI);
      rev -= ringPhaseAt(i, ctx.currentTime);
      rev = ((rev % 1) + 1) % 1;
      return { ring: i, slot: Math.round(rev * r.cars.length) % r.cars.length };
    }
    return null;
  }

  canvas.addEventListener('pointerdown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    if (state.mode === 'wave') {
      const lane = Math.floor((y / rect.height) * state.tracks.length);
      if (lane >= 0 && lane < state.tracks.length) selTrack = lane;
    } else {
      const hit = slotAt(x, y);
      if (!hit) return;
      selRing = hit.ring; cursorSlot = hit.slot;
      const r = state.rings[hit.ring];
      r.cars[hit.slot] = r.cars[hit.slot] === null ? lastDegree : null;
      if (r.cars[hit.slot] !== null) previewCar(r, r.cars[hit.slot]);
      save();
    }
  });

  canvas.addEventListener('wheel', (e) => {
    if (state.mode !== 'wheel') return;
    const rect = canvas.getBoundingClientRect();
    const hit = slotAt(e.clientX - rect.left, e.clientY - rect.top);
    if (!hit) return;
    e.preventDefault();
    const r = state.rings[hit.ring];
    if (r.cars[hit.slot] === null) return;
    r.cars[hit.slot] = clamp(r.cars[hit.slot] + (e.deltaY < 0 ? 1 : -1), -10, 20);
    lastDegree = r.cars[hit.slot];
    selRing = hit.ring; cursorSlot = hit.slot;
    previewCar(r, lastDegree);
    save();
  }, { passive: false });

  // Drop audio files to add them as samples (session only).
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    for (const file of e.dataTransfer.files) {
      try {
        const buf = await ctx.decodeAudioData(await file.arrayBuffer());
        const name = file.name.replace(/\.[^.]+$/, '').slice(0, 16);
        kit.addSample(name, buf);
        if (state.mode === 'wave') state.tracks[selTrack].sample = name;
        else state.rings[selRing].inst = name;
        lastRowsKey = '';
      } catch (err) { console.warn('Could not decode', file.name, err); }
    }
  });

  // ---------------------------------------------------------------- drawing

  let dpr = 1;
  function resize() {
    dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
  }
  new ResizeObserver(resize).observe(canvas);

  function flashLevel(f, now, len) {
    const age = now - f.time;
    return age < 0 || age > len ? 0 : 1 - age / len;
  }

  function drawWave(now) {
    const w = canvas.width / dpr, h = canvas.height / dpr;
    const n = state.tracks.length;
    const laneH = h / n;
    const pos = playing ? posAt(now) : 0;
    const p0 = pos - PLAYHEAD_X * VIEW_BARS;
    const pxPerBar = w / VIEW_BARS;
    const xOf = (p) => (p - p0) * pxPerBar;

    // Beat and bar grid.
    for (let b = Math.ceil(p0 * 4); b <= (p0 + VIEW_BARS) * 4; b++) {
      g.strokeStyle = b % 4 === 0 ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.05)';
      g.lineWidth = 1;
      const x = Math.round(xOf(b / 4)) + 0.5;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
    }

    state.tracks.forEach((t, i) => {
      const top = i * laneH, mid = top + laneH / 2, amp = laneH * 0.4;
      const hue = LANE_HUES[i % LANE_HUES.length];
      const sel = i === selTrack;
      let flash = 0;
      for (const f of flashes) if (f.kind === 'wave' && f.idx === i) flash = Math.max(flash, flashLevel(f, now, 0.25) * f.vel);

      g.fillStyle = sel ? `hsla(${hue},60%,50%,${0.1 + flash * 0.25})` : `hsla(${hue},60%,50%,${0.03 + flash * 0.2})`;
      g.fillRect(0, top, w, laneH);
      g.strokeStyle = 'rgba(255,255,255,0.06)';
      g.beginPath(); g.moveTo(0, top + laneH); g.lineTo(w, top + laneH); g.stroke();

      // Threshold line.
      const ty = mid - t.threshold * amp;
      g.setLineDash([4, 6]);
      g.strokeStyle = `hsla(${hue},80%,70%,0.5)`;
      g.beginPath(); g.moveTo(0, ty); g.lineTo(w, ty); g.stroke();
      g.setLineDash([]);

      // Melody contour (faint) for pitched samples.
      if (kit.isPitched(t.sample) && t.melodyDepth > 0 && t.melodyRate > 0) {
        g.strokeStyle = `hsla(${hue},60%,80%,0.18)`;
        g.beginPath();
        for (let x = 0; x <= w; x += 3) {
          const p = p0 + x / pxPerBar;
          const y = mid - Math.round(t.melodyDepth * Math.sin(2 * Math.PI * t.melodyRate * p)) / 8 * amp;
          if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        g.stroke();
      }

      // The wave itself, with past dimmed; and trigger dots from a fresh detector.
      const det = makeDetector(t);
      const dp = VIEW_BARS / w;
      const dots = [];
      g.lineWidth = sel ? 2.5 : 1.6;
      g.beginPath();
      for (let x = 0; x <= w; x += 1) {
        const p = p0 + x / pxPerBar;
        const v = waveValue(t, p);
        const y = mid - v * amp;
        if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
        const hit = det(v, dp);
        if (hit && x > 1) dots.push({ x: x - 1 + hit.frac, y: mid - (t.edge === 'peak' ? waveValue(t, p - dp) : t.threshold) * amp, vel: hit.vel });
      }
      const grad = g.createLinearGradient(0, 0, w, 0);
      const alpha = t.mute ? 0.25 : 1;
      grad.addColorStop(0, `hsla(${hue},70%,55%,${0.25 * alpha})`);
      grad.addColorStop(PLAYHEAD_X, `hsla(${hue},85%,65%,${alpha})`);
      grad.addColorStop(1, `hsla(${hue},85%,72%,${0.9 * alpha})`);
      g.strokeStyle = grad;
      g.stroke();
      g.lineWidth = 1;

      for (const d of dots) {
        const past = d.x < w * PLAYHEAD_X;
        g.fillStyle = past ? `hsla(${hue},40%,60%,0.35)` : `hsla(${hue},90%,75%,${t.mute ? 0.3 : 0.95})`;
        g.beginPath(); g.arc(d.x, d.y, 2 + 3 * d.vel, 0, Math.PI * 2); g.fill();
      }

      // Lane label.
      g.fillStyle = `hsla(${hue},80%,75%,${t.mute ? 0.4 : 0.9})`;
      g.font = '600 13px ui-sans-serif, system-ui, sans-serif';
      g.fillText(`${i + 1} ${t.sample}${t.mute ? ' (muted)' : ''}`, 10, top + 18);
    });

    // Playhead.
    const px = w * PLAYHEAD_X;
    g.strokeStyle = 'rgba(255,255,255,0.85)';
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(px, 0); g.lineTo(px, h); g.stroke();
    g.lineWidth = 1;
  }

  function drawWheel(now) {
    const geo = wheelGeometry();
    const { cx, cy, band } = geo;
    const scaleLen = (Music.SCALES[state.scale] || [0]).length;

    // Crosswalk at 12 o'clock.
    const outerR = geo.radius(0) + band / 2;
    const innerR = geo.radius(geo.n - 1) - band / 2;
    let anyFlash = 0;
    for (const f of flashes) if (f.kind === 'ring') anyFlash = Math.max(anyFlash, flashLevel(f, now, 0.2));

    state.rings.forEach((r, i) => {
      const rad = geo.radius(i);
      const sel = i === selRing;
      const hue = LANE_HUES[(i + 2) % LANE_HUES.length];
      g.lineWidth = band * 0.84;
      g.strokeStyle = sel ? '#3a3b44' : '#2a2b31';
      g.beginPath(); g.arc(cx, cy, rad, 0, Math.PI * 2); g.stroke();
      g.lineWidth = 1.5;
      g.setLineDash([8, 10]);
      g.strokeStyle = r.mute ? 'rgba(255,255,255,0.08)' : `hsla(${hue},70%,70%,${sel ? 0.45 : 0.2})`;
      g.beginPath(); g.arc(cx, cy, rad, 0, Math.PI * 2); g.stroke();
      g.setLineDash([]);
    });

    // Zebra stripes across all roads at the top.
    g.save();
    g.translate(cx, cy);
    const stripeW = 8;
    for (let k = -2; k <= 2; k++) {
      g.fillStyle = `rgba(255,255,255,${0.18 + anyFlash * 0.4})`;
      g.fillRect(k * stripeW * 1.8 - stripeW / 2, -outerR, stripeW, outerR - innerR);
    }
    g.restore();

    // Traffic light above the crossing.
    g.fillStyle = '#18181c';
    g.fillRect(cx - 9, cy - outerR - 26, 18, 22);
    g.fillStyle = anyFlash > 0 ? `rgba(120,255,150,${0.4 + anyFlash * 0.6})` : 'rgba(255,90,70,0.6)';
    g.beginPath(); g.arc(cx, cy - outerR - 15, 6, 0, Math.PI * 2); g.fill();

    // Cars.
    state.rings.forEach((r, i) => {
      const rad = geo.radius(i);
      const sel = i === selRing;
      const phase = ringPhaseAt(i, now);
      const n = r.cars.length;
      const carLen = Math.min(band * 0.9, (2 * Math.PI * rad / n) * 0.7);
      const carW = band * 0.5;
      for (let slot = 0; slot < n; slot++) {
        const deg = r.cars[slot];
        const a = -Math.PI / 2 + 2 * Math.PI * (slot / n + phase);
        const x = cx + rad * Math.cos(a), y = cy + rad * Math.sin(a);
        const isCursor = sel && slot === cursorSlot && state.mode === 'wheel';
        if (deg === null) {
          if (isCursor) {
            g.save(); g.translate(x, y); g.rotate(a + Math.PI / 2);
            g.strokeStyle = 'rgba(255,255,255,0.8)';
            g.setLineDash([3, 3]);
            g.strokeRect(-carLen / 2, -carW / 2, carLen, carW);
            g.setLineDash([]);
            g.restore();
          }
          continue;
        }
        let fl = 0;
        for (const f of flashes) if (f.kind === 'ring' && f.idx === i && f.slot === slot) fl = Math.max(fl, flashLevel(f, now, 0.35));
        const hue = (((deg % scaleLen) + scaleLen) % scaleLen) / scaleLen * 360;
        const oct = Math.floor(deg / scaleLen);
        const light = clamp(55 + oct * 12 + fl * 25, 25, 92);
        g.save();
        g.translate(x, y);
        g.rotate(a + Math.PI / 2 * r.dir);
        const s = 1 + fl * 0.35;
        g.scale(s, s);
        if (fl > 0) { g.shadowColor = `hsl(${hue},90%,70%)`; g.shadowBlur = 18 * fl; }
        g.fillStyle = r.mute ? `hsla(${hue},20%,${light}%,0.35)` : `hsl(${hue},75%,${light}%)`;
        roundRect(-carLen / 2, -carW / 2, carLen, carW, carW * 0.35);
        g.fill();
        g.shadowBlur = 0;
        // Windshield toward the direction of travel.
        g.fillStyle = 'rgba(20,20,30,0.55)';
        g.fillRect(carLen * 0.12, -carW * 0.32, carLen * 0.18, carW * 0.64);
        if (isCursor) {
          g.strokeStyle = '#fff'; g.lineWidth = 2;
          roundRect(-carLen / 2 - 3, -carW / 2 - 3, carLen + 6, carW + 6, carW * 0.4);
          g.stroke(); g.lineWidth = 1;
        }
        g.restore();
        if (sel) {
          g.fillStyle = 'rgba(255,255,255,0.75)';
          g.font = '10px ui-monospace, monospace';
          g.textAlign = 'center';
          const lr = rad + band * 0.62 * (i === 0 ? 1 : -1);
          g.fillText(Music.noteName(ringMidi(r, deg)), cx + lr * Math.cos(a), cy + lr * Math.sin(a) + 3);
          g.textAlign = 'start';
        }
      }
    });

    // Hub.
    g.fillStyle = '#121216';
    g.beginPath(); g.arc(cx, cy, Math.max(10, innerR - 6), 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.5)';
    g.font = '600 12px ui-sans-serif, system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText(`${Music.noteName(state.root)} ${state.scale}`, cx, cy + 4);
    g.textAlign = 'start';
  }

  function roundRect(x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function frame() {
    handleInput();
    if (canvas.width === 0) resize();
    const now = ctx.currentTime;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#16161b';
    g.fillRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    if (state.mode === 'wave') drawWave(now); else drawWheel(now);
    renderPanel();
    requestAnimationFrame(frame);
  }

  resize();
  requestAnimationFrame(frame);

  // Test hook: lets headless checks drive the app without real time.
  window.__waveWheel = { state: () => state, start, stop, schedule, flashes: () => flashes, ctx };
})();
