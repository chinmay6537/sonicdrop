// OFDM frame format, modulation and demodulation.
//
// Frame on the air:
//   [chirp 2048][gap 384][train][train][header][data × n][silence 960]
//
// - chirp:  found by matched filtering; gives the frame start.
// - train:  two identical known QPSK symbols. Their average gives the channel
//           (gain + phase of every carrier, room echo included); their difference
//           gives the noise level of every carrier.
// - header: BPSK, rate 1/2, repeated: code rate, payload length and tone map.
// - data:   bits loaded per the tone map, with pilots on every 8th carrier for
//           tracking clock drift and per-symbol noise bursts.

import { fft, ifft } from '../dsp/fft.ts';
import { makeChirp } from '../dsp/chirp.ts';
import { Prng, hashSeed } from '../dsp/prng.ts';
import { bitsToBytes, bytesToBits, deinterleave, interleave, whiteningBits } from '../fec/bits.ts';
import { codedLength, convEncode, viterbiDecode } from '../fec/conv.ts';
import { crc16, crc32 } from '../fec/crc.ts';
import { demapPoint, mapPoint, slicePoint } from './constellation.ts';
import {
  CLIP_LEVEL, CP, FFT_BACKOFF, FFT_N, FRAME_GAP, HEADER_END, NON_PILOTS, NUM_CARRIERS, NUM_GROUPS,
  OFDM_RMS, PILOTS, PREAMBLE_LEN, SAMPLE_RATE, SYMBOL_LEN, binOf, bitsPerSymbol, groupOf,
} from './params.ts';
import type { CodeRate, Profile, ToneMap } from './params.ts';

const HEADER_BYTES = 8;
const HEADER_INFO_BITS = HEADER_BYTES * 8;
const HEADER_CODED = codedLength(HEADER_INFO_BITS, 0); // 140
const HEADER_SEED = 0x4ead;
const DATA_SEED = 0xda7a;
const VERSION = 1;
export const MAX_PAYLOAD = 4095;
const MAX_DATA_SYMBOLS = 255;
/** Decision-directed tracking rates for channel and noise. */
const MU_H = 0.12;
const MU_NOISE = 0.1;
/** Faster rate when a carrier's noise rises (a new interferer). */
const MU_NOISE_UP = 0.3;
/** Max squared distance to the sliced point for a decision to be learned from. */
const SLICE_GATE: Record<number, number> = { 1: 0.5, 2: 0.25, 4: 0.05 };

// ---------------------------------------------------------------- known symbols

const TRAIN_RE = new Float64Array(NUM_CARRIERS);
const TRAIN_IM = new Float64Array(NUM_CARRIERS);
{
  const rng = new Prng(0x7a1e);
  for (let c = 0; c < NUM_CARRIERS; c++) {
    TRAIN_RE[c] = rng.bit() ? -Math.SQRT1_2 : Math.SQRT1_2;
    TRAIN_IM[c] = rng.bit() ? -Math.SQRT1_2 : Math.SQRT1_2;
  }
}

/** BPSK pilot value for pilot index j of symbol s (s = 0 is the header). */
function pilotValue(s: number, j: number): number {
  return new Prng(hashSeed(0x9170 + s, j)).bit() ? -1 : 1;
}

// Time-domain scale so a symbol with every carrier on has RMS = OFDM_RMS.
const SCALE = OFDM_RMS / (Math.sqrt(2 * NUM_CARRIERS) / FFT_N);

const TONE_CODE = [0, 1, 2, 4];

// ---------------------------------------------------------------- header

export interface FrameHeader {
  rate: CodeRate;
  length: number;
  toneMap: ToneMap;
}

function packHeader(h: FrameHeader): Uint8Array {
  const b = new Uint8Array(HEADER_BYTES);
  b[0] = (VERSION << 6) | (h.rate << 4) | ((h.length >> 8) & 0xf);
  b[1] = h.length & 0xff;
  for (let g = 0; g < NUM_GROUPS; g++) {
    const code = TONE_CODE.indexOf(h.toneMap[g]);
    if (code < 0) throw new Error(`bad tone map entry ${h.toneMap[g]}`);
    b[2 + (g >> 2)] |= code << (6 - 2 * (g & 3));
  }
  const crc = crc16(b, 0, 6);
  b[6] = crc >> 8;
  b[7] = crc & 0xff;
  return b;
}

