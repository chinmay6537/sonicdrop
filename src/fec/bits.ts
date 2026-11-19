// Bit packing, whitening and interleaving.

import { Prng } from '../dsp/prng.ts';

export function bytesToBits(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length * 8);
  for (let i = 0; i < bytes.length; i++) {
    for (let b = 0; b < 8; b++) out[i * 8 + b] = (bytes[i] >> (7 - b)) & 1;
  }
  return out;
}

export function bitsToBytes(bits: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < out.length; i++) {
    let v = 0;
    for (let b = 0; b < 8; b++) v = (v << 1) | bits[i * 8 + b];
    out[i] = v;
  }
  return out;
}

/** Pseudo-random whitening sequence: keeps the spectrum flat and peaks low. */
export function whiteningBits(n: number, seed: number): Uint8Array {
  const rng = new Prng(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = rng.bit();
  return out;
}

const perms = new Map<number, Uint32Array>();

/**
 * Pseudo-random permutation of length n. Adjacent coded bits end up on far-apart
 * carriers and symbols, so a frequency notch or a noise burst hits scattered bits
 * the Viterbi decoder can repair instead of a long run it can't.
 */
export function interleavePerm(n: number): Uint32Array {
  let p = perms.get(n);
  if (p) return p;
  p = new Uint32Array(n);
  for (let i = 0; i < n; i++) p[i] = i;
  const rng = new Prng(0x1f2e3d4c ^ n);
  for (let i = n - 1; i > 0; i--) {
    const j = rng.nextU32() % (i + 1);
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  perms.set(n, p);
  return p;
}

export function interleave(bits: Uint8Array): Uint8Array {
  const p = interleavePerm(bits.length);
  const out = new Uint8Array(bits.length);
  for (let i = 0; i < bits.length; i++) out[i] = bits[p[i]];
  return out;
}

export function deinterleave(llr: Float32Array): Float32Array {
  const p = interleavePerm(llr.length);
  const out = new Float32Array(llr.length);
  for (let i = 0; i < llr.length; i++) out[p[i]] = llr[i];
  return out;
}
