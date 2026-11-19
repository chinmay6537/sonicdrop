import { describe, expect, it } from 'vitest';
import { Prng } from '../src/dsp/prng.ts';
import { buildFrame, FrameDemodulator } from '../src/modem/frame.ts';
import { PROFILES } from '../src/modem/params.ts';
import type { Profile } from '../src/modem/params.ts';
import { Receiver } from '../src/modem/rx.ts';
import { Transmitter } from '../src/modem/tx.ts';
import { SCENARIOS, simulate } from '../src/sim/channel.ts';

const scenario = (name: string) => SCENARIOS.find((s) => s.name.startsWith(name))!;

function transfer(size: number, profile: Profile, scName: string, seed = 1) {
  const r = new Prng(seed);
  const file = Uint8Array.from({ length: size }, () => r.nextU32() & 0xff);
  const tx = new Transmitter(file, { profile, fileId: 77 });
  const frames = Array.from({ length: Math.ceil(tx.blocks * 1.5) + 4 }, () => tx.nextFrame());
  const stream = new Float32Array(frames.reduce((s, f) => s + f.length, 0));
  let o = 0;
  for (const f of frames) { stream.set(f, o); o += f.length; }
  const mic = simulate(stream, scenario(scName), { seed: seed + 100 });
  const rx = new Receiver();
  for (let i = 0; i < mic.length; i += 1024) {
    for (const e of rx.push(mic.subarray(i, i + 1024))) if (e.type === 'file') return { file, got: e.data };
  }
  return { file, got: null };
}

describe('frame', () => {
  it('round-trips a frame with every profile on a clean signal', () => {
    for (const profile of Object.values(PROFILES)) {
      const payload = Uint8Array.from({ length: 300 }, (_, i) => (i * 31) & 255);
      const audio = buildFrame(payload, profile);
      const buf = new Float32Array(audio.length + 2000);
      buf.set(audio, 0);
      const d = new FrameDemodulator(buf, 0);
      expect(d.header?.length).toBe(300);
      expect(d.decodePayload(buf)).toEqual(payload);
    }
  });
});

describe('end-to-end transfer through simulated rooms', () => {
  it('standard profile, quiet room', () => {
    const { file, got } = transfer(3000, PROFILES.standard, 'quiet room');
    expect(got).toEqual(file);
  }, 60000);

  it('standard profile, 7 kHz fan whine', () => {
    const { file, got } = transfer(3000, PROFILES.standard, 'fan whine');
    expect(got).toEqual(file);
  }, 60000);

  it('robust profile, everything at once (talkers, whine, claps, echo, clipping, drift)', () => {
    const { file, got } = transfer(2000, PROFILES.robust, 'everything');
    expect(got).toEqual(file);
  }, 60000);
});
