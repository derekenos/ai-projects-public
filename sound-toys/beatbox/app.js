// Beatbox → Drums: record yourself beatboxing, get an editable drum loop.
// Hits are classified by rules at first and by your own sounds once you
// teach it (or correct it); quantizing can keep your feel.
(function () {
  'use strict';

  const B = globalThis.Beatbox;
  const STORAGE_KEY = 'beatbox-drums-v1';
  const CLASS_COLORS = { kick: '#ff8a5c', snare: '#5cc8ff', hat: '#c8ff5c' };
  const GRIDS = [2, 4, 3, 6];
  const GRID_LABELS = { 2: '1/8', 4: '1/16', 3: '1/8 triplets', 6: '1/16 triplets' };
  const BARS = ['auto', 1, 2, 4, 8];
  const LISTEN = ['drums', 'voice', 'both'];
  const MAX_SECONDS = 30;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const cycle = (list, cur, d) => list[(list.indexOf(cur) + d + list.length) % list.length];

  // ------------------------------------------------------------ persistent state

  const defaults = {
    bpm: 100, t0: 0, grid: 4, strength: 0.75, groove: 'mine', swing: 0, bars: 'auto',
    listen: 'drums', sounds: { kick: 'kick', snare: 'snare', hat: 'hat' },
    metronome: false, sensitivity: 1.5, teach: 'off',
  };
  let settings = Object.assign({}, defaults);
  let classifier = new B.Classifier();
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved) {
      settings = Object.assign(settings, saved.settings || {});
      classifier = new B.Classifier(saved.classifier);
    }
  } catch (e) { /* storage unavailable */ }
  settings.teach = 'off';

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ settings, classifier })); } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------ session state

  let take = null;          // {samples, sr, buffer}
  let hits = [];            // detected hits with features and class
  let selHit = 0;
  let message = 'Press Start (Enter) and beatbox a bar or two.';
  let messageTime = 0;

  function say(msg) { message = msg; messageTime = performance.now(); }

  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const kit = new Kit(ctx);

  // ------------------------------------------------------------ microphone

  let mic = null;           // {stream, source, proc}
  let recording = null;     // {chunks, length, startCtx, countInEnd}
  let countIn = null;       // ctx time when recording begins after count-in
  let liveOn = false;
  let live = null;          // streaming tracker state

  async function ensureMic() {
    if (mic) return true;
    try {
      await ctx.resume();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const source = ctx.createMediaStreamSource(stream);
      const proc = ctx.createScriptProcessor(512, 1, 1);
      const sink = ctx.createGain();
      sink.gain.value = 0;
      source.connect(proc).connect(sink).connect(ctx.destination);
      proc.onaudioprocess = onMicAudio;
      mic = { stream, source, proc };
      return true;
    } catch (e) {
      say(`Microphone unavailable (${e.name || e}). You can also drop an audio file here.`);
      return false;
    }
  }

  function onMicAudio(e) {
    const input = e.inputBuffer.getChannelData(0);
    if (recording && ctx.currentTime >= recording.startCtx) {
      recording.chunks.push(new Float32Array(input));
      recording.length += input.length;
      if (recording.length / ctx.sampleRate >= MAX_SECONDS) setTimeout(stopRecording, 0);
    }
    if (liveOn) feedLive(input);
  }

  // Live monitor: the same onset tracker, fed as audio arrives; each hit is
  // classified from its first 23 ms and answered with a drum sound.
  function resetLive() {
    live = {
      tracker: new B.OnsetTracker(ctx.sampleRate, { sensitivity: settings.sensitivity }),
      ring: new Float32Array(16384), written: 0, sinceHop: 0, pending: [], flashes: [],
    };
  }

  function feedLive(input) {
    const L = live, ring = L.ring, size = ring.length;
    for (let i = 0; i < input.length; i++) {
      ring[L.written % size] = input[i];
      L.written++;
      L.sinceHop++;
      if (L.sinceHop >= B.HOP && L.written >= B.FRAME) {
        L.sinceHop = 0;
        const frame = new Float32Array(B.FRAME);
        for (let k = 0; k < B.FRAME; k++) frame[k] = ring[(L.written - B.FRAME + k) % size];
        if (L.tracker.push(frame).onset) L.pending.push(L.written - 2 * B.HOP);
      }
    }
    while (L.pending.length && L.written - L.pending[0] >= B.FRAME + B.HOP) {
      const start = L.pending.shift();
      const win = new Float32Array(B.FRAME + 2 * B.HOP);
      for (let k = 0; k < win.length; k++) win[k] = ring[(start + k) % size];
      let peak = 0;
      for (let k = 0; k < 2 * B.HOP; k++) peak = Math.max(peak, Math.abs(win[k]));
      let idx = 0;
      while (idx < 2 * B.HOP && Math.abs(win[idx]) < peak * 0.25) idx++;
      const f = B.features(win, ctx.sampleRate, idx);
      const { cls } = classifier.classify(f);
      kit.play(settings.sounds[cls], ctx.currentTime, { gain: clamp(peak * 3, 0.3, 1) });
      L.flashes.push({ cls, t: performance.now() });
      if (L.flashes.length > 24) L.flashes.shift();
    }
  }

  async function toggleLive() {
    if (!liveOn && !(await ensureMic())) return;
    liveOn = !liveOn;
    if (liveOn) resetLive();
    say(liveOn ? 'Live monitor on: beatbox and hear drums (headphones help).' : 'Live monitor off.');
  }

  // ------------------------------------------------------------ recording

  async function startRecording() {
    if (!(await ensureMic())) return;
    stopLoop();
    const bar = 240 / settings.bpm;
    let startCtx = ctx.currentTime;
    if (settings.metronome) {
      // One bar of count-in, then keep clicking while recording.
      startCtx = ctx.currentTime + 0.1 + bar;
      metronomeFrom = startCtx - bar;
      metronomeNext = metronomeFrom;
    }
    countIn = settings.metronome ? startCtx : null;
    recording = { chunks: [], length: 0, startCtx, teach: settings.teach };
    say(settings.teach !== 'off' ? `Teaching: make only ${settings.teach} sounds, then press Start.` : 'Recording… press Start again to stop.');
  }

  function stopRecording() {
    if (!recording) return;
    const rec = recording;
    recording = null;
    metronomeFrom = null;
    const samples = new Float32Array(rec.length);
    let o = 0;
    for (const c of rec.chunks) { samples.set(c, o); o += c.length; }
    if (samples.length < ctx.sampleRate * 0.3) { say('That take was too short.'); return; }

    if (rec.teach !== 'off') {
      const found = B.detectOnsets(samples, ctx.sampleRate, { sensitivity: settings.sensitivity });
      for (const h of found) classifier.add(B.features(samples, ctx.sampleRate, h.index).vector, rec.teach);
      save();
      say(`Learned ${found.length} ${rec.teach} sound${found.length === 1 ? '' : 's'}. ${trainingSummary()}`);
      return;
    }
    // With the metronome, tempo and downbeat are known: the take starts on beat 1.
    loadTake(samples, ctx.sampleRate, settings.metronome ? { bpm: settings.bpm, t0: Math.max(0, ctx.baseLatency || 0) } : null);
  }

  function trainingSummary() {
    const n = classifier.counts();
    return classifier.isTrained()
      ? `Using your sounds (${n.kick} kick, ${n.snare} snare, ${n.hat} hat).`
      : `Using built-in rules until it knows 2+ of at least two sounds (${n.kick}/${n.snare}/${n.hat}).`;
  }

  function loadTake(samples, sr, tempo) {
    const buffer = ctx.createBuffer(1, samples.length, sr);
    buffer.getChannelData(0).set(samples);
    take = { samples, sr, buffer };
    analyze(tempo);
  }

  function analyze(tempo) {
    if (!take) return;
    const found = B.detectOnsets(take.samples, take.sr, { sensitivity: settings.sensitivity });
    hits = found.map((h) => {
      const f = B.features(take.samples, take.sr, h.index);
      const c = classifier.classify(f);
      return Object.assign(h, { f, cls: c.cls, how: c.how, conf: c.confidence });
    });
    if (tempo) { settings.bpm = tempo.bpm; settings.t0 = tempo.t0; }
    else if (hits.length) Object.assign(settings, B.estimateTempo(hits));
    selHit = 0;
    save();
    const n = { kick: 0, snare: 0, hat: 0 };
    hits.forEach((h) => n[h.cls]++);
    say(hits.length
      ? `${hits.length} hits: ${n.kick} kick, ${n.snare} snare, ${n.hat} hat at ${settings.bpm} BPM. Press A to play.`
      : 'No hits found. Try a louder take, or raise Sensitivity.');
  }

  // ------------------------------------------------------------ derived pattern

  function barDur() { return 240 / settings.bpm; }

  function pattern() {
    if (!hits.length) return { q: [], loopLen: barDur(), bars: 1 };
    const q = B.quantize(hits, settings);
    let bars = settings.bars;
    if (bars === 'auto') {
      const last = Math.max(...q.map((h) => h.qtime)) - settings.t0;
      const need = Math.max(1, Math.ceil((last + 1e-3) / barDur() - 0.02));
      bars = [1, 2, 4, 8].find((b) => b >= need) || 8;
    }
    return { q, loopLen: bars * barDur(), bars };
  }

  // ------------------------------------------------------------ playback

  let looping = false, loopStart = 0, loopTimer = null, scheduledUntil = 0;
  let voiceSources = [];
  let metronomeFrom = null, metronomeNext = 0;

  function startLoop() {
    if (!hits.length) { say('Record a take first (Start).'); return; }
    ctx.resume();
    looping = true;
    loopStart = ctx.currentTime + 0.08;
    scheduledUntil = loopStart;
    loopTimer = setInterval(scheduleLoop, 25);
    scheduleLoop();
  }

  function stopLoop() {
    looping = false;
    clearInterval(loopTimer);
    voiceSources.forEach((s) => { try { s.stop(); } catch (e) { /* already stopped */ } });
    voiceSources = [];
  }

  function scheduleLoop() {
    const { q, loopLen } = pattern();
    const horizon = ctx.currentTime + 0.15;
    while (scheduledUntil < horizon) {
      const winStart = scheduledUntil, winEnd = Math.min(horizon, scheduledUntil + 0.05);
      const k0 = Math.floor((winStart - loopStart) / loopLen);
      const k1 = Math.floor((winEnd - loopStart) / loopLen);
      for (let k = k0; k <= k1; k++) {
        const base = loopStart + k * loopLen;
        if (settings.listen !== 'voice') {
          for (const h of q) {
            const rel = h.qtime - settings.t0;
            if (rel < -0.05 || rel >= loopLen - 0.02) continue;
            const when = base + Math.max(0, rel);
            if (when >= winStart && when < winEnd) kit.play(settings.sounds[h.cls], when, { gain: 0.35 + 0.6 * h.velocity });
          }
        }
        if (settings.listen !== 'drums' && base >= winStart && base < winEnd) {
          const src = ctx.createBufferSource();
          src.buffer = take.buffer;
          src.connect(kit.master);
          src.start(base, Math.max(0, settings.t0), loopLen);
          voiceSources.push(src);
          voiceSources = voiceSources.slice(-4);
        }
      }
      scheduledUntil = winEnd;
    }
  }

  function scheduleMetronome() {
    if (metronomeFrom === null) return;
    const beat = 60 / settings.bpm;
    while (metronomeNext < ctx.currentTime + 0.15) {
      const n = Math.round((metronomeNext - metronomeFrom) / beat);
      kit.play('rim', metronomeNext, { gain: n % 4 === 0 ? 0.35 : 0.18 });
      metronomeNext += beat;
    }
  }
  setInterval(scheduleMetronome, 25);

  function hearHit(h) {
    if (!take || !h) return;
    const src = ctx.createBufferSource();
    src.buffer = take.buffer;
    src.connect(kit.master);
    src.start(ctx.currentTime, h.time, 0.18);
    kit.play(settings.sounds[h.cls], ctx.currentTime + 0.25, { gain: 0.8 });
  }

  // ------------------------------------------------------------ editing

  function relabel(d) {
    const h = hits[selHit];
    if (!h) return;
    h.cls = cycle(B.CLASSES, h.cls, d);
    h.how = 'you';
    // Every correction teaches the classifier.
    classifier.add(h.f.vector, h.cls);
    save();
    kit.play(settings.sounds[h.cls], ctx.currentTime, { gain: 0.8 });
    say(`Marked as ${h.cls}. ${trainingSummary()}`);
  }

  function reclassifyAll() {
    for (const h of hits) {
      if (h.how === 'you') continue;
      const c = classifier.classify(h.f);
      h.cls = c.cls; h.how = c.how; h.conf = c.confidence;
    }
  }

  function deleteHit() {
    if (!hits[selHit]) return;
    hits.splice(selHit, 1);
    selHit = clamp(selHit, 0, hits.length - 1);
  }

  function exportMidi() {
    const { q, loopLen } = pattern();
    if (!q.length) { say('Nothing to export yet.'); return; }
    const inLoop = q.filter((h) => h.qtime - settings.t0 < loopLen - 0.02);
    const bytes = B.toMidi(inLoop, settings);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/midi' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `beatbox-${Math.round(settings.bpm)}bpm.mid`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    say(`Exported ${inLoop.length} hits as MIDI (GM drums: 36 kick, 38 snare, 42 hat).`);
  }

  let forgetArmed = false;
  const ROWS = [
    { label: 'Tempo', value: () => `${settings.bpm} BPM`, nudge: (d) => { settings.bpm = clamp(settings.bpm + d * 0.5, 40, 240); } },
    { label: 'Half / double', value: () => '÷2 ◀ ▶ ×2', nudge: (d) => { settings.bpm = clamp(d > 0 ? settings.bpm * 2 : settings.bpm / 2, 40, 240); } },
    { label: 'Downbeat', value: () => `${(settings.t0 * 1000).toFixed(0)} ms`, nudge: (d) => { settings.t0 = Math.max(0, settings.t0 + d * 0.005); } },
    { label: 'Grid', value: () => GRID_LABELS[settings.grid], nudge: (d) => { settings.grid = cycle(GRIDS, settings.grid, d); } },
    { label: 'Quantize', value: () => `${Math.round(settings.strength * 100)}%`, nudge: (d) => { settings.strength = clamp(Math.round((settings.strength + d * 0.05) * 20) / 20, 0, 1); } },
    { label: 'Feel', value: () => (settings.groove === 'mine' ? 'keep mine' : 'straight'), nudge: () => { settings.groove = settings.groove === 'mine' ? 'straight' : 'mine'; } },
    { label: 'Swing', value: () => `${Math.round(settings.swing * 100)}%`, nudge: (d) => { settings.swing = clamp(Math.round((settings.swing + d * 0.05) * 20) / 20, 0, 0.6); }, dim: () => settings.groove === 'mine' },
    { label: 'Loop', value: () => (settings.bars === 'auto' ? `auto (${pattern().bars} bar${pattern().bars > 1 ? 's' : ''})` : `${settings.bars} bar${settings.bars > 1 ? 's' : ''}`), nudge: (d) => { settings.bars = cycle(BARS, settings.bars, d); } },
    { label: 'Listen', value: () => settings.listen, nudge: (d) => { settings.listen = cycle(LISTEN, settings.listen, d); } },
    { label: 'Kick sound', value: () => settings.sounds.kick, nudge: (d) => { settings.sounds.kick = cycle(kit.names(), settings.sounds.kick, d); kit.play(settings.sounds.kick, ctx.currentTime); } },
    { label: 'Snare sound', value: () => settings.sounds.snare, nudge: (d) => { settings.sounds.snare = cycle(kit.names(), settings.sounds.snare, d); kit.play(settings.sounds.snare, ctx.currentTime); } },
    { label: 'Hat sound', value: () => settings.sounds.hat, nudge: (d) => { settings.sounds.hat = cycle(kit.names(), settings.sounds.hat, d); kit.play(settings.sounds.hat, ctx.currentTime); } },
    { label: 'Metronome', value: () => (settings.metronome ? 'count-in + click' : 'off'), nudge: () => { settings.metronome = !settings.metronome; } },
    { label: 'Sensitivity', value: () => (5 - settings.sensitivity).toFixed(1), nudge: (d) => { settings.sensitivity = clamp(Math.round((settings.sensitivity - d * 0.25) * 4) / 4, 0.5, 4); analyze({ bpm: settings.bpm, t0: settings.t0 }); if (liveOn) resetLive(); } },
    { label: 'Teach', value: () => (settings.teach === 'off' ? 'off' : `next take = ${settings.teach}`), nudge: (d) => { settings.teach = cycle(['off', ...B.CLASSES], settings.teach, d); if (settings.teach !== 'off') say(`Press Start and make only ${settings.teach} sounds for a few seconds.`); } },
    { label: 'Forget my sounds', value: () => (forgetArmed ? 'press again' : '◀ ▶'), nudge: () => { if (forgetArmed) { classifier.clear(); forgetArmed = false; reclassifyAll(); say('Forgot your sounds; using built-in rules.'); } else forgetArmed = true; } },
    { label: 'Export MIDI', value: () => '◀ ▶', nudge: exportMidi },
  ];
  let selRow = 0;

  // ------------------------------------------------------------ input

  const recordBtn = document.getElementById('record');
  const playBtn = document.getElementById('play');
  const liveBtn = document.getElementById('live');
  recordBtn.addEventListener('click', () => toggleRecord());
  playBtn.addEventListener('click', () => (looping ? stopLoop() : startLoop()));
  liveBtn.addEventListener('click', () => toggleLive());

  function toggleRecord() { ctx.resume(); if (recording) stopRecording(); else startRecording(); }

  const overlay = document.getElementById('overlay');
  function unlock() { ctx.resume().then(() => { if (ctx.state === 'running') overlay.hidden = true; }); }
  if (ctx.state === 'running') overlay.hidden = true;
  overlay.addEventListener('click', unlock);
  window.addEventListener('keydown', unlock, { once: true });
  window.addEventListener('pointerdown', unlock, { once: true });

  function selectHit(i) {
    if (!hits.length) return;
    selHit = clamp(i, 0, hits.length - 1);
    kit.play(settings.sounds[hits[selHit].cls], ctx.currentTime, { gain: 0.7 });
  }

  function handleInput() {
    Input.update();
    let changed = false;
    if (Input.pressed('start')) { unlock(); toggleRecord(); }
    if (Input.pressed('a')) { unlock(); if (looping) stopLoop(); else startLoop(); }
    if (Input.pressed('select')) { unlock(); toggleLive(); }
    if (Input.pressed('lb') || Input.pressed('rleft')) selectHit(selHit - 1);
    if (Input.pressed('rb') || Input.pressed('rright')) selectHit(selHit + 1);
    if (Input.pressed('x')) relabel(1);
    if (Input.pressed('b')) { deleteHit(); changed = true; }
    if (Input.pressed('y')) hearHit(hits[selHit]);
    if (Input.pressed('lt')) { settings.bpm = clamp(settings.bpm - 0.5, 40, 240); changed = true; }
    if (Input.pressed('rt')) { settings.bpm = clamp(settings.bpm + 0.5, 40, 240); changed = true; }
    if (Input.pressed('up')) { selRow = clamp(selRow - 1, 0, ROWS.length - 1); forgetArmed = false; rowScroll = true; }
    if (Input.pressed('down')) { selRow = clamp(selRow + 1, 0, ROWS.length - 1); forgetArmed = false; rowScroll = true; }
    if (Input.pressed('left')) { ROWS[selRow].nudge(-1); changed = true; }
    if (Input.pressed('right')) { ROWS[selRow].nudge(1); changed = true; }
    if (changed) save();
  }
  let rowScroll = false;

  // Drop an audio file to use it as a take.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file) return;
    try {
      const buf = await ctx.decodeAudioData(await file.arrayBuffer());
      const mono = new Float32Array(buf.length);
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < d.length; i++) mono[i] += d[i] / buf.numberOfChannels;
      }
      stopLoop();
      loadTake(mono.subarray(0, Math.min(mono.length, buf.sampleRate * MAX_SECONDS)), buf.sampleRate, null);
    } catch (err) { say(`Could not read ${file.name}.`); }
  });

  // ------------------------------------------------------------ drawing

  const canvas = document.getElementById('stage');
  const g = canvas.getContext('2d');
  const map = document.getElementById('map');
  const mg = map.getContext('2d');
  const panel = document.getElementById('rows');
  const status = document.getElementById('status');
  const padEl = document.getElementById('pad');
  let W = 0, H = 0, dpr = 1;

  function resize() {
    dpr = window.devicePixelRatio || 1;
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    map.width = Math.round(map.clientWidth * dpr); map.height = Math.round(map.clientHeight * dpr);
  }
  new ResizeObserver(resize).observe(canvas);

  // Layout regions, shared by drawing and mouse hit-testing.
  function regions() {
    const pad = 16;
    const waveTop = 30, waveH = Math.max(80, H * 0.3);
    const laneTop = waveTop + waveH + 44, laneH = Math.max(36, (H - laneTop - 20) / 3);
    return { pad, waveTop, waveH, laneTop, laneH, x0: pad + 52, x1: W - pad };
  }

  function drawWaveform(R, P) {
    const { waveTop, waveH, x0, x1 } = R;
    g.fillStyle = '#9a98a6';
    g.font = '12px ui-sans-serif, system-ui, sans-serif';
    g.fillText('your take', R.pad, waveTop - 10);
    g.fillStyle = '#16161c';
    g.fillRect(x0, waveTop, x1 - x0, waveH);
    if (!take) {
      g.fillStyle = '#6d6b78';
      g.fillText(recording ? 'recording…' : 'Press Start (Enter) to record, or drop an audio file.', x0 + 12, waveTop + waveH / 2);
      if (recording) drawRecordingLevel(R);
      return;
    }
    const dur = take.samples.length / take.sr;
    const xOf = (t) => x0 + (t / dur) * (x1 - x0);
    // Beat grid from the tempo, to show alignment.
    const beat = 60 / settings.bpm;
    for (let k = 0, t = settings.t0; t < dur; k++, t = settings.t0 + k * beat) {
      g.strokeStyle = k % 4 === 0 ? 'rgba(255,207,90,0.35)' : 'rgba(255,255,255,0.08)';
      g.beginPath(); g.moveTo(xOf(t) + 0.5, waveTop); g.lineTo(xOf(t) + 0.5, waveTop + waveH); g.stroke();
    }
    // Min/max envelope per pixel.
    const mid = waveTop + waveH / 2;
    const s = take.samples;
    const per = s.length / (x1 - x0);
    g.fillStyle = '#7b7a8a';
    for (let x = 0; x < x1 - x0; x++) {
      let lo = 0, hi = 0;
      const a = Math.floor(x * per), b = Math.min(s.length, Math.floor((x + 1) * per));
      for (let i = a; i < b; i += 4) { if (s[i] < lo) lo = s[i]; if (s[i] > hi) hi = s[i]; }
      hi = Math.min(hi, 1); lo = Math.max(lo, -1);
      g.fillRect(x0 + x, mid - hi * waveH * 0.48, 1, Math.max(1, (hi - lo) * waveH * 0.48));
    }
    hits.forEach((h, i) => {
      const x = xOf(h.time);
      g.strokeStyle = CLASS_COLORS[h.cls];
      g.lineWidth = i === selHit ? 2.5 : 1.5;
      g.beginPath(); g.moveTo(x, waveTop); g.lineTo(x, waveTop + waveH); g.stroke();
      g.fillStyle = CLASS_COLORS[h.cls];
      g.beginPath(); g.arc(x, waveTop + 8, i === selHit ? 6 : 4, 0, Math.PI * 2); g.fill();
      if (i === selHit) {
        g.fillStyle = '#fff';
        g.font = '600 12px ui-sans-serif, system-ui, sans-serif';
        g.fillText(`${h.cls}${h.how === 'you' ? ' (you)' : ''}`, Math.min(x + 6, x1 - 80), waveTop + 22);
      }
    });
    g.lineWidth = 1;
    if (looping && settings.listen !== 'drums') {
      const rel = ((ctx.currentTime - loopStart) % P.loopLen + P.loopLen) % P.loopLen;
      const x = xOf(settings.t0 + rel);
      g.strokeStyle = '#fff';
      g.beginPath(); g.moveTo(x, waveTop); g.lineTo(x, waveTop + waveH); g.stroke();
    }
  }

  let recLevel = 0;
  function drawRecordingLevel(R) {
    const chunk = recording && recording.chunks[recording.chunks.length - 1];
    if (chunk) { let m = 0; for (const v of chunk) m = Math.max(m, Math.abs(v)); recLevel = Math.max(m, recLevel * 0.9); }
    g.fillStyle = '#ff5c6c';
    g.fillRect(R.x0, R.waveTop + R.waveH - 6, (R.x1 - R.x0) * Math.min(1, recLevel * 2), 6);
    const secs = recording ? recording.length / ctx.sampleRate : 0;
    g.fillStyle = '#ff5c6c';
    g.fillText(countIn && ctx.currentTime < countIn ? `count-in… ${Math.ceil((countIn - ctx.currentTime) / (60 / settings.bpm))}` : `● ${secs.toFixed(1)} s`, R.x1 - 90, R.waveTop + 18);
  }

  function drawLanes(R, P) {
    const { laneTop, laneH, x0, x1 } = R;
    const loopLen = P.loopLen;
    const xOf = (rel) => x0 + (rel / loopLen) * (x1 - x0);
    g.fillStyle = '#9a98a6';
    g.font = '12px ui-sans-serif, system-ui, sans-serif';
    g.fillText(`drum loop · ${P.bars} bar${P.bars > 1 ? 's' : ''} · ${GRID_LABELS[settings.grid]} · quantize ${Math.round(settings.strength * 100)}% ${settings.groove === 'mine' ? '(keeping your feel)' : ''}`, R.pad, laneTop - 10);
    B.CLASSES.forEach((c, li) => {
      const y = laneTop + li * laneH;
      g.fillStyle = li % 2 ? '#17171d' : '#1a1a21';
      g.fillRect(x0, y, x1 - x0, laneH);
      g.fillStyle = CLASS_COLORS[c];
      g.font = '600 12px ui-sans-serif, system-ui, sans-serif';
      g.fillText(c, R.pad, y + laneH / 2 + 4);
    });
    const steps = P.bars * 4 * settings.grid;
    for (let k = 0; k <= steps; k++) {
      const x = Math.round(xOf((k / steps) * loopLen)) + 0.5;
      g.strokeStyle = k % (4 * settings.grid) === 0 ? 'rgba(255,207,90,0.45)' : k % settings.grid === 0 ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.04)';
      g.beginPath(); g.moveTo(x, laneTop); g.lineTo(x, laneTop + 3 * laneH); g.stroke();
    }
    const now = ctx.currentTime;
    const playRel = looping ? (((now - loopStart) % loopLen) + loopLen) % loopLen : -1;
    P.q.forEach((h, i) => {
      const rel = h.qtime - settings.t0, orig = h.time - settings.t0;
      if (rel >= loopLen - 0.02) return;
      const li = B.CLASSES.indexOf(h.cls);
      const y = laneTop + li * laneH + laneH / 2;
      const x = xOf(Math.max(0, rel)), xo = xOf(orig);
      const r = 4 + 7 * h.velocity;
      // Where you played it → where it lands.
      g.strokeStyle = 'rgba(255,255,255,0.25)';
      g.beginPath(); g.moveTo(xo, y); g.lineTo(x, y); g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.18)';
      g.beginPath(); g.arc(xo, y, 2.5, 0, Math.PI * 2); g.fill();
      const hot = looping && playRel >= rel && playRel - rel < 0.12;
      g.fillStyle = CLASS_COLORS[h.cls];
      g.globalAlpha = hot ? 1 : 0.85;
      g.beginPath(); g.arc(x, y, hot ? r * 1.3 : r, 0, Math.PI * 2); g.fill();
      g.globalAlpha = 1;
      if (i === selHit) {
        g.strokeStyle = '#fff'; g.lineWidth = 2;
        g.beginPath(); g.arc(x, y, r + 4, 0, Math.PI * 2); g.stroke();
        g.lineWidth = 1;
      }
    });
    if (looping) {
      const x = xOf(playRel);
      g.strokeStyle = '#fff';
      g.beginPath(); g.moveTo(x, laneTop); g.lineTo(x, laneTop + 3 * laneH); g.stroke();
    }
  }

  // Sound map: where each sound sits by brightness (x) and low-end weight (y).
  function drawMap() {
    const w = map.width / dpr, h = map.height / dpr;
    mg.setTransform(dpr, 0, 0, dpr, 0, 0);
    mg.fillStyle = '#14141a';
    mg.fillRect(0, 0, w, h);
    const px = (f) => 8 + (w - 16) * clamp((Math.log10(f.centroid + 1) - 2) / 2.3, 0, 1);
    const py = (f) => h - 8 - (h - 16) * clamp((Math.log10(f.lowRatio + 1e-3) + 3) / 3, 0, 1);
    for (const e of classifier.examples) {
      // Examples store vectors; map them back to the same axes.
      const f = { centroid: Math.pow(10, e.v[2]) - 1, lowRatio: Math.pow(10, e.v[0]) - 1e-3 };
      mg.fillStyle = CLASS_COLORS[e.c];
      mg.globalAlpha = 0.3;
      mg.fillRect(px(f) - 1.5, py(f) - 1.5, 3, 3);
    }
    mg.globalAlpha = 1;
    hits.forEach((hh, i) => {
      mg.strokeStyle = CLASS_COLORS[hh.cls];
      mg.lineWidth = i === selHit ? 2.5 : 1.2;
      mg.beginPath(); mg.arc(px(hh.f), py(hh.f), i === selHit ? 6 : 4, 0, Math.PI * 2); mg.stroke();
    });
    if (live) {
      const nowMs = performance.now();
      live.flashes.forEach((f, i) => {
        const age = (nowMs - f.t) / 600;
        if (age > 1) return;
        mg.fillStyle = CLASS_COLORS[f.cls];
        mg.globalAlpha = 1 - age;
        mg.fillRect(8 + i * 10, 8, 8, 8);
      });
      mg.globalAlpha = 1;
    }
    mg.fillStyle = '#6d6b78';
    mg.font = '10px ui-sans-serif, system-ui, sans-serif';
    mg.fillText('darker ← → brighter', w / 2 - 44, h - 2);
    mg.save(); mg.translate(10, h / 2 + 30); mg.rotate(-Math.PI / 2); mg.fillText('more low end ↑', 0, 0); mg.restore();
  }

  let rowsBuilt = false;
  function renderPanel() {
    if (!rowsBuilt) {
      ROWS.forEach((r, i) => {
        const el = document.createElement('div');
        el.className = 'row';
        el.innerHTML = '<button class="nudge" data-d="-1" aria-label="decrease">◀</button><span class="label"></span><span class="value"></span><button class="nudge" data-d="1" aria-label="increase">▶</button>';
        el.querySelector('.label').textContent = r.label;
        el.addEventListener('click', (e) => {
          selRow = i;
          const d = e.target.dataset && e.target.dataset.d;
          if (d) { unlock(); ROWS[i].nudge(Number(d)); save(); }
        });
        panel.appendChild(el);
      });
      rowsBuilt = true;
    }
    ROWS.forEach((r, i) => {
      const el = panel.children[i];
      el.querySelector('.value').textContent = r.value();
      el.classList.toggle('sel', i === selRow);
      el.classList.toggle('dim', !!(r.dim && r.dim()));
    });
    if (rowScroll) { panel.children[selRow].scrollIntoView({ block: 'nearest' }); rowScroll = false; }
    status.textContent = message;
    recordBtn.textContent = recording ? '■ Stop recording' : settings.teach !== 'off' ? `● Teach ${settings.teach}` : '● Record';
    recordBtn.classList.toggle('rec', !!recording);
    playBtn.textContent = looping ? '■ Stop loop' : '▶ Play loop';
    playBtn.classList.toggle('on', looping);
    liveBtn.classList.toggle('on', liveOn);
    const pad = Input.padName();
    padEl.textContent = pad ? '🎮 ' + pad.replace(/\(.*\)/, '').trim().slice(0, 32) : 'No gamepad (keyboard works)';
    document.getElementById('brain').textContent = trainingSummary();
  }

  canvas.addEventListener('pointerdown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const R = regions();
    if (!hits.length) return;
    let best = -1, bestD = 14;
    if (y >= R.waveTop && y <= R.waveTop + R.waveH) {
      const dur = take.samples.length / take.sr;
      hits.forEach((h, i) => { const d = Math.abs(R.x0 + (h.time / dur) * (R.x1 - R.x0) - x); if (d < bestD) { bestD = d; best = i; } });
    } else if (y >= R.laneTop) {
      const P = pattern();
      P.q.forEach((h, i) => {
        const rel = h.qtime - settings.t0;
        const hx = R.x0 + (Math.max(0, rel) / P.loopLen) * (R.x1 - R.x0);
        const hy = R.laneTop + B.CLASSES.indexOf(h.cls) * R.laneH + R.laneH / 2;
        const d = Math.hypot(hx - x, hy - y);
        if (d < bestD + 6) { bestD = d - 6; best = i; }
      });
    }
    if (best < 0) return;
    if (best === selHit) relabel(1); else selectHit(best);
  });

  function frame() {
    handleInput();
    if (W === 0) resize();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#0f0f13';
    g.fillRect(0, 0, W, H);
    const R = regions();
    const P = pattern();
    drawWaveform(R, P);
    drawLanes(R, P);
    drawMap();
    renderPanel();
    requestAnimationFrame(frame);
  }
  resize();
  requestAnimationFrame(frame);

  // Test hook: load a take directly.
  window.__beatbox = {
    loadSamples(arr, sr, tempo) { loadTake(Float32Array.from(arr), sr, tempo || null); return hits.map((h) => h.cls); },
    settings: () => settings, hits: () => hits, pattern,
  };
})();
