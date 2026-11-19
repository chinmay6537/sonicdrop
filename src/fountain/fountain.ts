// Systematic random linear fountain code over GF(2).
//
// The file is cut into K blocks. Packets 0..K-1 are the blocks themselves;
// packets K, K+1, ... are XORs of random subsets of blocks. The receiver can
// rebuild the file from ANY K packets that are linearly independent, which in
// practice means K + 1 or 2 packets. Lost packets are never re-sent.
//
// Packet layout (13-byte header + blockSize payload):
//   0     magic 0xA7
//   1-2   fileId     (u16, random per transfer)
//   3-6   fileLen    (u32)
//   7-8   blockSize  (u16)
//   9-12  seq        (u32)
//   13..  payload

import { Prng, hashSeed } from '../dsp/prng.ts';

export const PACKET_MAGIC = 0xa7;
export const PACKET_HEADER = 13;

export interface PacketInfo {
  fileId: number;
  fileLen: number;
  blockSize: number;
  seq: number;
  payload: Uint8Array;
}

export function blockCount(fileLen: number, blockSize: number): number {
  return Math.max(1, Math.ceil(fileLen / blockSize));
}

/** Bitset of the blocks combined in packet `seq`. */
export function coefficients(fileId: number, seq: number, k: number): Uint32Array {
  const words = Math.ceil(k / 32);
  const v = new Uint32Array(words);
  if (seq < k) {
    v[seq >>> 5] = 1 << (seq & 31);
    return v;
  }
  const rng = new Prng(hashSeed(fileId, seq));
  let any = 0;
  for (let w = 0; w < words; w++) {
    let x = rng.nextU32();
    if (w === words - 1 && k % 32) x &= (1 << (k % 32)) - 1;
    v[w] = x >>> 0;
    any |= x;
  }
  if (!any) v[0] = 1;
  return v;
}

export function parsePacket(bytes: Uint8Array): PacketInfo | null {
  if (bytes.length < PACKET_HEADER || bytes[0] !== PACKET_MAGIC) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const blockSize = dv.getUint16(7);
  if (bytes.length !== PACKET_HEADER + blockSize) return null;
  return {
    fileId: dv.getUint16(1),
    fileLen: dv.getUint32(3),
    blockSize,
    seq: dv.getUint32(9),
    payload: bytes.subarray(PACKET_HEADER),
  };
}

export class FountainEncoder {
  readonly k: number;
  readonly data: Uint8Array;
  readonly blockSize: number;
  readonly fileId: number;
  private readonly blocks: Uint8Array[];

  constructor(data: Uint8Array, blockSize: number, fileId: number) {
    this.data = data;
    this.blockSize = blockSize;
    this.fileId = fileId;
    if (blockSize < 1 || blockSize > 65535) throw new Error('bad blockSize');
    this.k = blockCount(data.length, blockSize);
    this.blocks = [];
    for (let i = 0; i < this.k; i++) {
      const b = new Uint8Array(blockSize);
      b.set(data.subarray(i * blockSize, (i + 1) * blockSize));
      this.blocks.push(b);
    }
  }

  packet(seq: number): Uint8Array {
    const out = new Uint8Array(PACKET_HEADER + this.blockSize);
    const dv = new DataView(out.buffer);
    out[0] = PACKET_MAGIC;
    dv.setUint16(1, this.fileId);
    dv.setUint32(3, this.data.length);
    dv.setUint16(7, this.blockSize);
    dv.setUint32(9, seq);
    const payload = out.subarray(PACKET_HEADER);
    const v = coefficients(this.fileId, seq, this.k);
    for (let i = 0; i < this.k; i++) {
      if ((v[i >>> 5] >>> (i & 31)) & 1) {
        const b = this.blocks[i];
        for (let j = 0; j < this.blockSize; j++) payload[j] ^= b[j];
      }
    }
    return out;
  }
}

export class FountainDecoder {
  readonly k: number;
  private readonly rows: (Uint32Array | null)[];
  private readonly rowData: (Uint8Array | null)[];
  private readonly seen = new Set<number>();
  private rank = 0;
  private result: Uint8Array | null = null;
  /** Packets accepted (including ones that turned out redundant). */
  received = 0;
  readonly fileId: number;
  readonly fileLen: number;
  readonly blockSize: number;

  constructor(fileId: number, fileLen: number, blockSize: number) {
    this.fileId = fileId;
    this.fileLen = fileLen;
    this.blockSize = blockSize;
    this.k = blockCount(fileLen, blockSize);
    this.rows = new Array(this.k).fill(null);
    this.rowData = new Array(this.k).fill(null);
  }

  static fromPacket(p: PacketInfo): FountainDecoder {
    return new FountainDecoder(p.fileId, p.fileLen, p.blockSize);
  }

  matches(p: PacketInfo): boolean {
    return p.fileId === this.fileId && p.fileLen === this.fileLen && p.blockSize === this.blockSize;
  }

  get done(): boolean {
    return this.result !== null;
  }

  get progress(): number {
    return this.rank / this.k;
  }

  get decodedRank(): number {
    return this.rank;
  }

  /** Add a packet. Returns true once the file is complete. */
  add(p: PacketInfo): boolean {
    if (this.result) return true;
    if (!this.matches(p) || this.seen.has(p.seq)) return false;
    this.seen.add(p.seq);
    this.received++;
    const v = coefficients(this.fileId, p.seq, this.k);
    const d = new Uint8Array(p.payload);
    // Forward-eliminate against existing pivots, lowest column first.
    for (;;) {
      const col = lowestBit(v);
      if (col < 0) return false; // redundant packet
      const row = this.rows[col];
      if (!row) {
        this.rows[col] = v;
        this.rowData[col] = d;
        this.rank++;
        break;
      }
      xorInto(v, row);
      xorInto(d, this.rowData[col]!);
    }
    if (this.rank === this.k) this.finish();
    return this.result !== null;
  }

  /** The rebuilt file, or null if not complete. */
  get data(): Uint8Array | null {
    return this.result;
  }

  private finish() {
    const { k, rows, rowData, blockSize } = this;
    // Back-substitute from the last pivot so every row becomes a unit vector.
    for (let c = k - 1; c >= 0; c--) {
      const row = rows[c]!;
      const data = rowData[c]!;
      for (let w = 0; w < row.length; w++) {
        let bits = row[w];
        while (bits) {
          const b = 31 - Math.clz32(bits);
          bits &= ~(1 << b);
          const j = w * 32 + b;
          if (j > c) xorInto(data, rowData[j]!);
        }
      }
    }
    const out = new Uint8Array(this.fileLen);
    for (let i = 0; i < k; i++) {
      out.set(rowData[i]!.subarray(0, Math.min(blockSize, this.fileLen - i * blockSize)), i * blockSize);
    }
    this.result = out;
  }
}

function lowestBit(v: Uint32Array): number {
  for (let w = 0; w < v.length; w++) {
    const x = v[w];
    if (x) return w * 32 + (31 - Math.clz32(x & -x));
  }
  return -1;
}

function xorInto<T extends Uint32Array | Uint8Array>(a: T, b: T): void {
  for (let i = 0; i < a.length; i++) a[i] ^= b[i];
}