function unpackHeader(b: Uint8Array): FrameHeader | null {
  if (crc16(b, 0, 6) !== ((b[6] << 8) | b[7])) return null;
  if (b[0] >> 6 !== VERSION) return null;
  const rate = ((b[0] >> 4) & 3) as CodeRate;
  if (rate > 2) return null;
  const length = ((b[0] & 0xf) << 8) | b[1];
  const toneMap = new Uint8Array(NUM_GROUPS);
  for (let g = 0; g < NUM_GROUPS; g++) toneMap[g] = TONE_CODE[(b[2 + (g >> 2)] >> (6 - 2 * (g & 3))) & 3];
  if (length < 1 || bitsPerSymbol(toneMap) === 0) return null;
  return { rate, length, toneMap };
}

export function dataSymbolCount(h: FrameHeader): number {
  const coded = codedLength((h.length + 4) * 8, h.rate);
  return Math.ceil(coded / bitsPerSymbol(h.toneMap));
}

/** Samples in a frame, excluding the trailing silence. */
export function frameLength(h: FrameHeader): number {
  return PREAMBLE_LEN + (3 + dataSymbolCount(h)) * SYMBOL_LEN;
}

/** Largest payload that fits in `symbols` data symbols with this profile. */
export function payloadForSymbols(profile: Profile, symbols: number): number {
  const bps = bitsPerSymbol(profile.toneMap);
  let len = 1;
  while (len < MAX_PAYLOAD && dataSymbolCount({ ...profile, length: len + 1 }) <= symbols) len++;
  if (bps === 0) throw new Error('empty tone map');
  return len;
}

// ---------------------------------------------------------------- transmitter

function synthSymbol(re: Float64Array, im: Float64Array, out: Float32Array, off: number) {
  const xr = new Float64Array(FFT_N);
  const xi = new Float64Array(FFT_N);
  for (let c = 0; c < NUM_CARRIERS; c++) {
    const k = binOf(c);
    xr[k] = re[c]; xi[k] = im[c];
    xr[FFT_N - k] = re[c]; xi[FFT_N - k] = -im[c];
  }
  ifft(xr, xi);
  for (let i = 0; i < SYMBOL_LEN; i++) {
    let v = xr[(i - CP + FFT_N) % FFT_N] * SCALE;
    if (v > CLIP_LEVEL) v = CLIP_LEVEL;
    else if (v < -CLIP_LEVEL) v = -CLIP_LEVEL;
    out[off + i] = v;
  }
}

