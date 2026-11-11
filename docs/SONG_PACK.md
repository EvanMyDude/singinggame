# Song pack

Pitch Hero is built around one song. Its files live in `public/songs/old-town-road/`.

## Files

- **instrumental.mp3**: the karaoke track you sing over (git-ignored).
- **reference.mp3**: the same backing with the vocal, used by the *Reference vocal* toggle and
  by the melody extraction (git-ignored).
- **lyrics.txt**: plain text, one lyric line per line in the order they are sung (repeat lines
  that repeat), optional `[Section]` headers, blank lines ignored (git-ignored: lyrics are
  copyrighted text and the site is public).
- **melody.json**: the target vocal pitch track, extracted offline (committed).
- **timing.json**: line start/end times for the lyrics, made in the app (committed).

The media and the lyric text are git-ignored on purpose: the repository and the GitHub Pages
site are public, and committing them would publish copyrighted material. Derived data is
committed so the deployed app only needs the two MP3s and the lyrics text, which it asks for
once per browser and keeps in IndexedDB.

## Local development

Copy the MP3s and `lyrics.txt` into the folder with the names above. Vite serves the folder,
so `make dev` finds them without any import step.

## Deployed site

Open the site; the home screen shows a **Song files** card. Drop the two MP3s and
`lyrics.txt` on it (they are sorted by name) or pick each one. They are stored in the browser,
never uploaded, and not asked for again. Settings → Song files shows what is loaded and lets you
replace or remove files.

## Melody extraction

```
pip install numpy scipy librosa soundfile      # once
make extract                                   # rebuilds melody.json from the two MP3s
```

`tools/extract_melody.py` aligns the two recordings, subtracts the instrumental from the full
mix (phase-aware in the low band, magnitude-based above it, then harmonic/percussive
separation), tracks the residual with two independent pitch trackers and keeps only the
notes both agree on. Pass `--plot melody.png` to see the result over the residual spectrogram
and `--residual-wav vocal.wav` to listen to the isolated vocal. The script also writes the
offset between the two files (the reference track leads by 45.8 ms) and the tempo.

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

Run the audio-independent diagnostic tests with:

```sh
python3 -m unittest discover -s tests -p 'test_gate_report.py' -v
```

## Lyric timing

Settings → **Sync lyrics**. The reference vocal plays; press Space at the start of each line.
Taps snap to the nearest detected vocal onset (within 0.3 s). When the extraction found exactly
one vocal phrase per lyric line, **Pre-fill from vocal phrases** fills everything at once; then
play through and nudge. **Save timing** stores the result in the browser immediately and
downloads `timing.json`; put that file in the song folder and commit it so every browser gets
it. The timing file carries a hash of the lyric text, so editing `lyrics.txt` means re-syncing.

Only line-level timing is produced. Word-level highlighting appears only if a `words` array is
present for a line in `timing.json`; the app never fakes word timing.
