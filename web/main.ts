// SonicDrop Lab: drives the modem on real speakers and mics (or the simulator).

import { packEnvelope, unpackEnvelope } from '../src/fountain/envelope.ts';
import { encodeWav } from '../src/io/wav.ts';
import { NUM_GROUPS, PROFILES, SAMPLE_RATE } from '../src/modem/params.ts';
import type { LinkReport } from '../src/modem/frame.ts';
import { Receiver } from '../src/modem/rx.ts';
import type { ReceiverEvent } from '../src/modem/rx.ts';
import { Transmitter } from '../src/modem/tx.ts';
import { Prng } from '../src/dsp/prng.ts';
import { SCENARIOS, simulate } from '../src/sim/channel.ts';

type Mode = 'loopback' | 'send' | 'receive' | 'sim';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const modeSel = $<HTMLSelectElement>('mode');
const profileSel = $<HTMLSelectElement>('profile');
const sizeSel = $<HTMLSelectElement>('size');
const fileInput = $<HTMLInputElement>('file');
const scenarioSel = $<HTMLSelectElement>('scenario');
const volume = $<HTMLInputElement>('volume');
const startBtn = $<HTMLButtonElement>('start');
const stopBtn = $<HTMLButtonElement>('stop');
const saveWavBtn = $<HTMLButtonElement>('saveWav');
const logEl = $('log');

SCENARIOS.forEach((s, i) => scenarioSel.add(new Option(s.name, String(i))));
const bandEls: HTMLDivElement[] = [];
for (let g = 0; g < NUM_GROUPS; g++) {
  const d = document.createElement('div');
  $('bands').appendChild(d);
  bandEls.push(d);
}

function log(msg: string) {
  const t = new Date().toLocaleTimeString();
  logEl.textContent = `${t}  ${msg}\n${logEl.textContent}`.slice(0, 8000);
}

function updateVisibility() {
  const mode = modeSel.value as Mode;
  $('scenarioRow').hidden = mode !== 'sim';
  $('volumeRow').hidden = mode === 'receive' || mode === 'sim';
  $('sizeRow').hidden = mode === 'receive';
  $('fileRow').hidden = mode === 'receive';
  $('hint').textContent = {
    loopback: "Turn the Mac's volume up, and keep the room fairly quiet for the first test.",
    send: 'Put this device 10–30 cm from the receiver, speaker facing its mic. Start the receiver first.',
    receive: 'Point this mic at the sender, 10–30 cm away. Press Start, then start the sender.',
    sim: 'Runs the transmitter through the simulated room, all inside this page. No sound is played.',
  }[mode];
}
modeSel.onchange = updateVisibility;
volume.oninput = () => {
  $('volumeVal').textContent = `${volume.value}%`;
  if (gain) gain.gain.value = Number(volume.value) / 100;
};
updateVisibility();

// ------------------------------------------------------------------ session state

let ctx: AudioContext | null = null;
let gain: GainNode | null = null;
let mic: MediaStream | null = null;
let capture: AudioWorkletNode | null = null;
let rx: Receiver | null = null;
let tx: Transmitter | null = null;
let sent: Uint8Array | null = null;
let recording: Float32Array[] = [];
let recorded = 0;
let pump: number | null = null;
let nextPlayTime = 0;
let startedAt = 0;
let firstFrameAt = -1;
let running = false;
const MAX_RECORD = SAMPLE_RATE * 180;

const WORKLET = `
class Capture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) { this.port.postMessage(this.buf, [this.buf.buffer]); this.buf = new Float32Array(2048); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('sd-capture', Capture);
`;

async function payload(): Promise<{ bytes: Uint8Array; label: string }> {
  const f = fileInput.files?.[0];
  if (f) {
    const data = new Uint8Array(await f.arrayBuffer());
    return { bytes: packEnvelope({ name: f.name, mime: f.type || 'application/octet-stream', data }), label: `${f.name} (${f.size} bytes)` };
  }
  const size = Number(sizeSel.value);
  const r = new Prng(Date.now() & 0xffff);
  const data = Uint8Array.from({ length: size }, () => r.nextU32() & 0xff);
  return { bytes: packEnvelope({ name: `test-${size}.bin`, mime: 'application/octet-stream', data }), label: `${size} bytes of random test data` };
}

function resetUi() {
  for (const id of ['sDet', 'sOk', 'sBad', 'sHdr']) $(id).textContent = '0';
  for (const id of ['sSnr', 'sDrift', 'sBlocks', 'sSpeed']) $(id).textContent = '–';
  $('progress').style.width = '0';
  $('resultCard').hidden = true;
  $<HTMLImageElement>('preview').hidden = true;
  $('download').hidden = true;
  bandEls.forEach((b) => { b.style.height = '2%'; b.className = ''; });
}