/** Modulate one frame (payload + CRC32) into audio samples, trailing silence included. */
export function buildFrame(payload: Uint8Array, profile: Profile): Float32Array {
  if (payload.length < 1 || payload.length > MAX_PAYLOAD) throw new Error('payload size out of range');
  const header: FrameHeader = { rate: profile.rate, length: payload.length, toneMap: profile.toneMap };
  const nData = dataSymbolCount(header);
  if (nData > MAX_DATA_SYMBOLS) throw new Error('frame too long for this profile');
  const len = frameLength(header);
  const out = new Float32Array(len + FRAME_GAP);
  out.set(makeChirp(), 0);

  synthSymbol(TRAIN_RE, TRAIN_IM, out, PREAMBLE_LEN);
  synthSymbol(TRAIN_RE, TRAIN_IM, out, PREAMBLE_LEN + SYMBOL_LEN);

  const re = new Float64Array(NUM_CARRIERS);
  const im = new Float64Array(NUM_CARRIERS);
  const setPilots = (s: number) => {
    PILOTS.forEach((c, j) => { re[c] = pilotValue(s, j); im[c] = 0; });
  };

  // Header: BPSK on every non-pilot carrier, coded bits repeated to fill.
  const hCoded = convEncode(bytesToBits(packHeader(header)), 0);
  const hWhite = whiteningBits(NON_PILOTS.length, HEADER_SEED);
  setPilots(0);
  NON_PILOTS.forEach((c, i) => {
    re[c] = hCoded[i % HEADER_CODED] ^ hWhite[i] ? -1 : 1;
    im[c] = 0;
  });
  synthSymbol(re, im, out, PREAMBLE_LEN + 2 * SYMBOL_LEN);

  // Data
  const withCrc = new Uint8Array(payload.length + 4);
  withCrc.set(payload);
  new DataView(withCrc.buffer).setUint32(payload.length, crc32(payload));
  const coded = interleave(convEncode(bytesToBits(withCrc), profile.rate));
  const bps = bitsPerSymbol(profile.toneMap);
  const total = nData * bps;
  const stream = new Uint8Array(total);
  stream.set(coded);
  const white = whiteningBits(total, DATA_SEED);
  for (let i = 0; i < total; i++) stream[i] ^= white[i];

  let pos = 0;
  for (let s = 0; s < nData; s++) {
    setPilots(s + 1);
    for (const c of NON_PILOTS) {
      const order = profile.toneMap[groupOf(c)];
      if (order === 0) { re[c] = 0; im[c] = 0; continue; }
      const [a, b] = mapPoint(stream, pos, order);
      re[c] = a; im[c] = b;
      pos += order;
    }
    synthSymbol(re, im, out, PREAMBLE_LEN + (3 + s) * SYMBOL_LEN);
  }
  return out;
}

// ---------------------------------------------------------------- receiver

export interface LinkReport {
  /** Mean SNR per tone-map group, dB, measured from the training symbols. */
  groupSnrDb: number[];
  snrDb: number;
  /** Estimated sample-clock mismatch between the devices. */
  driftPpm: number;
  /** Fraction of symbols whose pilots showed extra noise (e.g. a clap). */
  burstSymbols: number;
}

const XC = (NUM_CARRIERS - 1) / 2;

/** Weighted least-squares fit of phase = a + b·(c − XC). */
function fitLine(cs: number[], phase: number[], w: number[]): [number, number] {
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < cs.length; i++) {
    const x = cs[i] - XC;
    sw += w[i]; sx += w[i] * x; sy += w[i] * phase[i];
    sxx += w[i] * x * x; sxy += w[i] * x * phase[i];
  }
  if (sw <= 0) return [0, 0];
  const den = sw * sxx - sx * sx;
  const b = Math.abs(den) > 1e-12 ? (sw * sxy - sx * sy) / den : 0;
  const a = (sy - b * sx) / sw;
  return [a, b];
}

function carriersAt(buf: Float32Array, symStart: number): [Float64Array, Float64Array] {
  const xr = new Float64Array(FFT_N);
  const xi = new Float64Array(FFT_N);
  const w0 = symStart + CP - FFT_BACKOFF;
  for (let i = 0; i < FFT_N; i++) xr[i] = buf[w0 + i] ?? 0;
  fft(xr, xi);
  const re = new Float64Array(NUM_CARRIERS);
  const im = new Float64Array(NUM_CARRIERS);
  for (let c = 0; c < NUM_CARRIERS; c++) { re[c] = xr[binOf(c)]; im[c] = xi[binOf(c)]; }
  return [re, im];
}

/**
 * Demodulates one frame whose chirp starts at `start` in `buf`. Construct once
 * the header has arrived (HEADER_END samples); call decodePayload once the whole
 * frame (frameLength) has arrived.
 */
export class FrameDemodulator {
  readonly header: FrameHeader | null;
  readonly length: number;
  private readonly hRe = new Float64Array(NUM_CARRIERS);
  private readonly hIm = new Float64Array(NUM_CARRIERS);
  private readonly noise = new Float64Array(NUM_CARRIERS);
  private lineA = 0;
  private lineB = 0;
  private velA = 0;
  private velB = 0;
  private symbolsSeen = 1;
  private bursts = 0;
  /** Slowly tracked ratio of actual pilot noise to the estimate. */
  private slowFactor = 1;
  private learned = 0;

