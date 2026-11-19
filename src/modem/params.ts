// Physical-layer constants shared by transmitter and receiver.
//
// OFDM layout: 1024-point FFT at 48 kHz → 46.875 Hz per bin. 176 subcarriers
// from bin 86 (≈4.03 kHz) to bin 261 (≈12.23 kHz), grouped into 16 groups of 11
// for the tone map. Every 8th carrier is a pilot.

export const SAMPLE_RATE = 48000;
export const FFT_N = 1024;
/** Cyclic prefix: 256 samples ≈ 5.3 ms of echo tolerance. */
export const CP = 256;
export const SYMBOL_LEN = FFT_N + CP;

export const FIRST_BIN = 86;
export const NUM_GROUPS = 16;
export const CARRIERS_PER_GROUP = 11;
export const NUM_CARRIERS = NUM_GROUPS * CARRIERS_PER_GROUP; // 176
export const PILOT_SPACING = 8;
export const PILOT_OFFSET = 4;

/** Synchronisation chirp: linear sweep across (slightly beyond) the data band. */
export const CHIRP_LEN = 2048;
export const CHIRP_F0 = 3800;
export const CHIRP_F1 = 12400;
/** Same power as the OFDM symbols, so its echo doesn't swamp the training symbols. */
export const CHIRP_AMP = 0.28;
/** Silence after the chirp so its echoes fade before the training symbols. */
export const POST_CHIRP_GAP = 960;
/** Silence after each frame. */
export const FRAME_GAP = 960;
/** Start the FFT window this many samples inside the cyclic prefix (timing slack). */
export const FFT_BACKOFF = 48;

/** Time-domain RMS of a symbol with every carrier active. */
export const OFDM_RMS = 0.2;
export const CLIP_LEVEL = 0.98;

/** Receiver band-pass (applied to the mic signal before sync and demodulation). */
export const BANDPASS_LOW = 3400;
export const BANDPASS_HIGH = 12800;

/** Start of the training symbols relative to the chirp start. */
export const PREAMBLE_LEN = CHIRP_LEN + POST_CHIRP_GAP;
/** Samples from frame start to the end of the header symbol. */
export const HEADER_END = PREAMBLE_LEN + 3 * SYMBOL_LEN;

export const binOf = (c: number) => FIRST_BIN + c;
export const isPilot = (c: number) => c % PILOT_SPACING === PILOT_OFFSET;
export const groupOf = (c: number) => Math.floor(c / CARRIERS_PER_GROUP);

export const PILOTS: number[] = [];
export const NON_PILOTS: number[] = [];
for (let c = 0; c < NUM_CARRIERS; c++) (isPilot(c) ? PILOTS : NON_PILOTS).push(c);

export type CodeRate = 0 | 1 | 2; // 1/2, 2/3, 3/4
export const RATE_VALUE = [1 / 2, 2 / 3, 3 / 4] as const;
export const RATE_NAME = ['1/2', '2/3', '3/4'] as const;

/** Bits per carrier for each group: 0 (off), 1 (BPSK), 2 (QPSK) or 4 (16-QAM). */
export type ToneMap = Uint8Array;

export interface Profile {
  name: string;
  rate: CodeRate;
  toneMap: ToneMap;
}

const uniform = (bits: number) => new Uint8Array(NUM_GROUPS).fill(bits);

export const PROFILES = {
  robust: { name: 'robust', rate: 0, toneMap: uniform(1) },
  standard: { name: 'standard', rate: 0, toneMap: uniform(2) },
  fast: { name: 'fast', rate: 1, toneMap: uniform(2) },
  turbo: { name: 'turbo', rate: 0, toneMap: uniform(4) },
} satisfies Record<string, Profile>;

export function bitsPerSymbol(toneMap: ToneMap): number {
  let n = 0;
  for (const c of NON_PILOTS) n += toneMap[groupOf(c)];
  return n;
}
