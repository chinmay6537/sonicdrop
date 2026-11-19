# SonicDrop

Send photos and small files between two devices using **only sound**: no
Wi-Fi, no Bluetooth, no cables. One device plays the data through its speaker
and the other listens through its microphone.

Status: **step 2 of 4 in progress.** The modem core works end to end in a
simulated room (step 1). A browser lab page runs it on real speakers and mics
(step 2). The full design is in [IDEATION.md](IDEATION.md).

## How it works

```
file → fountain code → CRC32 → convolutional code (K=7) → interleave → OFDM → speaker
                                                                              ↓ air
file ← fountain decode ← CRC check ← soft Viterbi ← equalise ← chirp sync ← band-pass ← mic
```

- **4–12 kHz OFDM**: 176 tones at once, above most speech energy and hum.
- **Chirp sync**: a matched filter finds each frame even below the noise.
  Speech and claps don't look like the chirp.
- **Interferer detection**: tones much louder than their neighbours (a fan
  whine, for example) are detected and stop steering the receiver.
- **Burst detection**: a sudden noise burst (a clap or knock) is detected per
  symbol from the pilot tones, and that symbol's bits are trusted less.
- **Decision-directed tracking**: the channel and noise estimates keep
  improving through the frame, handling room echo and interference that starts
  mid-frame.
- **Clock-drift tracking**: pilots follow a mismatch of over 120 ppm between
  the two devices' clocks.
- **Fountain code**: the receiver rebuilds the file from *any* K good packets,
  so lost frames are never re-sent.
- **Header recovery**: a frame whose header is lost to a loud syllable is
  decoded with the previous header from the same transfer.

## Profiles

| Profile | Modulation | Code rate | Bits/tone |
|---|---|---|---|
| robust | BPSK | 1/2 | 0.5 |
| standard | QPSK | 1/2 | 1 |
| fast | QPSK | 2/3 | 1.33 |
| turbo | 16-QAM | 1/2 | 2 |

## Results (simulated, 15 KB file, devices ~30 cm apart)

Times include all overhead: sync, training, headers, gaps and fountain overhead.

| Room | robust | standard | fast | turbo |
|---|---|---|---|---|
| Clean | 52.8 s | 26.4 s | 19.3 s | **13.2 s (9.1 kbps)** |
| Quiet room (echo, drift) | 52.8 s | 26.4 s | 19.3 s | **13.2 s** |
| Office chatter | 52.8 s | 26.4 s | **19.3 s** | 18.3 s |
| Loud café (talkers +10 dB, music) | **67.0 s** | ✗ | ✗ | ✗ |
| 7 kHz fan whine | 52.8 s | **26.4 s** | 33.5 s | ✗ |
| Claps and knocks | 52.8 s | 26.4 s | 21.3 s | **13.2 s** |
| Echoey hall (RT60 1.2 s) | 52.8 s | **44.7 s** | ✗ | ✗ |
| Weak signal | 52.8 s | **26.4 s** | 35.5 s | ✗ |
| Everything at once (incl. clipping, −120 ppm) | 52.8 s | **26.4 s** | ✗ | ✗ |

Robust decodes in every room. The best profile per room is in bold.
Choosing it automatically from the measured SNR is step 3.

## Run it

Requires Node ≥ 22.18, which runs TypeScript directly.

```bash
npm install
```

```bash
npm test
```

```bash
npm run bench -- --profile all
```

Open the lab page (http://localhost:5178) to test on real hardware:

```bash
npm run dev
```

Lab modes:
- **Loopback**: the device plays to its own mic.
- **Send** / **Receive**: two devices.
- **Simulated room**: no sound.

The page can save the raw mic recording as a WAV, which replays offline:

```bash
node bench/decode-wav.ts recording.wav
```

`node bench/make-wav.ts out.wav --profile standard --size 4000` writes a
transmission to a WAV you can play from any device.

Benchmark options: `--profile robust|standard|fast|turbo|all`, `--size <bytes>`,
`--seed <n>`, `--only <room name>`.

## Layout

```
src/dsp/       FFT, biquad band-pass, sync chirp + matched filter, PRNG
src/fec/       convolutional code + soft Viterbi, CRC, interleaver, whitening
src/fountain/  fountain code (systematic random linear over GF(2)), file envelope
src/modem/     parameters, constellations, frame (de)modulator, Transmitter, Receiver
src/sim/       simulated room: echo, speaker EQ, talkers, music, whine, claps, drift, clipping
src/io/        WAV read/write and resampling
web/           lab page (Vite): loopback / send / receive / simulated
bench/         benchmark across rooms and profiles; WAV make/decode tools
test/          unit and end-to-end tests
```