  readonly start: number;

  /** True when the header failed and `fallback` (the last good one) is used. */
  readonly headerGuessed: boolean;

  /**
   * `fallback`: the last good header from this transfer. Every frame of a
   * transfer has the same header, so a header lost to a loud syllable can be
   * replaced; the payload CRC still rejects a wrong guess.
   */
  constructor(buf: Float32Array, start: number, fallback: FrameHeader | null = null) {
    this.start = start;
    this.estimateChannel(buf);
    const decoded = this.decodeHeader(buf);
    this.headerGuessed = !decoded && !!fallback;
    this.header = decoded ?? fallback;
    this.length = this.header ? frameLength(this.header) : HEADER_END;
  }

  private estimateChannel(buf: Float32Array) {
    const t0 = this.start + PREAMBLE_LEN;
    const [r1, i1] = carriersAt(buf, t0);
    const [r2, i2] = carriersAt(buf, t0 + SYMBOL_LEN);
    // Interferers (whines, hum harmonics) show up as carriers far louder than
    // their neighbours. They must not steer the drift fit, and must be distrusted.
    const amp = new Float64Array(NUM_CARRIERS);
    for (let c = 0; c < NUM_CARRIERS; c++) amp[c] = r1[c] ** 2 + i1[c] ** 2 + r2[c] ** 2 + i2[c] ** 2;
    const jammed = new Uint8Array(NUM_CARRIERS);
    for (let c = 0; c < NUM_CARRIERS; c++) {
      const near: number[] = [];
      for (let k = Math.max(0, c - 8); k <= Math.min(NUM_CARRIERS - 1, c + 8); k++) near.push(amp[k]);
      near.sort((x, y) => x - y);
      if (amp[c] > 8 * near[near.length >> 1]) jammed[c] = 1;
    }
    // Phase drift between the two training symbols (clock mismatch): robust
    // line fit with equal weights, then again without outliers.
    const ph = new Float64Array(NUM_CARRIERS);
    for (let c = 0; c < NUM_CARRIERS; c++) {
      ph[c] = Math.atan2(i2[c] * r1[c] - r2[c] * i1[c], r2[c] * r1[c] + i2[c] * i1[c]);
    }
    const fitWhere = (keep: (c: number) => boolean) => {
      const cs: number[] = [], p: number[] = [], w: number[] = [];
      for (let c = 0; c < NUM_CARRIERS; c++) if (keep(c)) { cs.push(c); p.push(ph[c]); w.push(1); }
      return fitLine(cs, p, w);
    };
    let [a, b] = fitWhere((c) => !jammed[c]);
    const resid = (c: number) => Math.abs(ph[c] - (a + b * (c - XC)));
    const res = Array.from({ length: NUM_CARRIERS }, (_, c) => (jammed[c] ? Infinity : resid(c)));
    const mad = res.filter(Number.isFinite).sort((x, y) => x - y)[Math.floor(NUM_CARRIERS / 2)] ?? 0;
    [a, b] = fitWhere((c) => !jammed[c] && res[c] <= Math.max(3 * mad, 0.02));
    this.velA = a; this.velB = b;
    const { hRe, hIm, noise } = this;
    const raw = new Float64Array(NUM_CARRIERS);
    for (let c = 0; c < NUM_CARRIERS; c++) {
      const phi = -(a + b * (c - XC));
      const cr = Math.cos(phi), ci = Math.sin(phi);
      const y2r = r2[c] * cr - i2[c] * ci;
      const y2i = r2[c] * ci + i2[c] * cr;
      const yr = (r1[c] + y2r) / 2, yi = (i1[c] + y2i) / 2;
      // H = Y / T  (|T| = 1)
      hRe[c] = yr * TRAIN_RE[c] + yi * TRAIN_IM[c];
      hIm[c] = yi * TRAIN_RE[c] - yr * TRAIN_IM[c];
      const dr = r1[c] - y2r, di = i1[c] - y2i;
      raw[c] = (dr * dr + di * di) / 2;
    }
    // H is referenced to the first training symbol; the line below is the phase
    // at the second one, so the next prediction (header) is two steps of drift.
    this.lineA = a; this.lineB = b;
    // Smooth the noise estimate across neighbouring carriers.
    for (let c = 0; c < NUM_CARRIERS; c++) {
      let s = 0, n = 0;
      for (let d = -4; d <= 4; d++) {
        const k = c + d;
        if (k >= 0 && k < NUM_CARRIERS) { s += raw[k]; n++; }
      }
      const h2 = hRe[c] * hRe[c] + hIm[c] * hIm[c];
      // Cap per-carrier SNR at 30 dB; never trust a carrier less than its own reading.
      noise[c] = Math.max(s / n, raw[c] / 2, h2 * 1e-3, 1e-12);
      if (jammed[c]) noise[c] = Math.max(noise[c], h2);
    }
  }

