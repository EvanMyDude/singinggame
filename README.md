# Pitchline

A browser singing game for practicing pitch accuracy. Pick a song, sing along, and watch your voice trace a line across a scrolling note highway: green when you are on pitch, yellow when close, orange when noticeably off, red when far off, with "Too sharp ↑" / "Too flat ↓" prompts as you sing.

Everything runs locally in the browser. There is no backend, no account, and microphone audio never leaves the device.

## Run it

Requires Node 20+.

```sh
make install   # npm install
make dev       # http://localhost:5173
```

Other targets: `make test`, `make typecheck`, `make build` (static files in `dist/`), `make preview`. Run `make help` for the list.

The microphone only works on a secure origin: `http://localhost` during development, or any `https://` host for the built files. Use Chrome, Edge, Firefox or Safari (current versions). **Headphones give the best results**: with speakers the microphone also hears the guide melody.

## What's in it

- **Sing the Song**: full songs with a synthesized backing band and guide melody, count-in, live scoring, combos and high scores.
- **Practice Section**: loop one section at 100 %, 75 % or 50 % speed; choose band + melody, melody only, or band only; press **H** (or the button) to hear the next target note. The first note of the section is cued during each count-in.
- **Pitch Trainer**: single notes or intervals (three difficulty sets, up/down/both). Hold each note inside the green band until it locks.
- **Vocal range check**: sing a comfortable low and high note; every song is then transposed to fit, and the song screen shows *Original key → Comfortable key for you* with manual −/+ override.
- **Latency calibration**: clap or say "ta" on 8 clicks; the measured round-trip delay is removed before scoring.
- **Results**: score, grade, pitch accuracy, timing accuracy, best streak, Perfect/Great/Good/Off/Missed counts, a note-by-note timeline per section with sharp/flat arrows, notes you nailed vs. struggled with, and an accuracy trend across attempts. Buttons: **Try Again**, **Replay Song** (watch your recorded run against the guide), **Practice Weak Section** (opens the weakest section at 75 %, looping).
- **MIDI import**: load a `.mid`/`.kar` file; the most melody-like track becomes a singable song (karaoke lyrics included when present). Stored only in this browser.

Keyboard during play: `Esc`/`Space` pause, `H` hear target note, `G`/`B` toggle melody/band in practice.

## How it works

Design notes: [`docs/superpowers/specs/2026-11-08-pitchline-design.md`](docs/superpowers/specs/2026-11-08-pitchline-design.md).

- **Pitch detection**: McLeod Pitch Method (normalized square difference function) computed via FFT autocorrelation, on a 2048-sample window every 512 samples (~94 estimates/s, ~0.4 ms each). An AudioWorklet only copies and timestamps mic samples; analysis runs on the main thread so it can never cause audio dropouts. Frames are voiced only when above the sensitivity gate with clarity ≥ 0.65, so silence and breaths are never scored. A 5-point median removes spikes and octave glitches; a One Euro filter smooths the display without lagging note changes.
- **Songs**: melodies are authored in a compact text format (`C4:1 D4 E4:2 | …`, lyrics one syllable per note, chord symbols) and parsed into beat-timed notes. All audio (guide melody, keys, bass, pad, light drums) is synthesized with Web Audio from the note data, so slowing down never changes pitch.
- **Scoring**: each frame's error is measured in cents (octave-folded by default). Points accrue continuously along a smooth accuracy curve (≈ 0.87 at 25 cents, 0.42 at 50 cents) and are capped per note at 100 points per beat, so scores are comparable across practice speeds. Notes are judged Perfect ≤ 15 cents, Great ≤ 30, Good ≤ 50, else Off; Missed if less than 30 % was sung. Combos multiply points (×1.5 at 4, ×2 at 8, ×3 at 16). Holding a long note in tune and landing a new note within 120 ms earn bonuses. A ±100 ms boundary tolerance keeps early/late transitions from counting as wrong pitch.
- **Latency**: every frame is shifted back by the round-trip latency (calibrated, or the browser's own estimate) before it is compared with the song; the scroll position follows `getOutputTimestamp()` so the playhead matches what you hear.

## Built-in songs and public-domain status

| Song | Melody | Lyrics used |
| --- | --- | --- |
| Twinkle, Twinkle, Little Star | "Ah! vous dirai-je, maman", French, published 1761 | Jane Taylor, "The Star", 1806 |

Details and sources: [`docs/SONG_SOURCES.md`](docs/SONG_SOURCES.md). No recordings or modern arrangements are used; accompaniment is generated from chord symbols in the browser.

## Development

```
src/
  audio/        engine, synth voices, lookahead sequencer, mic capture, onset detector
  audio/pitch/  FFT, MPM detector, tracker (gating + smoothing)
  core/         music math, song format, library, range fitting, arrangement, scoring, storage, MIDI
  ui/           app shell, screens, canvas renderers (note highway, tuner)
tests/          Vitest unit tests (detector accuracy, tracker latency, scoring with simulated singers,
                latency estimation, song format, transposition, arrangement, MIDI parsing)
```

`make test` runs the unit suite. The detector tests sweep sines, harmonic "voices", missing-fundamental tones, noise and silence; the scoring tests replay simulated singers (in tune, flat, octave-down, late, uncompensated latency, untrained) through the engine.

## Limitations

- Audio-file import (extracting a melody from a recording) is not included; it is not reliable enough yet to be worth the complexity. MIDI import covers user-supplied songs.
- MIDI import flattens tempo changes and uses a metronome pulse instead of chords.
- Browser echo cancellation in speaker mode helps but is not perfect; headphones are strongly recommended.
