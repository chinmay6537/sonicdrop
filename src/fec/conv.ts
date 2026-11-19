// Rate-1/2, constraint-length-7 convolutional code (generators 171/133 octal,
// the NASA/802.11 code) with puncturing to 2/3 and 3/4, and a soft-decision
// Viterbi decoder. Soft decisions use LLRs: positive means "bit is probably 0".

import type { CodeRate } from '../modem/params.ts';

const K = 7;
const STATES = 1 << (K - 1); // 64
const TAIL = K - 1;
const G0 = 0o171;
const G1 = 0o133;

const parity = (x: number) => {
  x ^= x >> 4; x ^= x >> 2; x ^= x >> 1;
  return x & 1;
};

// Output bits for each 7-bit register value (input bit at position 6).
const OUT0 = new Uint8Array(1 << K);
const OUT1 = new Uint8Array(1 << K);
for (let r = 0; r < 1 << K; r++) {
  OUT0[r] = parity(r & G0);
  OUT1[r] = parity(r & G1);
}

// Puncture patterns: for input index i mod period, keep output 0 / output 1?
const PUNCTURE: Array<[number[], number[]]> = [
  [[1], [1]],
  [[1, 1], [1, 0]],
  [[1, 1, 0], [1, 0, 1]],
];

/** Number of coded bits for `nInfo` information bits (tail included). */
export function codedLength(nInfo: number, rate: CodeRate): number {
  const [p0, p1] = PUNCTURE[rate];
  const period = p0.length;
  let n = 0;
  for (let i = 0; i < nInfo + TAIL; i++) n += p0[i % period] + p1[i % period];
  return n;
}

/** Encode bits (0/1), appending a zero tail, then puncture. */
export function convEncode(bits: Uint8Array, rate: CodeRate): Uint8Array {
  const [p0, p1] = PUNCTURE[rate];
  const period = p0.length;
  const out = new Uint8Array(codedLength(bits.length, rate));
  let state = 0;
  let o = 0;
  const total = bits.length + TAIL;
  for (let i = 0; i < total; i++) {
    const b = i < bits.length ? bits[i] : 0;
    const reg = (b << (K - 1)) | state;
    if (p0[i % period]) out[o++] = OUT0[reg];
    if (p1[i % period]) out[o++] = OUT1[reg];
    state = reg >> 1;
  }
  return out;
}

/** Soft Viterbi decode of punctured LLRs back to `nInfo` bits. */
export function viterbiDecode(llr: Float32Array, nInfo: number, rate: CodeRate): Uint8Array {
  const [p0, p1] = PUNCTURE[rate];
  const period = p0.length;
  const steps = nInfo + TAIL;
  // Depuncture: missing positions get LLR 0 (no information).
  const l0 = new Float32Array(steps);
  const l1 = new Float32Array(steps);
  let o = 0;
  for (let i = 0; i < steps; i++) {
    if (p0[i % period]) l0[i] = llr[o++] ?? 0;
    if (p1[i % period]) l1[i] = llr[o++] ?? 0;
  }

  let pm = new Float64Array(STATES).fill(-1e18);
  let npm = new Float64Array(STATES);
  pm[0] = 0;
  const decisions = new Uint8Array(steps * STATES);

  for (let t = 0; t < steps; t++) {
    const a = l0[t];
    const b = l1[t];
    let best = -Infinity;
    for (let ns = 0; ns < STATES; ns++) {
      const input = ns >> (K - 2);
      const s0 = (ns << 1) & (STATES - 1);
      const s1 = s0 | 1;
      const r0 = (input << (K - 1)) | s0;
      const r1 = (input << (K - 1)) | s1;
      const m0 = pm[s0] + (OUT0[r0] ? -a : a) + (OUT1[r0] ? -b : b);
      const m1 = pm[s1] + (OUT0[r1] ? -a : a) + (OUT1[r1] ? -b : b);
      if (m1 > m0) {
        npm[ns] = m1;
        decisions[t * STATES + ns] = 1;
      } else {
        npm[ns] = m0;
      }
      if (npm[ns] > best) best = npm[ns];
    }
    for (let s = 0; s < STATES; s++) npm[s] -= best;
    const tmp = pm; pm = npm; npm = tmp;
  }

  // Trellis is terminated, so trace back from state 0.
  const out = new Uint8Array(nInfo);
  let ns = 0;
  for (let t = steps - 1; t >= 0; t--) {
    if (t < nInfo) out[t] = ns >> (K - 2);
    const x = decisions[t * STATES + ns];
    ns = ((ns << 1) & (STATES - 1)) | x;
  }
  return out;
}
