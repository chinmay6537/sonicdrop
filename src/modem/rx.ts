// Streaming receiver: push microphone samples in, get packets and files out.
//
//   mic → band-pass (3.4–12.8 kHz) → chirp matched filter → frame demodulator
//       → CRC check → fountain decoder → file

import { makeBandpass } from '../dsp/biquad.ts';
import type { BiquadChain } from '../dsp/biquad.ts';
import { chirpCorrelation } from '../dsp/chirp.ts';
import { FountainDecoder, parsePacket } from '../fountain/fountain.ts';
import type { PacketInfo } from '../fountain/fountain.ts';
import { FrameDemodulator } from './frame.ts';
import type { FrameHeader, LinkReport } from './frame.ts';
import { BANDPASS_HIGH, BANDPASS_LOW, CHIRP_LEN, HEADER_END, SAMPLE_RATE } from './params.ts';

export type ReceiverEvent =
  | { type: 'frame'; at: number; ok: boolean; report: LinkReport; packet?: PacketInfo }
  | { type: 'progress'; received: number; needed: number }
  | { type: 'file'; at: number; data: Uint8Array; fileId: number };

export interface ReceiverStats {
  detections: number;
  badHeaders: number;
  framesOk: number;
  framesBad: number;
  /** Frames decoded using the previous header after their own header failed. */
  headersRecovered: number;
}

const SEARCH_BLOCK = 4096;
const LOOKAHEAD = 256;

export class Receiver {
  /** Normalised correlation needed to treat a spot as a chirp. */
  threshold = 0.3;
  readonly stats: ReceiverStats = { detections: 0, badHeaders: 0, framesOk: 0, framesBad: 0, headersRecovered: 0 };
  decoder: FountainDecoder | null = null;
  lastReport: LinkReport | null = null;
  private lastHeader: FrameHeader | null = null;

  private bp: BiquadChain = makeBandpass(BANDPASS_LOW, BANDPASS_HIGH, SAMPLE_RATE);
  private buf = new Float32Array(1 << 18);
  private len = 0;
  /** Absolute sample index of buf[0]. */
  private base = 0;
  /** Absolute index of the next correlation lag to examine. */
  private scan = 0;
  /** Chirp found; waiting for header samples. */
  private detected: number | null = null;
  /** Header decoded; waiting for the rest of the frame. */
  private pending: FrameDemodulator | null = null;
  private pendingStart = 0;

  /** Total samples pushed so far. */
  get position(): number {
    return this.base + this.len;
  }

  push(samples: Float32Array): ReceiverEvent[] {
    this.append(this.bp.process(samples));
    const events: ReceiverEvent[] = [];
    while (this.step(events));
    this.trim();
    return events;
  }

  private view(abs: number): Float32Array {
    return this.buf.subarray(abs - this.base, this.len);
  }

  /** One unit of work. Returns false when more samples are needed. */
  private step(events: ReceiverEvent[]): boolean {
    const end = this.position;

    if (this.pending) {
      const d = this.pending;
      if (end < this.pendingStart + d.length) return false;
      const payload = d.decodePayload(this.view(this.pendingStart));
      this.pending = null;
      if (payload && !d.headerGuessed) this.lastHeader = d.header;
      if (!payload && d.headerGuessed) {
        // Wrong guess (or a false chirp): count it as a bad header and keep looking.
        this.stats.badHeaders++;
        this.scan = this.pendingStart + CHIRP_LEN / 2;
        return true;
      }
      if (d.headerGuessed) this.stats.headersRecovered++;
      this.scan = this.pendingStart + d.length;
      this.handleFrame(this.pendingStart, d, payload, events);
      return true;
    }

    if (this.detected !== null) {
      const start = this.detected;
      if (end < start + HEADER_END) return false;
      this.detected = null;
      const d = new FrameDemodulator(this.view(start), 0, this.lastHeader);
      if (!d.header) {
        this.stats.badHeaders++;
        this.scan = start + CHIRP_LEN / 2;
        return true;
      }
      this.pending = d;
      this.pendingStart = start;
      return true;
    }

    // Search for the next chirp.
    if (end - this.scan < SEARCH_BLOCK + LOOKAHEAD + CHIRP_LEN) return false;
    const ncc = chirpCorrelation(this.view(this.scan), SEARCH_BLOCK + LOOKAHEAD);
    let hit = -1;
    for (let i = 0; i < SEARCH_BLOCK; i++) if (ncc[i] > this.threshold) { hit = i; break; }
    if (hit < 0) {
      this.scan += SEARCH_BLOCK;
      return true;
    }
    let peak = hit;
    for (let i = hit; i < Math.min(hit + 192, ncc.length); i++) if (ncc[i] > ncc[peak]) peak = i;
    // Earliest strong arrival = direct path (later peaks are echoes).
    let first = peak;
    for (let i = Math.max(hit, peak - 96); i <= peak; i++) {
      if (ncc[i] >= 0.6 * ncc[peak]) { first = i; break; }
    }
    this.stats.detections++;
    this.detected = this.scan + first;
    return true;
  }

  private handleFrame(at: number, d: FrameDemodulator, payload: Uint8Array | null, events: ReceiverEvent[]) {
    const report = d.report();
    this.lastReport = report;
    const packet = payload ? parsePacket(payload) ?? undefined : undefined;
    if (packet) this.stats.framesOk++;
    else this.stats.framesBad++;
    events.push({ type: 'frame', at, ok: !!packet, report, packet });
    if (!packet) return;
    if (!this.decoder || (!this.decoder.matches(packet) && this.decoder.done)) {
      this.decoder = FountainDecoder.fromPacket(packet);
    }
    if (!this.decoder.matches(packet) || this.decoder.done) return;
    const complete = this.decoder.add(packet);
    events.push({ type: 'progress', received: this.decoder.decodedRank, needed: this.decoder.k });
    if (complete) {
      events.push({ type: 'file', at: at + d.length, data: this.decoder.data!, fileId: this.decoder.fileId });
    }
  }

  private append(x: Float32Array) {
    if (this.len + x.length > this.buf.length) {
      const nb = new Float32Array(Math.max(this.buf.length * 2, this.len + x.length));
      nb.set(this.buf.subarray(0, this.len));
      this.buf = nb;
    }
    this.buf.set(x, this.len);
    this.len += x.length;
  }

  /** Drop samples nothing can need any more. */
  private trim() {
    let keep = this.scan;
    if (this.detected !== null) keep = Math.min(keep, this.detected);
    if (this.pending) keep = Math.min(keep, this.pendingStart);
    const drop = keep - this.base;
    if (drop > this.buf.length / 2) {
      this.buf.copyWithin(0, drop, this.len);
      this.len -= drop;
      this.base += drop;
    }
  }
}
