// Simulated acoustic channel, so the modem can be measured without hardware.
//
// speaker EQ → room echo → noise sources → clock mismatch → clipping → 16-bit ADC

import { peaking, BiquadChain, highpass, lowpass } from '../dsp/biquad.ts';
import { fft, ifft, nextPow2 } from '../dsp/fft.ts';
import { Prng } from '../dsp/prng.ts';
import { SAMPLE_RATE } from '../modem/params.ts';

export interface Scenario {
  name: string;
  /** Wide-band white noise relative to the signal RMS, dB (higher = quieter). */
  whiteSnrDb?: number;
  /** Talkers nearby, relative to signal RMS, dB. 0 = as loud as the modem. */
  babbleSnrDb?: number;
  /** Music-like harmonic noise relative to signal RMS, dB. */
  musicSnrDb?: number;
  /** Steady whine at this frequency (Hz) and level (dB re signal). */
  tone?: { hz: number; snrDb: number };
  /** Claps/knocks per second, each up to this level above the signal (dB). */
  clicks?: { perSecond: number; levelDb: number };
  /** Room reverb time (s); 0 disables. */
  rt60?: number;
  /** Wall reflection strength 0–1 (default 0.7). */
  reflectivity?: number;
  /** Random peaks/dips in speaker+mic response, dB. */
  eqRippleDb?: number;
  /** Receiver clock offset in parts per million. */
  ppm?: number;
  /** Extra gain before clipping (dB); >0 drives the ADC into clipping. */
  driveDb?: number;
}

export const SCENARIOS: Scenario[] = [
  { name: 'clean (cable-like)', whiteSnrDb: 40 },
  { name: 'quiet room', whiteSnrDb: 30, rt60: 0.3, eqRippleDb: 6, ppm: 40 },
  { name: 'office chatter', whiteSnrDb: 30, babbleSnrDb: 0, rt60: 0.4, eqRippleDb: 6, ppm: -60 },
  { name: 'loud café', whiteSnrDb: 25, babbleSnrDb: -10, musicSnrDb: -6, rt60: 0.5, eqRippleDb: 8, ppm: 80 },
  { name: 'fan whine 7 kHz', whiteSnrDb: 30, tone: { hz: 7020, snrDb: 0 }, rt60: 0.3, eqRippleDb: 6, ppm: 30 },
  { name: 'claps + knocks', whiteSnrDb: 30, clicks: { perSecond: 1.5, levelDb: 12 }, rt60: 0.3, eqRippleDb: 6, ppm: -40 },
  { name: 'echoey hall', whiteSnrDb: 28, rt60: 1.2, reflectivity: 1, eqRippleDb: 8, ppm: 50 },
  { name: 'weak signal', whiteSnrDb: 8, rt60: 0.4, eqRippleDb: 6, ppm: 100 },
  {
    name: 'everything at once', whiteSnrDb: 22, babbleSnrDb: -6, tone: { hz: 9500, snrDb: 3 },
    clicks: { perSecond: 1, levelDb: 10 }, rt60: 0.6, eqRippleDb: 8, ppm: -120, driveDb: 4,
  },
];

const dbToAmp = (db: number) => Math.pow(10, db / 20);

function rms(x: Float32Array): number {
  let s = 0, n = 0;
  for (let i = 0; i < x.length; i++) if (x[i] !== 0) { s += x[i] * x[i]; n++; }
  return Math.sqrt(s / Math.max(n, 1));
}

function normalise(x: Float32Array): Float32Array {
  const r = rms(x) || 1;
  for (let i = 0; i < x.length; i++) x[i] /= r;
  return x;
}

/** Linear convolution via FFT (overlap-add). */
export function convolve(x: Float32Array, h: Float32Array): Float32Array {
  const out = new Float32Array(x.length + h.length - 1);
  const block = nextPow2(h.length) * 2;
  const step = block - h.length + 1;
  const hr = new Float64Array(block);
  const hi = new Float64Array(block);
  hr.set(h);
  fft(hr, hi);
  for (let off = 0; off < x.length; off += step) {
    const xr = new Float64Array(block);
    const xi = new Float64Array(block);
    const n = Math.min(step, x.length - off);
    for (let i = 0; i < n; i++) xr[i] = x[off + i];
    fft(xr, xi);
    for (let k = 0; k < block; k++) {
      const r = xr[k] * hr[k] - xi[k] * hi[k];
      xi[k] = xr[k] * hi[k] + xi[k] * hr[k];
      xr[k] = r;
    }
    ifft(xr, xi);
    const lim = Math.min(block, out.length - off);
    for (let i = 0; i < lim; i++) out[off + i] += xr[i];
  }
  return out;
}

