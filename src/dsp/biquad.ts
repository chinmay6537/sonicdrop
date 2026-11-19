// Biquad IIR filters (RBJ cookbook) and a streaming band-pass used by the
// receiver to strip speech, hum and other out-of-band noise before anything else.

export interface BiquadCoeffs {
  b0: number; b1: number; b2: number; a1: number; a2: number;
}

export function highpass(fc: number, q: number, sr: number): BiquadCoeffs {
  const w = (2 * Math.PI * fc) / sr;
  const alpha = Math.sin(w) / (2 * q);
  const c = Math.cos(w);
  const a0 = 1 + alpha;
  return {
    b0: (1 + c) / 2 / a0, b1: -(1 + c) / a0, b2: (1 + c) / 2 / a0,
    a1: (-2 * c) / a0, a2: (1 - alpha) / a0,
  };
}

export function lowpass(fc: number, q: number, sr: number): BiquadCoeffs {
  const w = (2 * Math.PI * fc) / sr;
  const alpha = Math.sin(w) / (2 * q);
  const c = Math.cos(w);
  const a0 = 1 + alpha;
  return {
    b0: (1 - c) / 2 / a0, b1: (1 - c) / a0, b2: (1 - c) / 2 / a0,
    a1: (-2 * c) / a0, a2: (1 - alpha) / a0,
  };
}

/** Peaking EQ, used by the channel simulator to fake uneven speaker response. */
export function peaking(fc: number, q: number, gainDb: number, sr: number): BiquadCoeffs {
  const A = Math.pow(10, gainDb / 40);
  const w = (2 * Math.PI * fc) / sr;
  const alpha = Math.sin(w) / (2 * q);
  const c = Math.cos(w);
  const a0 = 1 + alpha / A;
  return {
    b0: (1 + alpha * A) / a0, b1: (-2 * c) / a0, b2: (1 - alpha * A) / a0,
    a1: (-2 * c) / a0, a2: (1 - alpha / A) / a0,
  };
}

/** Cascade of biquads with persistent state, so it can filter a stream chunk by chunk. */
export class BiquadChain {
  private readonly stages: BiquadCoeffs[];
  private z1: Float64Array;
  private z2: Float64Array;
  constructor(stages: BiquadCoeffs[]) {
    this.stages = stages;
    this.z1 = new Float64Array(stages.length);
    this.z2 = new Float64Array(stages.length);
  }
  process(input: Float32Array, output: Float32Array = new Float32Array(input.length)): Float32Array {
    const { stages, z1, z2 } = this;
    for (let i = 0; i < input.length; i++) {
      let x = input[i];
      for (let s = 0; s < stages.length; s++) {
        const c = stages[s];
        const y = c.b0 * x + z1[s];
        z1[s] = c.b1 * x - c.a1 * y + z2[s];
        z2[s] = c.b2 * x - c.a2 * y;
        x = y;
      }
      output[i] = x;
    }
    return output;
  }
}

// Q values for a 4th-order Butterworth split into two biquads.
const BUTTER4 = [0.5411961, 1.3065630];

/** 4th-order Butterworth high-pass + 4th-order low-pass. */
export function makeBandpass(lowHz: number, highHz: number, sr: number): BiquadChain {
  return new BiquadChain([
    ...BUTTER4.map((q) => highpass(lowHz, q, sr)),
    ...BUTTER4.map((q) => lowpass(highHz, q, sr)),
  ]);
}
