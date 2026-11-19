// Write a transmission to a WAV file (to play through a real speaker).
//
//   node bench/make-wav.ts out.wav [--profile standard] [--size 15000] [--frames N] [--file photo.webp]

import { readFileSync, writeFileSync } from 'node:fs';
import { Prng } from '../src/dsp/prng.ts';
import { encodeWav } from '../src/io/wav.ts';
import { PROFILES, SAMPLE_RATE } from '../src/modem/params.ts';
import { Transmitter } from '../src/modem/tx.ts';

const args = process.argv.slice(2);
const out = args[0];
const arg = (k: string, d: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
if (!out) throw new Error('usage: make-wav.ts out.wav [--profile p] [--size n] [--frames n] [--file f]');

const src = arg('file', '');
const data = src ? new Uint8Array(readFileSync(src)) : (() => {
  const r = new Prng(Number(arg('seed', '1')));
  return Uint8Array.from({ length: Number(arg('size', '15000')) }, () => r.nextU32() & 0xff);
})();
const profile = PROFILES[arg('profile', 'standard') as keyof typeof PROFILES];
const tx = new Transmitter(data, { profile, fileId: 4242 });
const frames = Number(arg('frames', String(Math.ceil(tx.blocks * 1.5) + 4)));
const parts: Float32Array[] = [new Float32Array(SAMPLE_RATE / 2)]; // 0.5 s lead-in
for (let i = 0; i < frames; i++) parts.push(tx.nextFrame());
parts.push(new Float32Array(SAMPLE_RATE / 2));
const all = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
let o = 0;
for (const p of parts) { all.set(p, o); o += p.length; }
writeFileSync(out, encodeWav(all, SAMPLE_RATE));
console.log(`${out}: ${data.length} bytes, profile ${profile.name}, ${frames} frames (${tx.blocks} needed), ${(all.length / SAMPLE_RATE).toFixed(1)} s`);
