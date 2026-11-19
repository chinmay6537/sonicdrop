import { describe, expect, it } from 'vitest';
import { fft, ifft } from '../src/dsp/fft.ts';
import { Prng } from '../src/dsp/prng.ts';
import { convEncode, viterbiDecode } from '../src/fec/conv.ts';
import { crc32 } from '../src/fec/crc.ts';
import { FountainDecoder, FountainEncoder, parsePacket } from '../src/fountain/fountain.ts';
import { packEnvelope, unpackEnvelope } from '../src/fountain/envelope.ts';
import { demapPoint, mapPoint } from '../src/modem/constellation.ts';
import type { CodeRate } from '../src/modem/params.ts';

const randomBytes = (n: number, seed = 1) => {
  const r = new Prng(seed);
  return Uint8Array.from({ length: n }, () => r.nextU32() & 0xff);
};

describe('fft', () => {
  it('round-trips', () => {
    const r = new Prng(3);
    const re = Float64Array.from({ length: 1024 }, () => r.gauss());
    const im = new Float64Array(1024);
    const orig = re.slice();
    fft(re, im);
    ifft(re, im);
    for (let i = 0; i < 1024; i++) expect(re[i]).toBeCloseTo(orig[i], 9);
  });
  it('puts a tone in the right bin', () => {
    const re = Float64Array.from({ length: 256 }, (_, n) => Math.cos((2 * Math.PI * 10 * n) / 256));
    const im = new Float64Array(256);
    fft(re, im);
    expect(re[10]).toBeCloseTo(128, 6);
    expect(Math.abs(re[11])).toBeLessThan(1e-9);
  });
});

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

describe('convolutional code', () => {
  for (const rate of [0, 1, 2] as CodeRate[]) {
    it(`corrects noisy bits at rate index ${rate}`, () => {
      const r = new Prng(10 + rate);
      const bits = Uint8Array.from({ length: 800 }, () => r.bit());
      const coded = convEncode(bits, rate);
      // BPSK over AWGN at a modest SNR
      const sigma = rate === 0 ? 0.7 : 0.5;
      const llr = Float32Array.from(coded, (b) => {
        const y = (b ? -1 : 1) + sigma * r.gauss();
        return (2 * y) / (sigma * sigma);
      });
      const out = viterbiDecode(llr, bits.length, rate);
      expect(Array.from(out)).toEqual(Array.from(bits));
    });
  }
});

describe('constellation', () => {
  for (const order of [1, 2, 4]) {
    it(`maps and demaps order ${order}`, () => {
      const r = new Prng(order);
      const bits = Uint8Array.from({ length: order * 50 }, () => r.bit());
      const llr = new Float32Array(bits.length);
      let power = 0;
      for (let i = 0; i < bits.length; i += order) {
        const [a, b] = mapPoint(bits, i, order);
        power += a * a + b * b;
        demapPoint(a, b, order, 0.01, llr, i);
      }
      expect(Math.abs(power / 50 - 1)).toBeLessThan(0.25);
      for (let i = 0; i < bits.length; i++) expect(llr[i] > 0 ? 0 : 1).toBe(bits[i]);
    });
  }
});

describe('fountain code', () => {
  it('rebuilds the file from systematic packets', () => {
    const data = randomBytes(5000);
    const enc = new FountainEncoder(data, 300, 42);
    const dec = new FountainDecoder(42, data.length, 300);
    for (let s = 0; s < enc.k; s++) dec.add(parsePacket(enc.packet(s))!);
    expect(dec.done).toBe(true);
    expect(dec.data).toEqual(data);
  });

  it('rebuilds the file with 40% of packets lost, with little overhead', () => {
    const data = randomBytes(20000, 7);
    const enc = new FountainEncoder(data, 400, 9);
    const dec = new FountainDecoder(9, data.length, 400);
    const r = new Prng(99);
    let seq = 0;
    let used = 0;
    while (!dec.done && seq < enc.k * 4) {
      const p = enc.packet(seq++);
      if (r.next() < 0.4) continue;
      used++;
      dec.add(parsePacket(p)!);
    }
    expect(dec.done).toBe(true);
    expect(dec.data).toEqual(data);
    expect(used).toBeLessThanOrEqual(enc.k + 4);
  });
});

describe('envelope', () => {
  it('round-trips name, type and data', () => {
    const data = randomBytes(100);
    const e = unpackEnvelope(packEnvelope({ name: 'cat 🐱.webp', mime: 'image/webp', data }));
    expect(e).toEqual({ name: 'cat 🐱.webp', mime: 'image/webp', data });
  });
});
