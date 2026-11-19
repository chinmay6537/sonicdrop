// Benchmark: send a file through every simulated room and report speed and success.
//
//   node bench/run.ts [--profile standard|robust|fast|turbo|all] [--size 15000] [--seed 1] [--only name]

import { Prng } from '../src/dsp/prng.ts';
import { PROFILES, SAMPLE_RATE } from '../src/modem/params.ts';
import type { Profile } from '../src/modem/params.ts';
import { Receiver } from '../src/modem/rx.ts';
import { Transmitter } from '../src/modem/tx.ts';
import { SCENARIOS, simulate } from '../src/sim/channel.ts';

const args = process.argv.slice(2);
const arg = (k: string, d: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const size = Number(arg('size', '15000'));
const seed = Number(arg('seed', '1'));
const only = arg('only', '');
const profName = arg('profile', 'standard');
const profiles: Profile[] = profName === 'all' ? Object.values(PROFILES) : [PROFILES[profName as keyof typeof PROFILES]];

const rng = new Prng(seed);
const file = Uint8Array.from({ length: size }, () => rng.nextU32() & 0xff);

console.log(`file: ${size} bytes (random, incompressible), seed ${seed}\n`);
const pad = (s: string | number, n: number) => String(s).padEnd(n);
console.log(pad('profile', 10) + pad('scenario', 22) + pad('result', 8) + pad('time', 9) + pad('net kbps', 10) + pad('frames ok/sent', 16) + pad('SNR dB', 8) + 'drift ppm');

for (const profile of profiles) {
  for (const sc of SCENARIOS) {
    if (only && !sc.name.includes(only)) continue;
    const tx = new Transmitter(file, { profile, fileId: 1234 });
    const nFrames = Math.ceil(tx.blocks * 1.6) + 6;
    const frames: Float32Array[] = [];
    for (let i = 0; i < nFrames; i++) frames.push(tx.nextFrame());
    const total = frames.reduce((s, f) => s + f.length, 0);
    const stream = new Float32Array(total);
    let o = 0;
    for (const f of frames) { stream.set(f, o); o += f.length; }
    const lead = 0.3;
    const mic = simulate(stream, sc, { seed: seed * 7 + 3, leadIn: lead });

    const rx = new Receiver();
    let doneAt = -1;
    let ok = false;
    const snrs: number[] = [];
    const drifts: number[] = [];
    for (let i = 0; i < mic.length && doneAt < 0; i += 2048) {
      for (const e of rx.push(mic.subarray(i, i + 2048))) {
        if (e.type === 'frame') { snrs.push(e.report.snrDb); drifts.push(e.report.driftPpm); }
        if (e.type === 'file') {
          doneAt = e.at;
          ok = e.data.length === file.length && e.data.every((v, j) => v === file[j]);
        }
      }
    }
    const secs = doneAt >= 0 ? doneAt / SAMPLE_RATE - lead : NaN;
    const framesSent = doneAt >= 0 ? Math.min(nFrames, rx.stats.framesOk + rx.stats.framesBad + rx.stats.badHeaders) : nFrames;
    const med = (a: number[]) => (a.length ? a.slice().sort((x, y) => x - y)[a.length >> 1] : NaN);
    console.log(
      pad(profile.name, 10) + pad(sc.name, 22) + pad(doneAt < 0 ? 'FAIL' : ok ? 'ok' : 'CORRUPT', 8) +
      pad(Number.isNaN(secs) ? '-' : secs.toFixed(1) + ' s', 9) +
      pad(Number.isNaN(secs) ? '-' : ((size * 8) / secs / 1000).toFixed(2), 10) +
      pad(`${rx.stats.framesOk}/${framesSent} (k=${tx.blocks})`, 16) +
      pad(med(snrs).toFixed(1), 8) + med(drifts).toFixed(0),
    );
  }
}
