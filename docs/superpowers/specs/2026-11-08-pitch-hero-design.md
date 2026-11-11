# Pitch Hero: personalized karaoke practice, design

Status: assessment delivered with the implementation (the request asked for assessment, then build).

Pitch Hero turns Pitchline (a generic MIDI/text-notation singing game) into a one-song karaoke
practice app: *Old Town Road* over a karaoke instrumental, with a reference-vocal toggle, synced
lyrics, slowed practice with A–B looping, a short warm-up, and pitch scoring against the melody
extracted from the reference recording.

## 1. What stays, what goes

Kept as-is (they work and nothing in the new product changes their contract):

- `src/audio/mic.ts`, `src/audio/pitch/*`, `src/audio/voice.ts`: mic capture in an AudioWorklet,
  MPM pitch detection, tracker gating/smoothing, shared runtime.
- `src/ui/render/pitchGraph.ts` + `screens/monitor.ts` (Vocal Pitch Monitor), `render/highway.ts`
  (the scrolling note highway with the live voice trail), `render/deviation.ts`, `render/colors.ts`.
- `src/core/scoring.ts` (ScoreEngine, insights), `screens/results.ts` (trimmed), `screens/setup.ts`
  (mic check), `screens/latency.ts` (calibration), `screens/settings.ts` (trimmed).
- `.github/workflows/pages.yml`, Vite config, Makefile, test setup.

Removed: the song library and text-notation songs (`core/library.ts`, `docs/SONG_SOURCES.md`), MIDI
import (`core/midi.ts`, `screens/importMidi.ts`), the synthesized backing band and sequencer
(`core/arrange.ts`, `audio/sequencer.ts`, most of `audio/synth.ts`), song selection (`screens/songs.ts`),
the pitch trainer, the vocal-range check and transposition (`core/range.ts`, `screens/range.ts`: the
audio is a fixed recording, so transposition is no longer possible), and the beat-based `play.ts`.

## 2. Song pack and deployment

The repository is public and GitHub Pages serves it publicly. Committing the two MP3s (5.2 MB and
5.1 MB) is technically fine for git (well under GitHub's limits; LFS would only add quota and a
Pages checkout step), but it would publish a copyrighted recording and, with the lyrics text, a
copyrighted lyric. So:

- `public/songs/old-town-road/` holds the pack. Media (`instrumental.mp3`, `reference.mp3`) and
  `lyrics.txt` are git-ignored. Derived data (`melody.json`, `timing.json`) is committed.
- During local development Vite serves the folder, so the app just fetches it.
- On the deployed site the files are missing (404), so the app shows a one-time **Load song files**
  card; the files are stored in IndexedDB for that browser and never asked for again.
- Flipping to "commit the media" later is a one-line `.gitignore` change; nothing else changes.

## 3. Lyric synchronization

No lyric or timing data existed in the project, and the lyric text is copyrighted: it is not scraped
or typed from memory. The user supplies `lyrics.txt` (one lyric line per line, optional `[Section]`
headers, blank lines ignored). Line-level timing is produced by an in-app **Sync lyrics** tool:
the reference vocal plays, the user taps once per line, and taps are snapped to the vocal phrase
onsets detected by the melody extraction (±0.3 s). When the number of detected phrases equals the
number of lines, the tool pre-fills every line from the phrases, so the usual job is checking
rather than tapping. Nudge buttons and "play from here" allow corrections. Timing is saved to
IndexedDB immediately and can be downloaded as `timing.json` to commit.

Display is line-level: current line prominent, next line visible, previous line receding, with a
progress underline inside the current line. Word-level highlighting is only rendered when a timing
file carries verified word times (`words` per line); none is faked.

## 4. Scoring target (melody)

`tools/extract_melody.py` derives the vocal pitch track from the two recordings:

1. Measures the constant offset between them (full mix leads by 45.8 ms; per-window check shows
   no speed drift).
2. Hybrid subtraction. The two masters are phase-coherent only below ~250 Hz (bass and kick),
   so a complex least-squares fit removes the coherent part and a robust magnitude subtraction
   removes the rest; harmonic/percussive separation drops leftover transients.
3. Two independent trackers (harmonic-summation salience with Viterbi, and pYIN) run on the
   residual; a frame becomes part of a target note only where both agree within 60 cents and the
   residual passes energy and harmonicity gates intended to estimate vocal presence.
4. Stable segments (≥ 100 ms, median absolute deviation ≤ 35 cents) become notes.

The [deployed melody](../../../public/songs/old-town-road/melody.json) contains 174 targets,
43.3 s of target duration and a 91.7 s detected reference-vocal presence estimate. These are
pack metadata, not a fresh validation of the lead vocal. Targets that fail a gate remain
unscored. The melody also carries the tempo, reference offset and the detected phrase list
used by the lyric sync tool.

The earlier assessment recorded a later 175-note diagnostic run, but its derived JSON, exact
command, dependency versions and output hash were not retained in the repository. Its
figures and missing run identity are preserved in the
[recorded-run evidence status](../../diagnostics/2026-11-10-recorded-run.md). They remain
unverified pending reproduction and must not be substituted for the deployed 174-note pack.
The earlier attribution of the note-count difference to library versions was a hypothesis;
without those versions and outputs its cause is unknown.

Rejection labels measure tracker behavior in the residual. `pyinUnvoiced` does not prove that
the lead voice lacks usable pitch. Approximate octave disagreement does not establish which
estimate, if either, follows the lead vocal or has the right pitch class. Near disagreement
can have several causes; a slide is only a hypothesis. No category proves that recovery is
possible or impossible. Octave disagreement is one bounded candidate pool for further
review, and any recovery needs independent audio evidence. Keep the extraction thresholds
and deployed targets unchanged while addressing reporting and feedback.

## 5. Two tracks in sync

`TrackPlayer` runs both tracks as `HTMLMediaElement`s routed through Web Audio, playing
simultaneously; the reference is seeked to `t + referenceOffset` and kept within 40 ms by nudging
whichever element is currently muted. **Reference Vocal** crossfades the gains, so toggling never
restarts or jumps. The song clock is the audible element's `currentTime`, smoothed for rendering
and sampled against `AudioContext.currentTime` for scoring (the existing latency compensation and
±100 ms boundary tolerance absorb the remaining jitter).

## 6. Practice speed

`playbackRate` 0.5 / 0.75 / 1 with `preservesPitch = true` (supported by current Chrome, Edge,
Firefox and Safari). Everything downstream uses the song clock, so lyrics, the highway, the A–B loop
and scoring stay aligned at any speed; the microphone path is untouched.

## 7. Screens and navigation

Home (song card, Sing, Practice, Warm Up, Settings; load-files card when needed) · Warm-up
(4 × 30 s, countdown, instruction, next-step preview, offered once per browser session) · Sing
(instrumental, live highway, lyrics, score, results at the end) · Practice (same, plus speed, A–B
loop, no score) · Results · Settings (mic, headphones, latency, music volume, octave forgiveness,
song files, lyric sync) · Pitch Monitor · Mic check · Latency calibration.

Persisted: settings, speed, reference-vocal preference, last position, attempt history; warm-up
offered flag in `sessionStorage`. Audio and microphone never start without a click.
