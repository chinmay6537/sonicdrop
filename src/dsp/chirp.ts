// Sync chirp and a normalised matched-filter correlator.
//
// The receiver slides the known chirp along the (band-passed) input and computes
// the normalised cross-correlation: 1.0 means a perfect match, random noise sits
// near 0.05. A time-bandwidth product of ~370 gives ~25 dB of processing gain, so
// the chirp is found even below the noise floor, and speech or claps do not look
// like it.

import { CHIRP_AMP, CHIRP_F0, CHIRP_F1, CHIRP_LEN, SAMPLE_RATE } from '../modem/params.ts';
import { fft, ifft, nextPow2 } from './fft.ts';

let cached: Float32Array | null = null;

export function makeChirp(): Float32Array {
  if (cached) return cached;
  const n = CHIRP_LEN;
  const T = n / SAMPLE_RATE;
  const k = (CHIRP_F1 - CHIRP_F0) / T;
  const out = new Float32Array(n);
  const taper = Math.floor(n * 0.05);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    let w = 1;
    if (i < taper) w = 0.5 - 0.5 * Math.cos((Math.PI * i) / taper);
    else if (i >= n - taper) w = 0.5 - 0.5 * Math.cos((Math.PI * (n - 1 - i)) / taper);
    out[i] = CHIRP_AMP * w * Math.sin(2 * Math.PI * (CHIRP_F0 * t + 0.5 * k * t * t));
  }
  cached = out;
  return out;
}

const templateSpectra = new Map<number, { re: Float64Array; im: Float64Array }>();

function templateSpectrum(m: number) {
  let s = templateSpectra.get(m);
  if (s) return s;
  const t = makeChirp();
  const re = new Float64Array(m);
  const im = new Float64Array(m);
  for (let i = 0; i < t.length; i++) re[i] = t[i];
  fft(re, im);
  s = { re, im };
  templateSpectra.set(m, s);
  return s;
}

let templateEnergy = 0;

/**
 * Normalised correlation of `x` against the chirp for lags 0..count-1, i.e. the
 * chirp starting at x[lag]. Needs x.length >= count + CHIRP_LEN - 1.
 */
export function chirpCorrelation(x: Float32Array, count: number): Float32Array {
  const L = CHIRP_LEN;
  if (x.length < count + L - 1) throw new Error('chirpCorrelation: not enough samples');
  if (!templateEnergy) {
    const t = makeChirp();
    for (let i = 0; i < L; i++) templateEnergy += t[i] * t[i];
  }
  const m = nextPow2(count + L);
  const re = new Float64Array(m);
  const im = new Float64Array(m);
  const len = count + L - 1;
  for (let i = 0; i < len; i++) re[i] = x[i];
  fft(re, im);
  const T = templateSpectrum(m);
  for (let i = 0; i < m; i++) {
    // X · conj(T) → cross-correlation
    const r = re[i] * T.re[i] + im[i] * T.im[i];
    const q = im[i] * T.re[i] - re[i] * T.im[i];
    re[i] = r;
    im[i] = q;
  }
  ifft(re, im);

  const out = new Float32Array(count);
  let e = 0;
  for (let i = 0; i < L; i++) e += x[i] * x[i];
  for (let lag = 0; lag < count; lag++) {
    if (lag > 0) {
      const a = x[lag - 1];
      const b = x[lag + L - 1];
      e += b * b - a * a;
    }
    const denom = Math.sqrt(Math.max(e, 1e-12) * templateEnergy);
    out[lag] = re[lag] / denom;
  }
  return out;
}