async function start() {
  if (running) return;
  running = true;
  startBtn.disabled = true;
  stopBtn.disabled = false;
  saveWavBtn.disabled = true;
  resetUi();
  recording = [];
  recorded = 0;
  firstFrameAt = -1;
  const mode = modeSel.value as Mode;
  const profile = PROFILES[profileSel.value as keyof typeof PROFILES];

  try {
    rx = new Receiver();
    if (mode !== 'receive') {
      const p = await payload();
      sent = p.bytes;
      tx = new Transmitter(sent, { profile });
      $('sBlocks').textContent = `0/${tx.blocks}`;
      log(`sending ${p.label} with ${profile.name}: ${tx.blocks} frames needed`);
    } else {
      sent = null;
      tx = null;
    }

    if (mode === 'sim') return runSimulation();

    ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    if (ctx.state === 'suspended') await ctx.resume();
    log(`audio context at ${ctx.sampleRate} Hz`);
    if (ctx.sampleRate !== SAMPLE_RATE) throw new Error(`browser gave ${ctx.sampleRate} Hz audio; the modem needs ${SAMPLE_RATE} Hz`);

    if (mode !== 'send') await startMic(ctx);
    if (mode !== 'receive') {
      gain = ctx.createGain();
      gain.gain.value = Number(volume.value) / 100;
      gain.connect(ctx.destination);
      nextPlayTime = ctx.currentTime + 0.3;
      schedulePlayback();
    }
    startedAt = performance.now();
    pump = window.setInterval(tick, 100);
    setStatus(mode === 'send' ? 'Sending…' : mode === 'receive' ? 'Listening…' : 'Sending to myself…');
  } catch (e) {
    log(`error: ${(e as Error).message}`);
    setStatus(`Error: ${(e as Error).message}`);
    await stop();
  }
}

async function startMic(c: AudioContext) {
  mic = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
      sampleRate: SAMPLE_RATE,
    },
  });
  const track = mic.getAudioTracks()[0];
  const st = track.getSettings();
  log(`mic: ${track.label || 'default'}; echoCancellation=${st.echoCancellation} noiseSuppression=${st.noiseSuppression} autoGainControl=${st.autoGainControl} rate=${st.sampleRate ?? '?'}`);
  if (st.echoCancellation || st.noiseSuppression) log('warning: the browser kept voice processing on; it may cancel the signal');
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
  await c.audioWorklet.addModule(url);
  capture = new AudioWorkletNode(c, 'sd-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
  capture.port.onmessage = (e: MessageEvent<Float32Array>) => onMic(e.data);
  const silent = c.createGain();
  silent.gain.value = 0;
  c.createMediaStreamSource(mic).connect(capture).connect(silent).connect(c.destination);
}

