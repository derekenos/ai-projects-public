// Small DSP helpers shared by the apps. Works in the browser and in Node
// (for offline tests), so it attaches to globalThis instead of window.
(function () {
  'use strict';

  // In-place iterative radix-2 FFT. re/im lengths must be a power of two.
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = a + len / 2;
          const xr = re[b] * cr - im[b] * ci;
          const xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
          const nr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr; cr = nr;
        }
      }
    }
  }

  const hannCache = {};
  function hann(n) {
    if (!hannCache[n]) {
      const w = new Float32Array(n);
      for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
      hannCache[n] = w;
    }
    return hannCache[n];
  }

  // Magnitude spectrum of samples[start .. start+n), Hann-windowed.
  // Returns Float32Array of n/2 bins.
  function magnitudes(samples, start, n) {
    const re = new Float32Array(n), im = new Float32Array(n);
    const w = hann(n);
    for (let i = 0; i < n; i++) {
      const s = samples[start + i];
      re[i] = (s === undefined ? 0 : s) * w[i];
    }
    fft(re, im);
    const mag = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
    return mag;
  }

  globalThis.DSP = { fft, hann, magnitudes };
})();
