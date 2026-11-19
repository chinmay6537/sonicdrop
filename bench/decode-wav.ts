// Run the receiver over a recorded WAV and report what it decoded.
//
//   node bench/decode-wav.ts recording.wav [--expect-size 15000] [--seed 1] [--out file.bin]

import { readFileSync, writeFileSync } from 'node:fs';
import { Prng } from '../src/dsp/prng.ts';
import { decodeWav, resampleRatio } from '../src/io/wav.ts';
import { SAMPLE_RATE } from '../src/modem/params.ts';
import { Receiver } from '../src/modem/rx.ts';

const args = process.argv.slice(2);
const arg = (k: string, d: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const wav = decodeWav(new Uint8Array(readFileSync(args[0])));
const mic = resampleRatio(wav.samples, SAMPLE_RATE / wav.sampleRate);
let peak = 0, sq = 0;
for (const v of mic) { peak = Math.max(peak, Math.abs(v)); sq += v * v; }
console.log(`${args[0]}: ${(mic.length / SAMPLE_RATE).toFixed(1)} s @ ${wav.sampleRate} Hz, peak ${(20 * Math.log10(peak)).toFixed(1)} dBFS, rms ${(10 * Math.log10(sq / mic.length)).toFixed(1)} dBFS`);

const rx = new Receiver();
let firstFrame = -1;
const marks: string[] = [];
for (let i = 0; i < mic.length; i += 2048) {
  for (const e of rx.push(mic.subarray(i, i + 2048))) {
    if (e.type === 'frame') {
      if (firstFrame < 0) firstFrame = e.at;
      marks.push(`${e.ok ? 'ok' : 'X'}(${e.report.snrDb})`);
    }
    if (e.type === 'file') {
      const secs = (e.at - firstFrame) / SAMPLE_RATE;
      console.log(`FILE decoded: ${e.data.length} bytes in ${secs.toFixed(1)} s from first frame → ${((e.data.length * 8) / secs / 1000).toFixed(2)} kbps`);
      const size = Number(arg('expect-size', '0'));
      if (size) {
        const r = new Prng(Number(arg('seed', '1')));
        const ref = Uint8Array.from({ length: size }, () => r.nextU32() & 0xff);
        console.log(ref.length === e.data.length && ref.every((v, j) => v === e.data[j]) ? 'content: MATCHES original' : 'content: MISMATCH');
      }
      const out = arg('out', '');
      if (out) writeFileSync(out, e.data);
    }
  }
}
const r = rx.lastReport;
console.log('stats', rx.stats);
console.log('frames', marks.join(' '));
if (r) console.log(`last frame: SNR ${r.snrDb} dB, drift ${r.driftPpm} ppm, groups ${r.groupSnrDb.join(' ')}`);
