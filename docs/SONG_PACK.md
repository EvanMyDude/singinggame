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

Passages where the extraction is not confident (spoken delivery, dense backing) are left
without target notes: the lyrics and the live pitch trace still show, but they are not scored.
The results screen states how many targets and seconds the grade rests on, per section too.

To see why a passage has no targets, read `analysis` in `melody.json` after `make extract`
(the same numbers are printed while it runs). `lostSeconds` splits the detected vocal that was
not scored by the gate that rejected it: `pyinUnvoiced` (no pitch found, typical of spoken
delivery), `trackersDisagree` (the two pitch trackers differ by 60 cents or more), `tooShort`
(agreed pitch that did not hold for 100 ms) and `unstable` (a note-length segment that wandered).
`gaps` gives the same breakdown for every stretch of 2 s or more without a target. Check these
before changing any threshold. The app ignores `analysis`.

## Lyric timing

Settings → **Sync lyrics**. The reference vocal plays; press Space at the start of each line.
Taps snap to the nearest detected vocal onset (within 0.3 s). When the extraction found exactly
one vocal phrase per lyric line, **Pre-fill from vocal phrases** fills everything at once; then
play through and nudge. **Save timing** stores the result in the browser immediately and
downloads `timing.json`; put that file in the song folder and commit it so every browser gets
it. The timing file carries a hash of the lyric text, so editing `lyrics.txt` means re-syncing.

Only line-level timing is produced. Word-level highlighting appears only if a `words` array is
present for a line in `timing.json`; the app never fakes word timing.
