// Minimal WAV encode/decode (mono 16-bit PCM out; 16/24/32-bit PCM and 32-bit
// float in, any channel count: the first channel is used) plus resampling, so
// real recordings can be replayed through the receiver offline.

export interface Audio {
  sampleRate: number;
  samples: Float32Array;
}

export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2);
  const dv = new DataView(out.buffer);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  str(36, 'data'); dv.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    dv.setInt16(44 + i * 2, Math.round(v * 32767), true);
  }
  return out;
}

export function decodeWav(bytes: Uint8Array): Audio {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let o = 12;
  let fmt = 0, channels = 1, sampleRate = 48000, bits = 16;
  while (o + 8 <= bytes.length) {
    const id = tag(o);
    const size = dv.getUint32(o + 4, true);
    const body = o + 8;
    if (id === 'fmt ') {
      fmt = dv.getUint16(body, true);
      channels = dv.getUint16(body + 2, true);
      sampleRate = dv.getUint32(body + 4, true);
      bits = dv.getUint16(body + 14, true);
      if (fmt === 0xfffe) fmt = dv.getUint16(body + 24, true); // WAVE_FORMAT_EXTENSIBLE
    } else if (id === 'data') {
      const bytesPer = bits / 8;
      const frames = Math.floor(Math.min(size, bytes.length - body) / (bytesPer * channels));
      const samples = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        const p = body + i * bytesPer * channels;
        if (fmt === 3 && bits === 32) samples[i] = dv.getFloat32(p, true);
        else if (bits === 16) samples[i] = dv.getInt16(p, true) / 32768;
        else if (bits === 24) samples[i] = ((bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16)) << 8 >> 8) / 8388608;
        else if (bits === 32) samples[i] = dv.getInt32(p, true) / 2147483648;
        else throw new Error(`unsupported WAV format ${fmt}/${bits}`);
      }
      return { sampleRate, samples };
    }
    o = body + size + (size & 1);
  }
  throw new Error('WAV has no data chunk');
}

/** Band-limited (windowed-sinc) resampling by an arbitrary ratio out/in. */
export function resampleRatio(x: Float32Array, ratio: number): Float32Array {
  if (ratio === 1) return x;
  const n = Math.floor(x.length * ratio);
  const out = new Float32Array(n);
  const HALF = 16;
  // When downsampling, widen the sinc to low-pass at the new Nyquist.
  const cut = Math.min(1, ratio);
  for (let i = 0; i < n; i++) {
    const t = i / ratio;
    const i0 = Math.floor(t);
    let s = 0;
    for (let k = i0 - Math.ceil(HALF / cut) + 1; k <= i0 + Math.ceil(HALF / cut); k++) {
      if (k < 0 || k >= x.length) continue;
      const d = (t - k) * cut;
      if (Math.abs(d) >= HALF) continue;
      const sinc = d === 0 ? 1 : Math.sin(Math.PI * d) / (Math.PI * d);
      const w = 0.5 + 0.5 * Math.cos((Math.PI * d) / HALF);
      s += x[k] * sinc * w * cut;
    }
    out[i] = s;
  }
  return out;
}
