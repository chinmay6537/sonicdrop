// Gray-mapped BPSK / QPSK / 16-QAM with unit average power, and max-log soft
// demapping to LLRs (positive = bit 0).

const S2 = Math.SQRT1_2;
const S10 = 1 / Math.sqrt(10);

// Per-dimension PAM alphabets: level and its bit label (MSB first).
interface Pam { levels: number[]; labels: number[][]; bits: number }
const PAM2: Pam = { levels: [1, -1], labels: [[0], [1]], bits: 1 };
const PAM4: Pam = { levels: [-3, -1, 1, 3], labels: [[0, 0], [0, 1], [1, 1], [1, 0]], bits: 2 };

function pamIndex(p: Pam, bits: Uint8Array, off: number): number {
  for (let i = 0; i < p.levels.length; i++) {
    const l = p.labels[i];
    let ok = true;
    for (let b = 0; b < p.bits; b++) if (l[b] !== bits[off + b]) { ok = false; break; }
    if (ok) return i;
  }
  return 0;
}

/** Map `order` bits starting at bits[off] to a complex point. */
export function mapPoint(bits: Uint8Array, off: number, order: number): [number, number] {
  switch (order) {
    case 1:
      return [PAM2.levels[pamIndex(PAM2, bits, off)], 0];
    case 2:
      return [PAM2.levels[pamIndex(PAM2, bits, off)] * S2, PAM2.levels[pamIndex(PAM2, bits, off + 1)] * S2];
    case 4:
      return [PAM4.levels[pamIndex(PAM4, bits, off)] * S10, PAM4.levels[pamIndex(PAM4, bits, off + 2)] * S10];
    default:
      throw new Error(`unsupported order ${order}`);
  }
}

function demapDim(p: Pam, scale: number, y: number, noiseVarDim: number, out: Float32Array, off: number) {
  for (let b = 0; b < p.bits; b++) {
    let d0 = Infinity;
    let d1 = Infinity;
    for (let i = 0; i < p.levels.length; i++) {
      const e = y - p.levels[i] * scale;
      const d = e * e;
      if (p.labels[i][b]) { if (d < d1) d1 = d; } else if (d < d0) d0 = d;
    }
    out[off + b] = (d1 - d0) / (2 * noiseVarDim);
  }
}

/**
 * Soft-demap an equalised point. `noiseVar` is the complex noise variance
 * (E|n|²) after equalisation. Writes `order` LLRs at out[off].
 */
export function demapPoint(re: number, im: number, order: number, noiseVar: number, out: Float32Array, off: number) {
  const nv = Math.max(noiseVar / 2, 1e-9);
  switch (order) {
    case 1: demapDim(PAM2, 1, re, nv, out, off); break;
    case 2: demapDim(PAM2, S2, re, nv, out, off); demapDim(PAM2, S2, im, nv, out, off + 1); break;
    case 4: demapDim(PAM4, S10, re, nv, out, off); demapDim(PAM4, S10, im, nv, out, off + 2); break;
    default: throw new Error(`unsupported order ${order}`);
  }
}

const nearest = (levels: number[], scale: number, y: number) => {
  let best = levels[0] * scale;
  for (const l of levels) if (Math.abs(y - l * scale) < Math.abs(y - best)) best = l * scale;
  return best;
};

/** Hard decision: the constellation point nearest to an equalised sample. */
export function slicePoint(re: number, im: number, order: number): [number, number] {
  switch (order) {
    case 1: return [re >= 0 ? 1 : -1, 0];
    case 2: return [re >= 0 ? S2 : -S2, im >= 0 ? S2 : -S2];
    case 4: return [nearest(PAM4.levels, S10, re), nearest(PAM4.levels, S10, im)];
    default: throw new Error(`unsupported order ${order}`);
  }
}
