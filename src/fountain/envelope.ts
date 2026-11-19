// Wraps a file with its name and MIME type before fountain coding.
//
// Layout: "SD" | version (1) | nameLen (1) | name (utf-8) | mimeLen (1) | mime | data

export interface FileEnvelope {
  name: string;
  mime: string;
  data: Uint8Array;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function packEnvelope(f: FileEnvelope): Uint8Array {
  const name = enc.encode(f.name).subarray(0, 255);
  const mime = enc.encode(f.mime).subarray(0, 255);
  const out = new Uint8Array(3 + 1 + name.length + 1 + mime.length + f.data.length);
  let o = 0;
  out[o++] = 0x53; // S
  out[o++] = 0x44; // D
  out[o++] = 1;
  out[o++] = name.length;
  out.set(name, o); o += name.length;
  out[o++] = mime.length;
  out.set(mime, o); o += mime.length;
  out.set(f.data, o);
  return out;
}

export function unpackEnvelope(bytes: Uint8Array): FileEnvelope | null {
  if (bytes.length < 5 || bytes[0] !== 0x53 || bytes[1] !== 0x44 || bytes[2] !== 1) return null;
  let o = 3;
  const nl = bytes[o++];
  const name = dec.decode(bytes.subarray(o, o + nl)); o += nl;
  const ml = bytes[o++];
  const mime = dec.decode(bytes.subarray(o, o + ml)); o += ml;
  return { name, mime, data: bytes.slice(o) };
}