  /**
   * Equalise one header/data symbol. Pilots re-estimate the phase line (clock
   * drift), common gain and a per-symbol noise factor (bursts like claps).
   */
  private equalise(
    buf: Float32Array, symIndex: number, orderOf: (c: number) => number, out: Float32Array, pos: number,
  ): number {
    const [yr, yi] = carriersAt(buf, this.start + PREAMBLE_LEN + (2 + symIndex) * SYMBOL_LEN);
    const { hRe, hIm, noise } = this;
    // Predict phase line one symbol ahead.
    const predA = this.lineA + this.velA;
    const predB = this.lineB + this.velB;
    const cs: number[] = [], ph: number[] = [], w: number[] = [];
    const qr: number[] = [], qi: number[] = [];
    PILOTS.forEach((c, j) => {
      const p = pilotValue(symIndex, j);
      // q = Y / (H·P) · e^{-j·pred}
      const h2 = hRe[c] * hRe[c] + hIm[c] * hIm[c];
      let ar = (yr[c] * hRe[c] + yi[c] * hIm[c]) / (h2 * p);
      let ai = (yi[c] * hRe[c] - yr[c] * hIm[c]) / (h2 * p);
      const phi = -(predA + predB * (c - XC));
      const cr = Math.cos(phi), ci = Math.sin(phi);
      const tr = ar * cr - ai * ci; ai = ar * ci + ai * cr; ar = tr;
      cs.push(c); ph.push(Math.atan2(ai, ar)); w.push(h2 / noise[c]);
      qr.push(ar); qi.push(ai);
    });
    const [da, db] = fitLine(cs, ph, w);
    let gNum = 0, gDen = 0;
    cs.forEach((c, i) => {
      const phi = da + db * (c - XC);
      gNum += w[i] * (qr[i] * Math.cos(phi) + qi[i] * Math.sin(phi));
      gDen += w[i];
    });
    const g = Math.min(3, Math.max(0.3, gDen > 0 ? gNum / gDen : 1));
    const lineA = predA + da;
    const lineB = predB + db;
    // Alpha-beta tracking of the drift velocity.
    this.velA += 0.25 * da; this.velB += 0.25 * db;
    this.lineA = lineA; this.lineB = lineB;
    this.symbolsSeen = symIndex + 2;

    // Pilot residual vs. expected noise → per-symbol noise factor. The median
    // ignores a few jammed pilots (a new whine); a broadband burst (clap,
    // knock) lifts it.
    const ratios: number[] = [];
    PILOTS.forEach((c, j) => {
      const p = pilotValue(symIndex, j);
      const phi = lineA + lineB * (c - XC);
      const cr = Math.cos(phi) * g, ci = Math.sin(phi) * g;
      const er = (hRe[c] * cr - hIm[c] * ci) * p;
      const ei = (hRe[c] * ci + hIm[c] * cr) * p;
      ratios.push(((yr[c] - er) ** 2 + (yi[c] - ei) ** 2) / noise[c]);
    });
    ratios.sort((x, y) => x - y);
    // Median of an exponential variable is ln 2 ≈ 0.69 of its mean.
    const rho = ratios[ratios.length >> 1] / 0.69;
    // Persistent extra noise (echo of earlier symbols) is tracked slowly; a
    // sudden jump above that level is a burst for this symbol only.
    const burst = Math.max(1, rho / (1.2 * this.slowFactor));
    const isBurst = burst > 3;
    if (isBurst) this.bursts++;
    this.slowFactor = Math.max(1, 0.8 * this.slowFactor + 0.2 * Math.min(rho, 3 * this.slowFactor));
    const factor = this.slowFactor * burst;

    // Equalise and demap every data carrier, remembering the hard decisions.
    const n = NON_PILOTS.length;
    const ur = new Float64Array(n), ui = new Float64Array(n);
    const dr = new Float64Array(n), di = new Float64Array(n);
    const used = new Uint8Array(n);
    NON_PILOTS.forEach((c, i) => {
      const ord = orderOf(c);
      if (!ord) return;
      const phi = -(lineA + lineB * (c - XC));
      const cr = Math.cos(phi) / g, ci = Math.sin(phi) / g;
      const h2 = hRe[c] * hRe[c] + hIm[c] * hIm[c];
      // u = Y · e^{-jφ} / g ;  z = u / H
      const a = yr[c] * cr - yi[c] * ci;
      const b = yr[c] * ci + yi[c] * cr;
      ur[i] = a; ui[i] = b;
      const zr = (a * hRe[c] + b * hIm[c]) / h2;
      const zi = (b * hRe[c] - a * hIm[c]) / h2;
      demapPoint(zr, zi, ord, (noise[c] * factor) / h2, out, pos);
      pos += ord;
      const [xr, xi] = slicePoint(zr, zi, ord);
      dr[i] = xr; di[i] = xi;
      // Only learn from confident decisions.
      used[i] = (zr - xr) ** 2 + (zi - xi) ** 2 < SLICE_GATE[ord] ? 1 : 0;
    });

    // Decision-directed update of channel and noise. Averaging over many data
    // symbols removes estimation error left by the two training symbols (e.g.
    // the sync chirp's echo), lets the noise estimate see echo from data, and
    // lets it find interferers that appear mid-frame (a new chord, a whine).
    if (!isBurst) {
      // Running average early on (training counts as 2 observations), then a
      // fixed forgetting rate so the estimate can follow slow changes.
      this.learned++;
      const muH = Math.max(MU_H, 1 / (this.learned + 2));
      const muN = Math.max(MU_NOISE, 1 / (this.learned + 2));
      // Residual u − H·X on every active carrier (pilots: known X; data: decision).
      const res = new Float64Array(NUM_CARRIERS).fill(-1);
      const resid = (c: number, a: number, b: number, xr: number, xi: number) => {
        const er = a - (hRe[c] * xr - hIm[c] * xi);
        const ei = b - (hRe[c] * xi + hIm[c] * xr);
        res[c] = er * er + ei * ei;
      };
      const pu = PILOTS.map((c, j) => {
        const phi = -(lineA + lineB * (c - XC));
        const cr = Math.cos(phi) / g, ci = Math.sin(phi) / g;
        const a = yr[c] * cr - yi[c] * ci, b = yr[c] * ci + yi[c] * cr;
        resid(c, a, b, pilotValue(symIndex, j), 0);
        return [a, b];
      });
      NON_PILOTS.forEach((c, i) => { if (orderOf(c)) resid(c, ur[i], ui[i], dr[i], di[i]); });
      for (let c = 0; c < NUM_CARRIERS; c++) {
        if (res[c] < 0) continue;
        // Smooth over neighbours (interferers leak into adjacent bins anyway).
        let sum = 0, cnt = 0;
        for (let k = Math.max(0, c - 1); k <= Math.min(NUM_CARRIERS - 1, c + 1); k++) {
          if (res[k] >= 0) { sum += res[k]; cnt++; }
        }
        const e = sum / cnt;
        const mu = e > noise[c] ? Math.max(muN, MU_NOISE_UP) : muN;
        noise[c] = Math.max((1 - mu) * noise[c] + mu * e, (hRe[c] ** 2 + hIm[c] ** 2) * 1e-3, 1e-12);
      }
      const learnH = (c: number, a: number, b: number, xr: number, xi: number) => {
        // H_new = u / X  (|X| may differ from 1 for 16-QAM)
        const x2 = xr * xr + xi * xi;
        hRe[c] = (1 - muH) * hRe[c] + (muH * (a * xr + b * xi)) / x2;
        hIm[c] = (1 - muH) * hIm[c] + (muH * (b * xr - a * xi)) / x2;
      };
      PILOTS.forEach((c, j) => learnH(c, pu[j][0], pu[j][1], pilotValue(symIndex, j), 0));
      NON_PILOTS.forEach((c, i) => { if (used[i]) learnH(c, ur[i], ui[i], dr[i], di[i]); });
    }
    return pos;
  }

