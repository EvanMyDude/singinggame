# Pitch Hero

A personal karaoke practice app: pick a song and sing it over its instrumental with a live
pitch monitor, synced lyrics, a reference-vocal toggle, slow-down practice (75 % / 50 % with
pitch preserved), A–B looping, a 2-minute warm-up and pitch scoring against targets extracted
from the song's vocal. Songs are data, not code: each is a folder with a `song.json`, and a new
one is added with one preprocessing command (see [`docs/SONG_PACK.md`](docs/SONG_PACK.md)).

Everything runs locally in the browser. There is no backend and no account; microphone audio
never leaves the device.

## Run it

Requires Node 20+.

```sh
make install   # npm install
make dev       # http://localhost:5173
```

Other targets: `make test`, `make typecheck`, `make build` (static files in `dist/`),
`make preview`, `make song-tools` and `make prepare-song SONG=<id>` (build a song package from
its audio), `make test-tools`. Run `make help` for the list.

Song audio and lyric text are not in the repository (see [`docs/SONG_PACK.md`](docs/SONG_PACK.md)):
keep each song's MP3s and `lyrics.txt` in `public/songs/<id>/` for development, or drop them on
the **Song files** card on the deployed site once per song.

### Add a song

```sh
make song-tools                                    # once: Python packages in .venv
npm run prepare-song -- public/songs/<id> --title "Title" --artist "Artist"
make dev                                           # choose the song, sync lyrics, sing
```

The folder needs the instrumental and the isolated lead vocal (a full mix and `lyrics.txt` are
optional). The command writes the pitch targets and the song definition and registers the
song. Details, file naming and the lyric timing format: [`docs/SONG_PACK.md`](docs/SONG_PACK.md).

### GitHub Pages

`.github/workflows/pages.yml` runs the tests, builds the site and deploys `dist/` to Pages on
every push to `main` (or on demand from the Actions tab). One-time setup: **Settings → Pages →
Build and deployment → Source: GitHub Actions**. The site is then at `https://<owner>.github.io/<repo>/`.

The microphone only works on a secure origin: `http://localhost` during development, or any
`https://` host for the built files. Use Chrome, Edge, Firefox or Safari (current versions).
**Headphones give the best results**: with speakers the microphone also hears the track.

## What's in it

- **Song picker**: the home screen lists the registered songs; scores, resume position and
  picked files are kept per song.
- **Sing**: the instrumental plays; the note highway shows the target melody and your voice
  as a glowing trail (green on pitch, yellow close, orange off, red far off, with "Too sharp ↑" /
  "Too flat ↓" hints). Lyrics follow the song; score, accuracy and streak are live; a results
  breakdown follows the song.
- **Reference vocal**: a toggle (V) that swaps in the full recording (or, for a song without
  one, adds the isolated vocal) without losing the place.
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
  together, aligned by the offset measured for that song; the reference toggle changes their gains.
  Practice speeds use `playbackRate` with `preservesPitch`. Lyrics, the highway, the loop and
  scoring all follow the song clock, so they stay in sync at any speed.
- **Target melody**: made offline, once per song, and committed as `melody.json`.
  `tools/prepare_song.py` tracks the isolated lead vocal with pYIN and turns the contour into
  stable notes (vibrato, scoops, slides and octave errors are handled; what is not stable enough
  to sing to gets no target). Old Town Road, which has no isolated vocal, uses
  `tools/extract_melody.py`: it subtracts the instrumental from the full mix and keeps only
  notes two independent pitch trackers agree on.
- **Scoring**: each frame's error is measured in cents (octave-folded by default). Points
  accrue along a smooth accuracy curve and are capped per note; notes are Perfect ≤ 10 cents,
  Great ≤ 25, Good ≤ 50, else Off; Missed if less than 30 % was sung. Combos multiply points.
  Every frame is shifted back by the calibrated round-trip latency before comparison.

## Development

```
src/
  audio/        engine, mic capture, track player (two media elements), song clocks, pitch/
  core/         music math, song registry + definitions, song pack loading, melody data,
                lyrics + timing, scoring, storage
  ui/           app shell, screens (home, warm-up, sing/practice, results, sync, settings,
                monitor, mic check, latency), canvas renderers (note highway, pitch graph)
public/songs/   index.json (song list) and one folder per song: song.json, melody.json, timing.json
tools/          prepare_song.py + vocal_targets.py (song package from an isolated vocal),
                extract_melody.py (Old Town Road: targets from instrumental + full mix)
tests/          Vitest unit tests (detector accuracy, tracker latency, scoring with simulated
                singers, latency estimation, lyrics/timing, melody data, clocks, song registry)
                and Python tests for the tools (test_*.py)
```

`make test` runs the unit suite; `make test-tools` runs the Python tool tests.
