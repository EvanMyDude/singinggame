# Song packages

Every song is a folder, `public/songs/<id>/`, described by a `song.json`. Nothing about a song
lives in code: the app reads `public/songs/index.json` for the list of songs and each
folder's `song.json` for its files. Scoring, the note highway, practice speeds, looping and
lyric sync are the same for every song and read only that song's data.

## Add a song

1. **Make the folder.** `public/songs/<id>/`, where `<id>` is lowercase letters, digits and
   dashes (for example `love-yourself`). The folder name is the song id.
2. **Put the source files in it.** Keep whatever file names they have.

   | File | Needed | Used for |
   | --- | --- | --- |
   | Instrumental (MP3) | yes | the track you sing over; its timeline is the song's timeline |
   | Isolated lead vocal (MP3) | yes | the source of the pitch targets |
   | Full mix (MP3) | no | the *Reference vocal* toggle, and measuring how the other two line up |
   | `lyrics.txt` | no | lyric display; one lyric line per line, optional `[Section]` headers |
   | `timing.json` | no | lyric line times (see [Lyric timing](#lyric-timing)) |

3. **Install the tools once.** `make song-tools` creates `.venv` with numpy, scipy, librosa and
   soundfile.
4. **Run the preprocessing command.**

   ```sh
   npm run prepare-song -- public/songs/<id> --title "Song Title" --artist "Artist"
   ```

   or `make prepare-song SONG=<id> ARGS='--title "Song Title" --artist "Artist"'`. It writes
   `melody.json` (the pitch targets) and `song.json` (the definition), adds the song to
   `public/songs/index.json`, and reports whether `timing.json` is usable. It never renames
   your files and never rewrites `timing.json`.
5. **Read its report.** It prints the measured offsets, the note count and range, how many
   seconds of vocal became targets, and how many were left out and why. Add
   `--plot check.png` to see the pitch contour with the target notes drawn over it.
6. **Sync the lyrics** if there is no usable `timing.json` yet: `make dev`, choose the song,
   Settings → **Sync lyrics**, save, and put the downloaded `timing.json` in the folder.
7. **Launch and verify.** `make dev`, choose the song on the home screen, try Practice and Sing.
8. **Commit the derived data only**: `song.json`, `melody.json`, `timing.json` and
   `public/songs/index.json`. The audio and `lyrics.txt` are git-ignored (see
   [What is committed](#what-is-committed)).

Rerunning the command is safe: it regenerates `melody.json` and keeps the title, artist and
file names already in `song.json`.

### Recognizing the files

Audio files are recognized by name: "instrumental", "karaoke", "backing" or "no vocals" is
the instrumental; "vocals only", "acapella", "isolated" or "lead vocal" is the isolated vocal;
"full", "with vocals", "original" or "mix" is the full mix. The plain names
`instrumental.mp3`, `vocal.mp3` and `reference.mp3` also work. When a name says nothing, or two
files claim one role, name them: `--instrumental FILE --vocal FILE --mix FILE`.

### Options

| Option | Effect |
| --- | --- |
| `--title`, `--artist` | text shown in the app; the title defaults to the folder name |
| `--reference mix\|vocal\|none` | what *Reference vocal* plays; default is the full mix when there is one, else the isolated vocal |
| `--vocal-offset SECONDS` | vocal time = song time + offset; skips measuring |
| `--gate-db N` | how far below the vocal's loud level still counts as singing (default 35) |
| `--plot FILE.png` | picture of the contour and the targets (needs matplotlib) |
| `--vocal-wav FILE.wav` | also write the decoded vocal, for the scoring check below |
| `--check-only` | only check `lyrics.txt` and `timing.json`; write nothing |
| `--no-register` | do not add the song to `index.json` |

## The song definition

`public/songs/<id>/song.json`:

```json
{
  "version": 1,
  "id": "love-yourself",
  "title": "Love Yourself",
  "artist": "Artist",
  "files": {
    "instrumental": "Love Yourself Instrumental.mp3",
    "reference": "Love Yourself Full.mp3",
    "vocal": "Love Yourself (Vocals Only).mp3",
    "lyrics": "lyrics.txt",
    "timing": "timing.json",
    "melody": "melody.json"
  },
  "referenceKind": "mix",
  "targets": { "source": "isolated-vocal" }
}
```

- `files` are file names inside the song folder, never paths.
- `referenceKind` says what the *Reference vocal* toggle plays. `mix`: the full song replaces
  the instrumental while the toggle is on. `vocal`: the isolated vocal plays on top of the
  instrumental (for songs with no full mix). `none`: no reference track.
- `files.vocal` is read by the tools. The app plays it only when `referenceKind` is `vocal`.
- `targets.source` records how `melody.json` was made (`isolated-vocal`, or `mix-subtraction`
  for Old Town Road).

`public/songs/index.json` lists the songs the app offers, in the order of the picker:

```json
{ "version": 1, "songs": ["old-town-road", "love-yourself"] }
```

## What is committed

| File | In git? | Why |
| --- | --- | --- |
| audio (`*.mp3`, `*.m4a`, `*.wav`) | no | copyrighted recordings; the repository and the Pages site are public |
| `lyrics.txt` | no | copyrighted text |
| `song.json`, `melody.json`, `timing.json`, `index.json` | yes | small derived data; the browser never analyzes audio |

`.gitignore` already covers every song folder. Do not use Git LFS for the audio: LFS files in a
public repository are as public as ordinary ones.

- **Local development**: Vite serves the song folder, so the files you put there are found
  without any import step.
- **Deployed site**: the home screen shows a **Song files** card for the chosen song. Drop its
  MP3s and `lyrics.txt` on it once (or pick each one). They are stored in this browser's
  IndexedDB under the song's id, never uploaded, and not asked for again. Settings → Song files
  shows what is loaded and lets you replace or remove files.

## How the targets are made

`tools/prepare_song.py` (orchestration) and `tools/vocal_targets.py` (note logic):

1. All audio is decoded to mono at 22.05 kHz.
2. **Alignment.** The instrumental's timeline is the song timeline. With a full mix, the
   position of the instrumental and of the vocal inside the mix are both measured by
   cross-correlation and checked in 8-second windows, which places the vocal on the song
   timeline and gives the reference offset. Without a mix, the two stems are assumed to start
   together, which holds for stems from one separation; `melody.json` records the assumption
   (`analysis.alignment.vocal.method`) and `--vocal-offset` overrides it.
3. **Pitch.** pYIN tracks the isolated vocal. A frame counts as sung when pYIN calls it voiced
   and the vocal is within `--gate-db` of its loud level. That leaves out breaths, reverb tails
   and separation residue in instrumental passages.
4. **Notes.** The contour becomes notes that are stable enough to sing to:
   - voicing dropouts of a few frames inside a held note are bridged;
   - short runs one octave from their surroundings (a tracker error) are folded back, while a
     sustained octave leap is kept;
   - note changes are detected on a contour smoothed over about one vibrato cycle, so vibrato
     does not split a held note; the note's pitch is the median of what was sung;
   - a long scoop or fall is trimmed off the note; a glide that never settles produces no
     target;
   - notes shorter than 100 ms are dropped, and same-pitch notes less than 60 ms apart are
     joined.
5. **Report.** `analysis` in `melody.json` records present, pitched and scored seconds and the
   seconds left out by reason (`unpitched`, `transition`, `tooShort`, `unstable`). These are
   tracker measurements, not verified statements about the performance. Passages without
   targets still show the lyrics and your live pitch; they are not scored.
6. Key and tempo come from the instrumental (bar lines); phrases come from where the vocal is
   pitched.

pYIN was chosen because it is already this project's dependency, runs on the CPU, needs no
model download and gives the same output for the same input. It sits behind one function
(`track_vocal`), so a neural tracker can replace it if review of a real song shows octave
errors that the repair step does not catch.

### Check a song's targets against its own vocal

The strongest automated check feeds the isolated vocal through the app's own pitch tracker and
scoring engine: singing exactly like the reference must score well.

```sh
npm run prepare-song -- public/songs/<id> --vocal-wav /tmp/vocal.wav
VOCAL_WAV=/tmp/vocal.wav MELODY_JSON=public/songs/<id>/melody.json npm test -- referenceVocal
```

It prints accuracy and the notes judged off or missed, with their times, and fails below 75 %
accuracy.

### Tool tests

```sh
make test-tools
```

runs the note-logic tests (numpy only), the timing checks, the lyric-hash and file-name
parity tests shared with the TypeScript suite, and, when the audio packages are installed, the
whole command on a synthetic song with known notes and offsets. The synthetic song checks
alignment and note logic. It is not evidence about extraction quality on a recording.

## Lyric timing

`timing.json` holds one entry per lyric line, in seconds on the song (instrumental) timeline:

```json
{
  "version": 1,
  "hash": "58711fe5",
  "lineCount": 3,
  "lines": [
    { "start": 7.522, "end": 12.205 },
    { "start": 12.255, "end": 14.474 },
    { "start": 14.224, "end": 18.654, "words": [{ "start": 14.3, "end": 14.6 }] }
  ]
}
```

- `lines` has exactly one entry per lyric line of `lyrics.txt`, in order. Blank lines and
  `[Section]` headers are not lyric lines.
- `hash` ties the file to the lyric text (FNV-1a of the lyric lines). If `lyrics.txt` changes,
  the timing no longer loads and the lines need re-syncing. `prepare-song` prints the hash and
  line count your `lyrics.txt` needs.
- `start` may be `null` for a line that is not marked yet; that line is not shown in time.
- `words` is optional and must have one entry per whitespace-separated word of that line. The
  app highlights words only where `words` is present and never invents word timing.

**Making it now**: Settings → **Sync lyrics**. The reference vocal plays; press Space at the
start of each line. Taps snap to the nearest detected vocal onset (within 0.3 s). When the
targets have exactly one vocal phrase per lyric line, **Pre-fill from vocal phrases** fills
everything at once; then play through and nudge. **Save timing** stores the result in the
browser and downloads `timing.json`; put that file in the song folder and commit it.

**Checking an existing file**: `npm run prepare-song -- public/songs/<id> --check-only` names
every rule the file breaks (shape, lyric hash, line count, order, times beyond the song).

**Automating it later.** The intended path is a forced aligner run on the isolated vocal with
the known lyric text, written by a `tools/align_lyrics.py` that outputs this same file format
with a provenance field. Line times come from the first and last word of each line; `words`
is written only for lines whose every word clears the aligner's confidence threshold, so
line-level alignment is never presented as word-level. Candidates to evaluate are local and
free (`stable-ts` alignment, torchaudio's MMS forced aligner); which one holds up on sung
vocals has not been tested in this project. The Sync tool then becomes a review and nudge step.

## Old Town Road

Old Town Road has no isolated vocal. Its targets come from `tools/extract_melody.py`, which
derives a vocal residual from the instrumental and the full mix (`make extract`). Its files
use the plain names `instrumental.mp3`, `reference.mp3`, `lyrics.txt`.

`tools/extract_melody.py` aligns the two recordings, subtracts the instrumental from the full
mix (phase-aware in the low band, magnitude-based above it, then harmonic/percussive
separation), tracks the residual with two independent pitch trackers and keeps only the
notes both agree on. Pass `--plot melody.png` to see the result over the residual spectrogram
and `--residual-wav vocal.wav` to listen to the residual. The script also writes the offset
between the two files (the reference track leads by 45.8 ms) and the tempo.

Passages that do not pass the extraction gates are left without target notes: the lyrics
and live pitch trace still show, but no score is assigned there. Target absence alone does
not identify spoken delivery, silence, an instrumental passage, or unusable lead-vocal pitch.
The results screen states the target count and duration, including per-section coverage.

The extractor's `analysis` output records measured rejection categories, not verified vocal
causes. `lostSeconds` partitions detected reference-vocal frames outside retained notes into
`pyinUnvoiced` (pYIN did not accept a finite pitch in the residual), `trackersDisagree` (estimates
differ by at least 60 cents), `tooShort` (agreement outside note-length segments), and
`unstable` (a dropped segment). `disagreeSeconds` divides disagreement into `octave`
(approximately one or two octaves apart, strictly within 60 cents), `near` (0.6 to less than
1.5 semitones apart), and `other` (the remainder). Neither tracker is independently known to
follow the lead vocal: octave disagreement does not establish pitch class, and a slide is
only one possible explanation for near disagreement. Recovery from any category requires
additional evidence. `gaps` gives the breakdown for target-free stretches of at least 2 s.
The app can use `analysis.presentSeconds` for coverage; rejection categories do not affect
scoring. See [extraction evidence status](diagnostics/2026-11-10-recorded-run.md) for the
separate, unverified historical run and its missing evidence.

For a diagnostic rerun, keep the deployed melody untouched. Write the complete output and
logs to a separate local directory, for example:

```sh
mkdir -p work/extraction-review
python3 tools/extract_melody.py public/songs/old-town-road/instrumental.mp3 \
  public/songs/old-town-road/reference.mp3 --alpha 1.4 \
  -o work/extraction-review/melody.json \
  2> work/extraction-review/extractor.log
```

This is a proposed reproduction command, not the recovered command of the recorded run.
Do not use `make extract` for a diagnostic-only run: its output path replaces the deployed
pack. Retain the derived JSON beside the evidence report after review, without audio or
private lyrics. Record its source signature, full extractor commit and any local diff, exact
command/parameters, UTC run time, Python and dependency versions (`numpy`, `scipy`, `librosa`,
`soundfile`, plus `soxr`/`numba` and libsndfile where used), output note count and SHA-256.
Different output note counts must remain distinct from the deployed pack. A successful
synthetic diagnostic test is not validation against reference audio.

If an isolated vocal for Old Town Road becomes available, `prepare-song` can replace this
path. That changes `melody.json`, so the Old Town Road assertions in `tests/` (note count,
coverage, the scoring parity snapshots) have to be reviewed in the same change.
