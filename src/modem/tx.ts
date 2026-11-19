// Transmitter: file bytes → endless stream of fountain-coded frames.

import { FountainEncoder } from '../fountain/fountain.ts';
import { PACKET_HEADER } from '../fountain/fountain.ts';
import { buildFrame, payloadForSymbols } from './frame.ts';
import { PROFILES } from './params.ts';
import type { Profile } from './params.ts';

export interface TransmitterOptions {
  profile?: Profile;
  /** Data symbols per frame; larger = less overhead, more to lose per bad frame. */
  symbolsPerFrame?: number;
  fileId?: number;
}

export class Transmitter {
  readonly profile: Profile;
  readonly encoder: FountainEncoder;
  private seq = 0;

  constructor(data: Uint8Array, opts: TransmitterOptions = {}) {
    this.profile = opts.profile ?? PROFILES.standard;
    const payload = payloadForSymbols(this.profile, opts.symbolsPerFrame ?? 32);
    const blockSize = payload - PACKET_HEADER;
    if (blockSize < 16) throw new Error('profile too slow for this frame size');
    const fileId = opts.fileId ?? Math.floor(Math.random() * 65536);
    this.encoder = new FountainEncoder(data, blockSize, fileId);
  }

  /** Source blocks (minimum frames needed). */
  get blocks(): number {
    return this.encoder.k;
  }

  get framesSent(): number {
    return this.seq;
  }

  /** Audio for the next frame, trailing silence included. */
  nextFrame(): Float32Array {
    return buildFrame(this.encoder.packet(this.seq++), this.profile);
  }
}
