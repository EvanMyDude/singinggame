# Pitch Hero

A personal karaoke practice app for one song: sing *Old Town Road* over the karaoke
instrumental with a live pitch monitor, synced lyrics, a reference-vocal toggle, slow-down
practice (75 % / 50 % with pitch preserved), A–B looping, a 2-minute warm-up and pitch scoring
against the melody extracted from the reference recording.

Everything runs locally in the browser. There is no backend and no account; microphone audio
never leaves the device.

## Run it

Requires Node 20+.

```sh
make install   # npm install
make dev       # http://localhost:5173
```

Other targets: `make test`, `make typecheck`, `make build` (static files in `dist/`),
`make preview`, `make extract` (rebuild the melody from the MP3s). Run `make help` for the list.

The song's audio and lyric text are not in the repository (see [`docs/SONG_PACK.md`](docs/SONG_PACK.md)):
copy the two MP3s and `lyrics.txt` into `public/songs/old-town-road/` for development, or drop
them on the **Song files** card on the deployed site once.

### GitHub Pages

`.github/workflows/pages.yml` runs the tests, builds the site and deploys `dist/` to Pages on
every push to `main` (or on demand from the Actions tab). One-time setup: **Settings → Pages →
Build and deployment → Source: GitHub Actions**. The site is then at `https://<owner>.github.io/<repo>/`.

The microphone only works on a secure origin: `http://localhost` during development, or any
`https://` host for the built files. Use Chrome, Edge, Firefox or Safari (current versions).
**Headphones give the best results**: with speakers the microphone also hears the track.

## What's in it

- **Sing**: the instrumental plays; the note highway shows the target melody and your voice
  as a glowing trail (green on pitch, yellow close, orange off, red far off, with "Too sharp ↑" /
  "Too flat ↓" hints). Lyrics follow the song; score, accuracy and streak are live; a results
  breakdown follows the song.
- **Reference vocal**: a toggle (V) that swaps in the full recording without losing the place.
- **Practice**: the same screen at 50 % / 75 % / 100 % speed with pitch preserved, an A–B loop
  (set A, set B, loop on/off, clear; the region shows on the progress bar), seeking, and no
  score.
- **Warm-up**: four 30-second steps (loosen up, lip trills, hum and glide, easy sirens) with a
  countdown, offered once per browser session before the first Sing/Practice.
- **Results**: grade, score, pitch and timing accuracy, best streak, nailed/struggled pitches,
  best and hardest phrase, sharp/flat timeline, note-by-note dots per part, accuracy trend;
  **Practice Weakest Part** opens Practice with that part looped.
- **Pitch Monitor**: a free-running real-time pitch graph with note, Hz and cents readout.
- **Settings**: microphone, sensitivity, headphones, mic monitoring, music volume, latency
  calibration, octave forgiveness, note names, song files, lyric sync.

Keyboard while singing: `Space` play/pause, `R` restart, `V` reference vocal, `Esc` home.
Practice adds `A` / `B` loop points, `L` loop on/off, `1`/`2`/`3` speed, `←`/`→` seek 5 s.

## How it works

Design notes: [`docs/superpowers/specs/2026-11-08-pitch-hero-design.md`](docs/superpowers/specs/2026-11-08-pitch-hero-design.md).

- **Pitch detection**: McLeod Pitch Method (normalized square difference function) computed via
  FFT autocorrelation on a 2048-sample window every 512 samples (~94 estimates/s). An
  AudioWorklet only copies and timestamps mic samples; analysis runs on the main thread so it
  can never cause audio dropouts. Frames are voiced only when above the sensitivity gate with
  clarity ≥ 0.65. A 5-point median removes spikes; a One Euro filter smooths the display.
- **Playback**: both tracks are `HTMLMediaElement`s routed through Web Audio and played
  together, aligned by the measured 45.8 ms offset; the reference toggle crossfades them.
  Practice speeds use `playbackRate` with `preservesPitch`. Lyrics, the highway, the loop and
  scoring all follow the song clock, so they stay in sync at any speed.
- **Target melody**: `tools/extract_melody.py` subtracts the instrumental from the full mix and
  tracks the vocal with two independent pitch trackers; only notes both agree on are scored.
- **Scoring**: each frame's error is measured in cents (octave-folded by default). Points
  accrue along a smooth accuracy curve and are capped per note; notes are Perfect ≤ 10 cents,
  Great ≤ 25, Good ≤ 50, else Off; Missed if less than 30 % was sung. Combos multiply points.
  Every frame is shifted back by the calibrated round-trip latency before comparison.

## Development

```
src/
  audio/        engine, mic capture, track player (two media elements), song clocks, pitch/
  core/         music math, melody data, lyrics + timing, song pack loading, scoring, storage
  ui/           app shell, screens (home, warm-up, sing/practice, results, sync, settings,
                monitor, mic check, latency), canvas renderers (note highway, pitch graph)
tools/          extract_melody.py (offline melody extraction)
tests/          Vitest unit tests (detector accuracy, tracker latency, scoring with simulated
                singers, latency estimation, lyrics/timing, melody data, clocks)
```

`make test` runs the unit suite.
