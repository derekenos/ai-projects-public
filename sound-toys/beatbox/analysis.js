// Beatbox analysis: onset detection, per-hit features, a classifier that
// starts rule-based and learns from your own examples and corrections,
// tempo estimation, "keep my feel" quantizing, and MIDI export.
// Browser and Node (for tests): attaches to globalThis; needs DSP.
(function () {
  'use strict';

  const DSP = globalThis.DSP;
  const FRAME = 1024;
  const HOP = 256;
  const CLASSES = ['kick', 'snare', 'hat'];

  // ------------------------------------------------------------ onsets

  // Causal onset tracker over log-magnitude spectral flux. Feed it frames in
  // order; it returns true for frames that start a new hit. Used both for
  // whole takes and for live monitoring, so both behave the same way.
  class OnsetTracker {
    constructor(sampleRate, opts = {}) {
      this.sr = sampleRate;
      this.sensitivity = opts.sensitivity != null ? opts.sensitivity : 1.5;
      this.gateDb = opts.gateDb != null ? opts.gateDb : -50;
      this.refractory = opts.refractory != null ? opts.refractory : 0.06;
      this.prevMag = null;
      this.mean = 0;
      this.var = 0;
      this.frames = 0;
      this.lastOnsetFrame = -1e9;
    }

    // frame: Float32Array(FRAME). Returns {onset, flux, rmsDb}.
    push(frame) {
      const mag = DSP.magnitudes(frame, 0, FRAME);
      for (let i = 0; i < mag.length; i++) mag[i] = Math.log1p(mag[i] * 10);
      let flux = 0;
      if (this.prevMag) for (let i = 1; i < mag.length; i++) flux += Math.max(0, mag[i] - this.prevMag[i]);
      this.prevMag = mag;
      let ss = 0;
      for (let i = 0; i < FRAME; i++) ss += frame[i] * frame[i];
      const rmsDb = 10 * Math.log10(ss / FRAME + 1e-12);

      const sd = Math.sqrt(this.var);
      const threshold = this.mean + this.sensitivity * sd + 2;
      const gap = (this.frames - this.lastOnsetFrame) * HOP / this.sr;
      const onset = this.frames > 2 && flux > threshold && rmsDb > this.gateDb && gap > this.refractory;
      if (onset) this.lastOnsetFrame = this.frames;
      // Slow-moving statistics so a loud passage raises the bar briefly.
      const a = 0.04;
      this.mean += a * (flux - this.mean);
      this.var += a * ((flux - this.mean) ** 2 - this.var);
      this.frames++;
      return { onset, flux, rmsDb };
    }
  }

  // Find hits in a mono take. Returns [{index, time, peak}].
  function detectOnsets(samples, sr, opts) {
    const tracker = new OnsetTracker(sr, opts);
    const frame = new Float32Array(FRAME);
    const hits = [];
    for (let start = 0; start + FRAME <= samples.length; start += HOP) {
      frame.set(samples.subarray(start, start + FRAME));
      const { onset } = tracker.push(frame);
      if (!onset) continue;
      // The frame's newest hop holds the attack; refine to where the
      // envelope first reaches 25% of the local peak.
      const from = Math.max(0, start + FRAME - 2 * HOP);
      const to = Math.min(samples.length, start + FRAME + 2 * HOP);
      let peak = 0;
      for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(samples[i]));
      let idx = from;
      while (idx < to && Math.abs(samples[idx]) < peak * 0.25) idx++;
      if (hits.length && idx - hits[hits.length - 1].index < sr * 0.03) continue;
      hits.push({ index: idx, time: idx / sr, peak });
    }
    // Velocity from the loudest part of the first 30 ms, relative to the take.
    let maxPeak = 1e-9;
    for (const h of hits) {
      let p = 0;
      const end = Math.min(samples.length, h.index + Math.floor(sr * 0.03));
      for (let i = h.index; i < end; i++) p = Math.max(p, Math.abs(samples[i]));
      h.peak = p;
      maxPeak = Math.max(maxPeak, p);
    }
    for (const h of hits) h.velocity = Math.max(0.15, Math.sqrt(h.peak / maxPeak));
    return hits;
  }

  // ------------------------------------------------------------ features

  // Describe the first ~23 ms of a hit. The vector is what the classifier
  // compares; the named fields are for display.
  function features(samples, sr, index) {
    const mag = DSP.magnitudes(samples, index, FRAME);
    const binHz = sr / FRAME;
    let total = 0, low = 0, high = 0, centroidNum = 0;
    for (let i = 1; i < mag.length; i++) {
      const p = mag[i] * mag[i];
      const hz = i * binHz;
      total += p;
      centroidNum += p * hz;
      if (hz < 200) low += p;
      if (hz > 5000) high += p;
    }
    total += 1e-12;
    const centroid = centroidNum / total;
    let zc = 0;
    for (let i = index + 1; i < index + FRAME && i < samples.length; i++) {
      if ((samples[i] >= 0) !== (samples[i - 1] >= 0)) zc++;
    }
    const zcr = zc / FRAME;
    // How quickly the hit dies: energy of the second half vs the first.
    let e1 = 0, e2 = 0;
    const half = FRAME / 2;
    for (let i = 0; i < half; i++) {
      const a = samples[index + i] || 0, b = samples[index + half + i] || 0;
      e1 += a * a; e2 += b * b;
    }
    const decay = Math.log10((e2 + 1e-9) / (e1 + 1e-9));
    const lowRatio = low / total, highRatio = high / total;
    return {
      lowRatio, highRatio, centroid, zcr, decay,
      vector: [
        Math.log10(lowRatio + 1e-3),
        Math.log10(highRatio + 1e-3),
        Math.log10(centroid + 1),
        zcr * 4,
        decay * 0.5,
      ],
    };
  }

  // ------------------------------------------------------------ classifier

  // Rule-based until it has examples of your own; then k-nearest-neighbours
  // over your examples, with the rules as a tiebreaker.
  class Classifier {
    constructor(data) {
      this.examples = (data && data.examples) || []; // {v: vector, c: class}
    }

    counts() {
      const n = { kick: 0, snare: 0, hat: 0 };
      for (const e of this.examples) n[e.c]++;
      return n;
    }

    isTrained() {
      const n = this.counts();
      return CLASSES.filter((c) => n[c] >= 2).length >= 2;
    }

    add(vector, cls) {
      this.examples.push({ v: vector.slice(), c: cls });
      // Keep the newest examples; your sounds drift as you practise.
      if (this.examples.length > 300) this.examples.shift();
    }

    clear() { this.examples = []; }

    rule(f) {
      if (f.centroid < 900 && f.lowRatio > 0.2) return 'kick';
      if (f.highRatio > 0.6 && f.centroid > 5000) return 'hat';
      return 'snare';
    }

    // Per-dimension spread of the examples, so no feature dominates.
    scales() {
      const dims = 5;
      const s = new Array(dims).fill(0), m = new Array(dims).fill(0);
      const n = this.examples.length;
      for (const e of this.examples) for (let d = 0; d < dims; d++) m[d] += e.v[d] / n;
      for (const e of this.examples) for (let d = 0; d < dims; d++) s[d] += (e.v[d] - m[d]) ** 2 / n;
      return s.map((v) => Math.max(0.05, Math.sqrt(v)));
    }

    classify(f) {
      if (!this.isTrained()) return { cls: this.rule(f), confidence: 0.5, how: 'rules' };
      const sc = this.scales();
      const dists = this.examples.map((e) => {
        let d = 0;
        for (let i = 0; i < sc.length; i++) d += ((e.v[i] - f.vector[i]) / sc[i]) ** 2;
        return { d: Math.sqrt(d), c: e.c };
      }).sort((a, b) => a.d - b.d);
      const k = Math.min(5, dists.length);
      const votes = { kick: 0, snare: 0, hat: 0 };
      for (let i = 0; i < k; i++) votes[dists[i].c] += 1 / (dists[i].d + 0.1);
      const ruleCls = this.rule(f);
      votes[ruleCls] += 0.05;
      let best = 'snare', bestV = -1, sum = 0;
      for (const c of CLASSES) { sum += votes[c]; if (votes[c] > bestV) { bestV = votes[c]; best = c; } }
      return { cls: best, confidence: bestV / sum, how: 'yours' };
    }

    toJSON() { return { examples: this.examples }; }
  }

  // ------------------------------------------------------------ tempo

  // Estimate BPM from hit times. The first hit is taken as the downbeat.
  // Scores each candidate by how tightly hits sit on its 8th-note grid
  // (kicks and snares weighted toward quarter notes), with a gentle
  // preference for 85-130 BPM to break half/double ties.
  function estimateTempo(hits, lo = 70, hi = 170) {
    if (hits.length < 3) return { bpm: 100, t0: hits.length ? hits[0].time : 0 };
    const t0 = hits[0].time;
    let best = { bpm: 100, score: -1 };
    for (let bpm = lo; bpm <= hi; bpm += 0.25) {
      const beat = 60 / bpm;
      let score = 0;
      for (const h of hits) {
        const x = (h.time - t0) / beat;
        const w = h.cls === 'hat' ? 0.6 : 1;
        // Distance to nearest quarter and nearest eighth, in beats.
        const dq = Math.abs(x - Math.round(x));
        const de = Math.abs(2 * x - Math.round(2 * x)) / 2;
        const ds = Math.abs(4 * x - Math.round(4 * x)) / 4;
        score += w * (Math.exp(-((dq / 0.04) ** 2)) + 0.5 * Math.exp(-((de / 0.03) ** 2)) + 0.2 * Math.exp(-((ds / 0.02) ** 2)));
      }
      const prior = Math.exp(-(Math.log2(bpm / 105) ** 2) / (2 * 0.45 ** 2));
      score *= 0.6 + 0.4 * prior;
      if (score > best.score) best = { bpm, score };
    }
    return { bpm: Math.round(best.bpm * 2) / 2, t0 };
  }

  // ------------------------------------------------------------ quantize

  // grid: steps per beat (4 = 16ths, 2 = 8ths, 3 = 8th triplets, 6 = 16th triplets).
  // strength 0..1 pulls hits toward their target. groove 'straight' targets
  // the grid; 'mine' targets the grid plus your own average push/pull on
  // each step position of the beat, so a consistent swing survives while
  // random wobble is removed.
  function quantize(hits, { bpm, t0, grid = 4, strength = 0.8, groove = 'straight', swing = 0 }) {
    const step = 60 / bpm / grid;
    const slots = hits.map((h) => {
      const x = (h.time - t0) / step;
      const n = Math.round(x);
      return { n, offset: (x - n) * step };
    });
    // Average offset per position within the beat, in seconds.
    const feel = new Array(grid).fill(0), count = new Array(grid).fill(0);
    slots.forEach((s) => { const p = ((s.n % grid) + grid) % grid; feel[p] += s.offset; count[p]++; });
    for (let p = 0; p < grid; p++) feel[p] = count[p] ? feel[p] / count[p] : 0;

    return hits.map((h, i) => {
      const { n } = slots[i];
      const p = ((n % grid) + grid) % grid;
      let target = t0 + n * step;
      if (groove === 'mine') target += feel[p];
      // Swing delays every other step (the off-beat 16ths/8ths).
      if (grid % 2 === 0 && p % 2 === 1) target += swing * step * 0.5;
      return Object.assign({}, h, { step: n, qtime: h.time + (target - h.time) * strength });
    });
  }

  // ------------------------------------------------------------ MIDI

  const GM_NOTES = { kick: 36, snare: 38, hat: 42 };

  // Standard MIDI File (format 0) on channel 10. hits need qtime, cls, velocity.
  function toMidi(hits, { bpm, t0 }) {
    const PPQ = 480;
    const tick = (sec) => Math.max(0, Math.round((sec - t0) / (60 / bpm) * PPQ));
    const events = [];
    for (const h of hits) {
      const on = tick(h.qtime);
      const vel = Math.max(1, Math.min(127, Math.round(h.velocity * 127)));
      events.push({ t: on, d: [0x99, GM_NOTES[h.cls], vel] });
      events.push({ t: on + PPQ / 8, d: [0x89, GM_NOTES[h.cls], 0] });
    }
    events.sort((a, b) => a.t - b.t || (a.d[0] === 0x89 ? -1 : 1));
    const varlen = (v) => {
      const out = [v & 0x7f];
      while ((v >>= 7)) out.unshift((v & 0x7f) | 0x80);
      return out;
    };
    const tempo = Math.round(60000000 / bpm);
    const track = [0, 0xff, 0x51, 0x03, (tempo >> 16) & 0xff, (tempo >> 8) & 0xff, tempo & 0xff];
    let last = 0;
    for (const e of events) { track.push(...varlen(e.t - last), ...e.d); last = e.t; }
    track.push(0, 0xff, 0x2f, 0x00);
    const len = track.length;
    const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (PPQ >> 8) & 0xff, PPQ & 0xff];
    const trk = [0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff];
    return new Uint8Array([...header, ...trk, ...track]);
  }

  globalThis.Beatbox = {
    FRAME, HOP, CLASSES, OnsetTracker, detectOnsets, features, Classifier, estimateTempo, quantize, toMidi,
  };
})();
