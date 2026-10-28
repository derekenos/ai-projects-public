// Synthesized sample kit: every sound is generated in code, so the apps need
// no audio assets. Pitched sounds carry a base MIDI note for playbackRate
// transposition.
(function () {
  'use strict';

  function noise() { return Math.random() * 2 - 1; }

  function buffer(ctx, seconds, fill) {
    const sr = ctx.sampleRate;
    const n = Math.floor(seconds * sr);
    const buf = ctx.createBuffer(1, n, sr);
    const d = buf.getChannelData(0);
    fill(d, sr, n);
    // Short fade-out so nothing clicks at the end.
    const fade = Math.min(n, Math.floor(sr * 0.005));
    for (let i = 0; i < fade; i++) d[n - 1 - i] *= i / fade;
    return buf;
  }

  const GENERATORS = {
    kick: { base: 60, pitched: false, gen: (ctx) => buffer(ctx, 0.6, (d, sr, n) => {
      let ph = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const f = 45 + 120 * Math.exp(-t * 28);
        ph += 2 * Math.PI * f / sr;
        const click = t < 0.004 ? noise() * (1 - t / 0.004) * 0.5 : 0;
        d[i] = Math.tanh(1.6 * Math.sin(ph) * Math.exp(-t * 7)) + click;
      }
    }) },
    snare: { base: 60, pitched: false, gen: (ctx) => buffer(ctx, 0.35, (d, sr, n) => {
      let ph = 0, prev = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        ph += 2 * Math.PI * (180 + 40 * Math.exp(-t * 40)) / sr;
        const x = noise();
        const hp = x - prev; prev = x;
        d[i] = 0.55 * Math.sin(ph) * Math.exp(-t * 30) + 0.6 * hp * Math.exp(-t * 14);
      }
    }) },
    hat: { base: 60, pitched: false, gen: (ctx) => buffer(ctx, 0.12, (d, sr, n) => {
      let p1 = 0, p2 = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const x = noise();
        const hp = x - 2 * p1 + p2; p2 = p1; p1 = x;
        d[i] = 0.35 * hp * Math.exp(-t * 55);
      }
    }) },
    openhat: { base: 60, pitched: false, gen: (ctx) => buffer(ctx, 0.5, (d, sr, n) => {
      let p1 = 0, p2 = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const x = noise();
        const hp = x - 2 * p1 + p2; p2 = p1; p1 = x;
        d[i] = 0.3 * hp * Math.exp(-t * 8);
      }
    }) },
    clap: { base: 60, pitched: false, gen: (ctx) => buffer(ctx, 0.4, (d, sr, n) => {
      let lp = 0, prev = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        let env = 0;
        for (const o of [0, 0.011, 0.022]) if (t >= o) env = Math.max(env, Math.exp(-(t - o) * 90));
        env = Math.max(env, t > 0.03 ? 0.5 * Math.exp(-(t - 0.03) * 12) : 0);
        const x = noise();
        lp += 0.35 * (x - lp);
        const bp = lp - prev; prev = lp;
        d[i] = 1.8 * bp * env;
      }
    }) },
    tom: { base: 50, pitched: true, gen: (ctx) => buffer(ctx, 0.6, (d, sr, n) => {
      let ph = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        ph += 2 * Math.PI * (146.8 * (1 + 0.5 * Math.exp(-t * 25))) / sr;
        d[i] = 0.8 * Math.sin(ph) * Math.exp(-t * 6);
      }
    }) },
    rim: { base: 60, pitched: false, gen: (ctx) => buffer(ctx, 0.08, (d, sr, n) => {
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        d[i] = 0.5 * (Math.sin(2 * Math.PI * 1700 * t) * Math.exp(-t * 80) + 0.4 * noise() * Math.exp(-t * 300));
      }
    }) },
    pluck: { base: 60, pitched: true, gen: (ctx) => buffer(ctx, 1.6, (d, sr, n) => {
      // Karplus-Strong string.
      const period = Math.round(sr / 261.63);
      const line = new Float32Array(period);
      for (let i = 0; i < period; i++) line[i] = noise();
      let idx = 0;
      for (let i = 0; i < n; i++) {
        const next = (idx + 1) % period;
        const v = line[idx];
        line[idx] = 0.497 * (v + line[next]);
        d[i] = 0.7 * v;
        idx = next;
      }
    }) },
    marimba: { base: 60, pitched: true, gen: (ctx) => buffer(ctx, 1.0, (d, sr, n) => {
      const f = 261.63;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const atk = Math.min(1, t / 0.002);
        d[i] = atk * (0.7 * Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 5)
          + 0.25 * Math.sin(2 * Math.PI * f * 3.99 * t) * Math.exp(-t * 18)
          + 0.1 * Math.sin(2 * Math.PI * f * 9.9 * t) * Math.exp(-t * 40));
      }
    }) },
    bell: { base: 60, pitched: true, gen: (ctx) => buffer(ctx, 2.5, (d, sr, n) => {
      const f = 261.63;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const atk = Math.min(1, t / 0.003);
        const mod = 2.2 * Math.exp(-t * 2.5) * Math.sin(2 * Math.PI * f * 3.5 * t);
        d[i] = 0.5 * atk * Math.sin(2 * Math.PI * f * t + mod) * Math.exp(-t * 1.6);
      }
    }) },
    bass: { base: 36, pitched: true, gen: (ctx) => buffer(ctx, 0.9, (d, sr, n) => {
      const f = 65.41;
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const saw = 2 * ((f * t) % 1) - 1;
        const cutoff = 0.02 + 0.25 * Math.exp(-t * 12);
        lp += cutoff * (saw - lp);
        d[i] = 0.9 * Math.tanh(2 * lp) * Math.min(1, t / 0.003) * Math.exp(-t * 3);
      }
    }) },
    glass: { base: 72, pitched: true, gen: (ctx) => buffer(ctx, 1.8, (d, sr, n) => {
      const f = 523.25;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const atk = Math.min(1, t / 0.01);
        d[i] = 0.35 * atk * (Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(2 * Math.PI * f * 2.76 * t) * Math.exp(-t * 3))
          * Math.exp(-t * 2.2);
      }
    }) },
  };

  // A small hall reverb impulse built from decaying stereo noise.
  function impulse(ctx, seconds, decay) {
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) d[i] = noise() * Math.pow(1 - i / n, decay);
    }
    return buf;
  }

  class Kit {
    constructor(ctx) {
      this.ctx = ctx;
      this.sounds = {};
      for (const [name, g] of Object.entries(GENERATORS)) {
        this.sounds[name] = { buffer: g.gen(ctx), base: g.base, pitched: g.pitched };
      }
      this.master = ctx.createGain();
      this.master.gain.value = 0.8;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      this.master.connect(comp).connect(ctx.destination);
      this.reverb = ctx.createConvolver();
      this.reverb.buffer = impulse(ctx, 2.4, 3);
      this.reverbSend = ctx.createGain();
      this.reverbSend.gain.value = 0.22;
      this.reverbSend.connect(this.reverb).connect(this.master);
    }

    names() { return Object.keys(this.sounds); }

    isPitched(name) { return !!(this.sounds[name] && this.sounds[name].pitched); }

    addSample(name, audioBuffer) {
      this.sounds[name] = { buffer: audioBuffer, base: 60, pitched: true };
    }

    // when: AudioContext time. midi: target note for pitched sounds.
    play(name, when, opts = {}) {
      const s = this.sounds[name];
      if (!s) return;
      const ctx = this.ctx;
      const src = ctx.createBufferSource();
      src.buffer = s.buffer;
      if (opts.midi != null && s.pitched) src.playbackRate.value = Math.pow(2, (opts.midi - s.base) / 12);
      const g = ctx.createGain();
      g.gain.value = opts.gain != null ? opts.gain : 0.8;
      const pan = ctx.createStereoPanner();
      pan.pan.value = opts.pan || 0;
      src.connect(g).connect(pan);
      pan.connect(this.master);
      pan.connect(this.reverbSend);
      src.start(Math.max(when, ctx.currentTime));
    }
  }

  const SCALES = {
    'major pent': [0, 2, 4, 7, 9],
    'minor pent': [0, 3, 5, 7, 10],
    major: [0, 2, 4, 5, 7, 9, 11],
    minor: [0, 2, 3, 5, 7, 8, 10],
    dorian: [0, 2, 3, 5, 7, 9, 10],
    'whole tone': [0, 2, 4, 6, 8, 10],
  };

  function degreeToMidi(root, scaleName, degree) {
    const scale = SCALES[scaleName] || SCALES['major pent'];
    const len = scale.length;
    const oct = Math.floor(degree / len);
    const idx = ((degree % len) + len) % len;
    return root + 12 * oct + scale[idx];
  }

  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  function noteName(midi) { return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1); }

  window.Kit = Kit;
  window.Music = { SCALES, degreeToMidi, noteName };
})();
