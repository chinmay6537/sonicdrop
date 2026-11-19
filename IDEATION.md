# SonicDrop — Ideation

Send small files (mainly photos) between two devices using **only sound**:
no Wi-Fi, no Bluetooth, no cable. One device plays the data through its
speaker and the other listens with its microphone.

Status: **design only, no code yet.**

---

## 1. Decisions so far

| Question | Decision | Why |
|---|---|---|
| Platform | **Browser app (offline PWA)** | One codebase for phones and laptops. Load it once while online, then it works with no network. |
| Distance | **Close range, under 50 cm** | Phones side by side. Highest SNR, so the highest speed. |
| Sound band | **Audible, about 4–12 kHz** | Fastest and most reliable on all phone speakers and mics. It sounds like modem hiss. |
| Repo | Public, `sonicdrop` | |
| Photo size | **Slider, user picks** (about 256–800 px) | A live estimate of the send time is shown while dragging. |
| File types | **Photos, text and any small file** | Photos are compressed automatically. Other files are sent as they are (gzip if that helps). |
| Test devices | **iPhone (Safari) and Mac laptop** | iOS Safari is the hardest target, so it gets tested from the very first build. |

---

## 2. Realistic expectations

Air is a bad channel: speakers distort, rooms echo, and mics roll off at the
top end. Existing systems for reference:

| System | Speed | Notes |
|---|---|---|
| ggwave / Chirp | ~10–100 bytes/s | Very robust, much too slow for photos |
| libquiet (OFDM) | ~1–8 kbps | Close range, quiet room |
| Acoustic OFDM (research) | ~10–20 kbps | Short range, tuned hardware |

**Target: 4–8 kbps usable data at under 50 cm in a normal room.**

A raw 3 MB phone photo would still take about 40 minutes, so **the photo is
compressed before sending**. Resizing it to about 400 px on the long edge and
encoding it as AVIF/WebP gives roughly 10–25 KB, which takes **about 15–40
seconds**. The image step matters as much as the modem.

---

## 3. How it works

```
SENDER                                                   RECEIVER
photo
 → resize + AVIF/WebP (~10–25 KB)
 → split into packets (seq no. + CRC32)
 → fountain code (generate any number of packets)
 → error correction + interleaving
 → OFDM modulation, adaptive per tone
 → speaker  ~~~~~~~~~~~~~~~~ air ~~~~~~~~~~~~~~~~→  mic
                                                  → chirp sync (find the start)
                                                  → equalize using pilot tones
                                                  → error correction
                                                  → collect packets until enough arrive
                                                  → rebuild file → show photo
             ←~~~~~~~~ "DONE" chirp ~~~~~~~~~~~~~
```

### 3.1 Ignoring outside noise (the core problem)

1. **Quiet band.** Speech and mains or fan hum sit mostly below about 4 kHz, so
   data uses 4–12 kHz.
2. **Chirp preamble with matched filtering.** Each burst starts with a known
   frequency sweep. The receiver correlates incoming audio against the template.
   The resulting processing gain finds the burst even below the noise floor, and
   voices or claps don't correlate with it.
3. **Room sounding and tone masking.** The receiver measures noise on every
   subcarrier and tells the sender which tones to skip (a TV whine, a fan
   harmonic, and so on). DSL and modern modems do the same "bit-loading".
4. **Echo handling.** At close range, reverberation causes more trouble than
   noise. OFDM with a cyclic prefix and pilot tones equalizes it away.
5. **Burst noise.** A door slam or cough wipes out a run of data. Interleaving
   spreads each codeword over time, Reed-Solomon or LDPC repairs the damage, and
   a CRC32 on every packet rejects anything that's still corrupted.
6. **Mic processing off.** The browser's `echoCancellation`,
   `noiseSuppression` and `autoGainControl` are disabled. They are tuned for
   voice and would destroy the signal.

### 3.2 Speed

- **OFDM**: 32–128 subcarriers in the 4–12 kHz band, all carrying data at once.
- **Adaptive modulation per tone**: clean tones carry QPSK or 16-QAM (2–4 bits),
  weak tones carry BPSK (1 bit), and noisy tones are switched off.
- **No waiting for acknowledgements**: see the fountain code below.

### 3.3 Reliability: fountain code

The file is split into K source blocks. The sender then streams a continuous
flow of encoded packets (LT or RaptorQ-style). The receiver can rebuild the
file from **any** set of roughly K × 1.05 packets that arrive intact. Lost
packets are never re-sent; the receiver simply waits for more. This keeps the
link fast and lets it work even if a reply is never heard.

### 3.4 Handshake (about 2 s)

Both devices have a speaker and a mic, so short replies are possible:

1. **HELLO** from the sender (chirp, file size and type)
2. **PROBE**: the receiver listens to the room and replies with the tone mask
   and the modulation to use
3. **DATA**: the sender streams fountain-coded packets
4. **DONE**: the receiver chirps once it has rebuilt the file, and the sender
   stops

If no PROBE reply is heard, the sender falls back to **Robust mode** (BPSK
on every tone with heavy error correction): slower, but it works anywhere.

---

## 4. Tech plan (proposed)

- **Language:** TypeScript, built to a single offline PWA (service worker caches
  everything).
- **Audio:** Web Audio API. An `AudioWorklet` for low-latency capture and
  playback, with the DSP in plain TS (FFT, correlation, equalizer).
- **Image:** Canvas resize, then `toBlob('image/webp')`, or AVIF where the
  browser supports it.
- **Testing without devices:** a simulated channel in Node (noise, reverb
  impulse responses, clipping, clock drift between the two devices) so the
  modem can be measured in CI before anyone touches a phone.
- **Hosting:** GitHub Pages, so the app can be installed once while online and
  used offline after that.

---

## 5. Risks

| Risk | Mitigation |
|---|---|
| iOS Safari mic quirks and forced audio processing | Test early on iPhone, and expose the constraints in the UI |
| Speaker/mic clock mismatch (e.g. 48 000 vs 47 990 Hz) | Pilot-based drift tracking and periodic resync chirps |
| Clipping on loud phone speakers | Limit peak-to-average power, and add a volume calibration step |
| Different phones have very different frequency responses | Room sounding measures the actual channel on every transfer |

---

## 6. Build order

1. **Simulated channel and modem core** (Node, no audio hardware): OFDM, chirp
   sync, equalizer, error correction, fountain code. Done when it decodes
   reliably through simulated noise, reverb and clock drift.
2. **Loopback in the browser**: the Mac's speaker plays into its own mic.
   Measure the real throughput.
3. **iPhone ↔ Mac**: handshake, room sounding, adaptive bit-loading.
4. **App interface**: pick a photo, quality slider with a live time estimate,
   Send/Receive screens, progress display, offline PWA on GitHub Pages.