/**
 * Room impulse response for devices ~30 cm apart: direct path, a strong table
 * bounce, wall/ceiling reflections scaled by spherical spreading (path length),
 * and an exponential diffuse tail. `reflectivity` (0–1) scales the reflections.
 */
export function roomImpulse(rt60: number, rng: Prng, reflectivity = 0.7): Float32Array {
  const len = Math.floor(Math.max(rt60, 0.05) * SAMPLE_RATE);
  const h = new Float32Array(len);
  const direct = 0.3; // metres
  const c = 343;
  const tap = (pathM: number, gain: number) => {
    const d = Math.round(((pathM - direct) / c) * SAMPLE_RATE);
    if (d >= 0 && d < len) h[d] += gain;
  };
  tap(direct, 1);
  tap(0.36, -0.6 * reflectivity); // table surface
  for (let i = 0; i < 8; i++) {
    const path = 1.2 + rng.next() * 5; // walls, ceiling, nearby objects: 3–17 ms late
    tap(path, (rng.bit() ? 1 : -1) * reflectivity * (direct / path) * (0.6 + rng.next() * 0.8));
  }
  // Diffuse tail from 10 ms, −60 dB at rt60; level set for a typical
  // direct-to-reverberant ratio at 30 cm (about +10 dB in a 0.3 s room).
  const decay = Math.log(1000) / (Math.max(rt60, 0.05) * SAMPLE_RATE);
  const tailLevel = dbToAmp(-22) / Math.sqrt(0.002 * SAMPLE_RATE);
  for (let i = Math.floor(0.01 * SAMPLE_RATE); i < len; i++) h[i] += tailLevel * rng.gauss() * Math.exp(-decay * i);
  return h;
}

/** Talkers: shaped noise with syllable-rate envelopes, plus quieter fricatives. */
function babble(n: number, rng: Prng): Float32Array {
  const out = new Float32Array(n);
  for (let t = 0; t < 4; t++) {
    // Voiced energy (~150–3500 Hz) plus fricatives ("s", "sh") reaching 4–9 kHz
    // Long-term average speech spectrum: peak near 500 Hz, falling ~12 dB/octave
    // above ~800 Hz (so ~−28 dB at 4 kHz), with a formant bump near 1.8 kHz.
    const voiced = new BiquadChain([
      lowpass(800, 0.707, SAMPLE_RATE),
      peaking(500 + rng.next() * 400, 0.7, 6, SAMPLE_RATE),
      peaking(1800, 1, 6, SAMPLE_RATE),
    ]);
    const fric = new BiquadChain([highpass(4000, 0.7, SAMPLE_RATE), peaking(6500, 1.2, 6, SAMPLE_RATE)]);
    const v = normalise(voiced.process(Float32Array.from({ length: n }, () => rng.gauss())));
    const f = normalise(fric.process(Float32Array.from({ length: n }, () => rng.gauss())));
    let phase = rng.next() * 10;
    const rate = 3 + rng.next() * 3; // syllables per second
    for (let i = 0; i < n; i++) {
      phase += rate / SAMPLE_RATE;
      const env = Math.max(0, Math.sin(2 * Math.PI * phase)) ** 2;
      const isFric = Math.sin(2 * Math.PI * phase * 0.37) > 0.6 ? 1 : 0;
      // Long-term speech spectrum: fricative band ~20 dB below voiced energy.
      out[i] += env * (v[i] + 0.1 * isFric * f[i]);
    }
  }
  return out;
}

/** Music-like: chords of harmonic tones that change every ~0.5 s. */
function music(n: number, rng: Prng): Float32Array {
  const out = new Float32Array(n);
  const seg = Math.floor(0.5 * SAMPLE_RATE);
  for (let s = 0; s < n; s += seg) {
    const notes = [110, 220, 330, 440].map((b) => b * Math.pow(2, Math.floor(rng.next() * 12) / 12));
    for (const f0 of notes) {
      for (let h = 1; h <= 16; h++) {
        const f = f0 * h;
        if (f > 16000) break;
        const a = 1 / h;
        const ph = rng.next() * 2 * Math.PI;
        for (let i = s; i < Math.min(n, s + seg); i++) out[i] += a * Math.sin((2 * Math.PI * f * i) / SAMPLE_RATE + ph);
      }
    }
  }
  return out;
}