  private decodeHeader(buf: Float32Array): FrameHeader | null {
    const raw = new Float32Array(NON_PILOTS.length);
    this.equalise(buf, 0, () => 1, raw, 0);
    const llr = new Float32Array(HEADER_CODED);
    const white = whiteningBits(NON_PILOTS.length, HEADER_SEED);
    for (let i = 0; i < raw.length; i++) llr[i % HEADER_CODED] += white[i] ? -raw[i] : raw[i];
    const bits = viterbiDecode(llr, HEADER_INFO_BITS, 0);
    const h = unpackHeader(bitsToBytes(bits));
    if (h && dataSymbolCount(h) > MAX_DATA_SYMBOLS) return null;
    return h;
  }

  /** Decode the payload; null if the CRC fails. Requires the whole frame in buf. */
  decodePayload(buf: Float32Array): Uint8Array | null {
    const h = this.header;
    if (!h) return null;
    const nData = dataSymbolCount(h);
    const bps = bitsPerSymbol(h.toneMap);
    const total = nData * bps;
    const llr = new Float32Array(total);
    const orderOf = (c: number) => h.toneMap[groupOf(c)];
    let pos = 0;
    for (let s = 0; s < nData; s++) pos = this.equalise(buf, s + 1, orderOf, llr, pos);
    const white = whiteningBits(total, DATA_SEED);
    for (let i = 0; i < total; i++) if (white[i]) llr[i] = -llr[i];
    const nInfo = (h.length + 4) * 8;
    const coded = deinterleave(llr.subarray(0, codedLength(nInfo, h.rate)));
    const bytes = bitsToBytes(viterbiDecode(coded, nInfo, h.rate));
    const payload = bytes.subarray(0, h.length);
    const crc = new DataView(bytes.buffer, bytes.byteOffset).getUint32(h.length);
    return crc32(payload) === crc ? payload.slice() : null;
  }

  report(): LinkReport {
    // Per-group SNR from the latest (decision-refined) channel and noise estimates.
    const groupSnrDb: number[] = [];
    let total = 0;
    for (let g = 0; g < NUM_GROUPS; g++) {
      let snr = 0;
      for (let c = g * 11; c < (g + 1) * 11; c++) snr += (this.hRe[c] ** 2 + this.hIm[c] ** 2) / this.noise[c];
      total += snr / 11;
      groupSnrDb.push(Math.round(100 * Math.log10(snr / 11)) / 10);
    }
    // Phase slope per carrier = 2π·δ/N for a timing drift of δ samples.
    const delta = (this.lineB * FFT_N) / (2 * Math.PI);
    const elapsed = this.symbolsSeen * SYMBOL_LEN;
    return {
      groupSnrDb,
      snrDb: Math.round(100 * Math.log10(total / NUM_GROUPS)) / 10,
      driftPpm: Math.round(((delta / elapsed) * 1e6) * 10) / 10,
      burstSymbols: this.bursts,
    };
  }
}

export const FRAME_SECONDS = (h: FrameHeader) => (frameLength(h) + FRAME_GAP) / SAMPLE_RATE;