/** Keep about two seconds of frames queued on the speaker. */
function schedulePlayback() {
  if (!ctx || !tx || !gain) return;
  while (nextPlayTime < ctx.currentTime + 2) {
    const frame = tx.nextFrame();
    const buf = ctx.createBuffer(1, frame.length, SAMPLE_RATE);
    buf.copyToChannel(frame as Float32Array<ArrayBuffer>, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(gain);
    src.start(Math.max(nextPlayTime, ctx.currentTime + 0.05));
    nextPlayTime = Math.max(nextPlayTime, ctx.currentTime + 0.05) + buf.duration;
  }
}

function tick() {
  schedulePlayback();
  const s = (performance.now() - startedAt) / 1000;
  $('clock').textContent = `${s.toFixed(1)} s`;
  if (tx && modeSel.value === 'send') $('sBlocks').textContent = `sent ${tx.framesSent} (${tx.blocks} needed)`;
}

function onMic(chunk: Float32Array) {
  if (!rx) return;
  if (recorded < MAX_RECORD) { recording.push(chunk); recorded += chunk.length; }
  let sq = 0;
  for (let i = 0; i < chunk.length; i++) sq += chunk[i] * chunk[i];
  const db = 10 * Math.log10(sq / chunk.length + 1e-12);
  $('level').style.width = `${Math.max(0, Math.min(100, ((db + 70) / 70) * 100))}%`;
  handle(rx.push(chunk));
}

function handle(events: ReceiverEvent[]) {
  if (!rx) return;
  for (const e of events) {
    if (e.type === 'frame') {
      if (firstFrameAt < 0) firstFrameAt = e.at;
      showReport(e.report);
      if (!e.ok) log(`frame at ${(e.at / SAMPLE_RATE).toFixed(2)} s failed CRC (SNR ${e.report.snrDb} dB)`);
    } else if (e.type === 'progress') {
      $('progress').style.width = `${(100 * e.received) / e.needed}%`;
      $('sBlocks').textContent = `${e.received}/${e.needed}`;
    } else if (e.type === 'file') {
      const secs = (e.at - firstFrameAt) / SAMPLE_RATE;
      $('sSpeed').textContent = `${((e.data.length * 8) / secs / 1000).toFixed(2)} kbps`;
      showFile(e.data, secs);
      if (modeSel.value !== 'receive') void stop();
    }
  }
  const st = rx.stats;
  $('sDet').textContent = String(st.detections);
  $('sOk').textContent = String(st.framesOk);
  $('sBad').textContent = String(st.framesBad);
  $('sHdr').textContent = String(st.badHeaders);
}

function showReport(r: LinkReport) {
  $('sSnr').textContent = `${r.snrDb} dB`;
  $('sDrift').textContent = `${r.driftPpm} ppm`;
  r.groupSnrDb.forEach((v, g) => {
    bandEls[g].style.height = `${Math.max(2, Math.min(100, (v / 25) * 100))}%`;
    bandEls[g].className = v >= 12 ? 'good' : v >= 6 ? 'ok' : 'poor';
    bandEls[g].title = `${(4.03 + g * 0.516).toFixed(1)}–${(4.03 + (g + 1) * 0.516).toFixed(1)} kHz: ${v} dB`;
  });
}

function showFile(bytes: Uint8Array, secs: number) {
  const env = unpackEnvelope(bytes);
  $('resultCard').hidden = false;
  const result = $('result');
  const match = sent ? sent.length === bytes.length && sent.every((v, i) => v === bytes[i]) : null;
  const name = env?.name ?? 'file.bin';
  const size = env?.data.length ?? bytes.length;
  result.textContent = `${name}: ${size} bytes in ${secs.toFixed(1)} s` + (match === null ? '' : match ? '. Identical to what was sent ✓' : '. DIFFERENT from what was sent ✗');
  result.className = match === false ? 'bad' : 'ok';
  log(result.textContent);
  setStatus(match === false ? 'Received, but corrupted' : 'Received ✓');
  if (env) {
    const blob = new Blob([env.data as Uint8Array<ArrayBuffer>], { type: env.mime });
    const url = URL.createObjectURL(blob);
    const a = $<HTMLAnchorElement>('download');
    a.href = url;
    a.download = env.name;
    a.hidden = false;
    if (env.mime.startsWith('image/')) {
      const img = $<HTMLImageElement>('preview');
      img.src = url;
      img.hidden = false;
    }
  }
}

function runSimulation() {
  const sc = SCENARIOS[Number(scenarioSel.value)];
  setStatus(`Simulating “${sc.name}”…`);
  const frames = Array.from({ length: Math.ceil(tx!.blocks * 1.6) + 6 }, () => tx!.nextFrame());
  const stream = new Float32Array(frames.reduce((s, f) => s + f.length, 0));
  let o = 0;
  for (const f of frames) { stream.set(f, o); o += f.length; }
  const micSig = simulate(stream, sc, { seed: Date.now() & 0xffff });
  log(`simulated ${(micSig.length / SAMPLE_RATE).toFixed(1)} s of audio through “${sc.name}”`);
  startedAt = performance.now();
  let pos = 0;
  // Feed at 10× real time so progress is visible.
  pump = window.setInterval(() => {
    const n = Math.floor((SAMPLE_RATE / 10) * 10);
    for (let k = 0; k < n && pos < micSig.length && running; k += 2048) {
      onMic(micSig.slice(pos, pos + 2048));
      pos += 2048;
    }
    $('clock').textContent = `${(pos / SAMPLE_RATE).toFixed(1)} s of audio`;
    if (pos >= micSig.length && running) {
      if ($('resultCard').hidden) setStatus('Simulation ended: file not received');
      void stop();
    }
  }, 100);
}

function setStatus(s: string) {
  $('status').textContent = s;
}

async function stop() {
  if (!running) return;
  running = false;
  if (pump !== null) clearInterval(pump);
  pump = null;
  mic?.getTracks().forEach((t) => t.stop());
  mic = null;
  capture?.disconnect();
  capture = null;
  if (ctx) await ctx.close().catch(() => {});
  ctx = null;
  gain = null;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  saveWavBtn.disabled = recorded === 0;
  if ($('status').textContent?.endsWith('…')) setStatus('Stopped');
  if (rx) log(`stats: ${JSON.stringify(rx.stats)}`);
}

function saveWav() {
  const all = new Float32Array(recorded);
  let o = 0;
  for (const c of recording) { all.set(c.subarray(0, Math.min(c.length, recorded - o)), o); o += c.length; if (o >= recorded) break; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([encodeWav(all, SAMPLE_RATE) as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }));
  a.download = `sonicdrop-mic-${new Date().toISOString().replace(/[:.]/g, '-')}.wav`;
  a.click();
}

startBtn.onclick = () => void start();
stopBtn.onclick = () => void stop();
saveWavBtn.onclick = saveWav;