function clicks(n: number, rng: Prng, perSecond: number): Float32Array {
  const out = new Float32Array(n);
  const count = Math.round((n / SAMPLE_RATE) * perSecond);
  for (let c = 0; c < count; c++) {
    const at = Math.floor(rng.next() * n);
    const len = Math.floor((0.005 + rng.next() * 0.03) * SAMPLE_RATE);
    const amp = 0.3 + rng.next() * 0.7;
    for (let i = 0; i < len && at + i < n; i++) out[at + i] += amp * rng.gauss() * Math.exp(-i / (len / 4));
  }
  return out;
}

/** Band-limited (windowed-sinc) resampling to emulate a receiver clock offset. */
export function resample(x: Float32Array, ppm: number): Float32Array {
  if (!ppm) return x;
  const ratio = 1 + ppm * 1e-6; // receiver samples per transmitter sample
  const n = Math.floor(x.length * ratio);
  const out = new Float32Array(n);
  const HALF = 16;
  for (let i = 0; i < n; i++) {
    const t = i / ratio;
    const i0 = Math.floor(t);
    let s = 0;
    for (let k = i0 - HALF + 1; k <= i0 + HALF; k++) {
      if (k < 0 || k >= x.length) continue;
      const d = t - k;
      const sinc = d === 0 ? 1 : Math.sin(Math.PI * d) / (Math.PI * d);
      const w = 0.5 + 0.5 * Math.cos((Math.PI * d) / HALF);
      s += x[k] * sinc * w;
    }
    out[i] = s;
  }
  return out;
}

export interface SimOptions {
  seed?: number;
  /** Silence before the transmission (s). */
  leadIn?: number;
}

/** Pass a transmitted signal through the simulated room to the receiver's mic. */
export function simulate(tx: Float32Array, sc: Scenario, opts: SimOptions = {}): Float32Array {
  const rng = new Prng(opts.seed ?? 1);
  const lead = Math.floor((opts.leadIn ?? 0.3) * SAMPLE_RATE);
  let x: Float32Array = new Float32Array(lead + tx.length + SAMPLE_RATE / 2);
  x.set(tx, lead);
  const sigRms = rms(tx);

  if (sc.eqRippleDb) {
    const stages = Array.from({ length: 6 }, () =>
      peaking(3000 + rng.next() * 10000, 1 + rng.next() * 3, (rng.next() * 2 - 1) * sc.eqRippleDb!, SAMPLE_RATE),
    );
    x = new BiquadChain(stages).process(x);
  }
  if (sc.rt60) x = convolve(x, roomImpulse(sc.rt60, rng, sc.reflectivity)).subarray(0, x.length);

  const n = x.length;
  const addNoise = (noise: Float32Array, snrDb: number) => {
    const g = (sigRms * dbToAmp(-snrDb)) / Math.max(rms(noise), 1e-12);
    for (let i = 0; i < n; i++) x[i] += g * noise[i];
  };
  if (sc.whiteSnrDb !== undefined) addNoise(Float32Array.from({ length: n }, () => rng.gauss()), sc.whiteSnrDb);
  if (sc.babbleSnrDb !== undefined) addNoise(babble(n, rng), sc.babbleSnrDb);
  if (sc.musicSnrDb !== undefined) addNoise(music(n, rng), sc.musicSnrDb);
  if (sc.tone) {
    const f = sc.tone.hz;
    addNoise(Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * f * i) / SAMPLE_RATE)), sc.tone.snrDb);
  }
  if (sc.clicks) {
    const c = clicks(n, rng, sc.clicks.perSecond);
    const peak = c.reduce((m, v) => Math.max(m, Math.abs(v)), 1e-9);
    const g = (sigRms * dbToAmp(sc.clicks.levelDb) * 3) / peak;
    for (let i = 0; i < n; i++) x[i] += g * c[i];
  }

  x = resample(x, sc.ppm ?? 0);

  // Mic input level: like a real recording, gain is set so a loud room doesn't
  // clip (peak at −1 dBFS). `driveDb` then deliberately overdrives it.
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  const drive = (peak > 0.89 ? 0.89 / peak : 1) * dbToAmp(sc.driveDb ?? 0);
  for (let i = 0; i < x.length; i++) {
    let v = x[i] * drive;
    v = Math.max(-1, Math.min(1, v));
    x[i] = Math.round(v * 32767) / 32767;
  }
  return x;
}
