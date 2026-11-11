import { describe, expect, it } from 'vitest';
import melodyJson from '../public/songs/old-town-road/melody.json';
import timingJson from '../public/songs/old-town-road/timing.json';
import { emptyTiming, parseLyrics, parseTiming, type LyricTiming } from '../src/core/lyrics';
import { BeatMap, melodyToSong, parseMelody, type MelodyData } from '../src/core/melody';
import { buildTimedLyricLines, MIN_LINE_TARGET_SECONDS, MIN_LINE_TARGETS, timedPhraseInsights } from '../src/core/phraseInsights';
import type { NoteResult } from '../src/core/scoring';
import type { Song } from '../src/core/song';

function results(song: Song, accuracy: (index: number) => number = () => 1): NoteResult[] {
  return song.notes.map((note) => ({
    ...note,
    judgment: accuracy(note.index) > 0.85 ? 'perfect' : 'off',
    biasCents: 0, medianAbsCents: 0, coverage: 1, accuracy: accuracy(note.index),
    onset: 0, timing: 1, points: 0, hold: false, cleanEntry: false,
  }));
}

function fixture(notes: { t: number; d: number }[], ranges: { start: number; end: number }[]) {
  const melody: MelodyData = {
    version: 1, duration: 20, referenceOffset: 0, bpm: 120, firstBeat: 0.5,
    key: { tonic: 0, mode: 'major' }, tuningCents: 0, phrases: [],
    notes: notes.map((note) => ({ ...note, m: 60, c: 0 })),
  };
  const map = new BeatMap(melody);
  const song = melodyToSong(melody, 'fixture', 'Fixture', [{ name: 'All', start: 0, end: 20 }], map);
  const lyrics = parseLyrics(ranges.map((_, i) => `Synthetic line ${i + 1}`).join('\n'));
  const timing: LyricTiming = { version: 1, hash: lyrics.hash, lineCount: ranges.length, lines: ranges };
  const windows = buildTimedLyricLines(lyrics, timing, map)!;
  return { song, lyrics, timing, windows, map };
}

describe('timed lyric insights', () => {
  it('restores actual lines through the current recorded-song conversion and timing shape', () => {
    const melody = parseMelody(melodyJson);
    const map = new BeatMap(melody);
    const song = melodyToSong(melody, 'recording', 'Recording', [{ name: 'All', start: 0, end: melody.duration }], map);
    expect(song.notes.every((note) => note.lyric === '')).toBe(true);
    // Public timing only; substitute synthetic text, never the private lyric document.
    const lyrics = parseLyrics(timingJson.lines.map((_, i) => `Synthetic recorded line ${i + 1}`).join('\n'));
    const timing = { ...parseTiming(timingJson), hash: lyrics.hash };
    const windows = buildTimedLyricLines(lyrics, timing, map)!;
    const supported = timedPhraseInsights(song, results(song), windows).lines.filter((line) => line.rankable);
    expect(supported.length).toBeGreaterThan(2);
    const weakIndices = new Set(supported[0]!.noteIndices);
    const insight = timedPhraseInsights(song, results(song, (i) => weakIndices.has(i) ? 0.1 : 1), windows);
    expect(insight.hardest?.text).toBe(lyrics.lines[supported[0]!.index]!.text);
    expect(insight.best?.text).toMatch(/^Synthetic recorded line /);
    expect(insight.best?.index).not.toBe(insight.hardest?.index);
    expect(insight.lines.flatMap((line) => line.noteIndices).length).toBe(new Set(insight.lines.flatMap((line) => line.noteIndices)).size);
    expect(song.notes.every((note) => note.lyric === '')).toBe(true);
  });

  it('caps overlaps and owns a boundary onset once; outside targets remain unassigned', () => {
    const f = fixture([{ t: 0.5, d: 0.5 }, { t: 1, d: 0.5 }, { t: 2, d: 0.5 }, { t: 2.5, d: 0.5 }, { t: 5, d: 0.5 }], [{ start: 0, end: 3 }, { start: 2, end: 4 }]);
    const insight = timedPhraseInsights(f.song, results(f.song), f.windows);
    expect(insight.lines.map((line) => line.noteIndices)).toEqual([[0, 1], [2, 3]]);
    expect(insight.lines[0]!.endBeat).toBe(f.map.beat(2));
  });

  it('breaks equal-start ties in document order without double counting', () => {
    const f = fixture([{ t: 1, d: 0.5 }], [{ start: 1, end: 3 }, { start: 1, end: 2 }]);
    const insight = timedPhraseInsights(f.song, results(f.song), f.windows);
    expect(insight.lines).toHaveLength(1);
    expect(insight.lines[0]!.index).toBe(1);
    expect(insight.lines[0]!.noteIndices).toEqual([0]);
  });

  it('keeps zero-target lines unscored and sparse lines out of rankings', () => {
    const f = fixture([{ t: 0, d: 0.2 }, { t: 0.3, d: 0.2 }, { t: 2, d: 2 }], [{ start: 0, end: 1 }, { start: 2, end: 4 }, { start: 5, end: 6 }]);
    const insight = timedPhraseInsights(f.song, results(f.song), f.windows);
    expect(MIN_LINE_TARGETS).toBe(2);
    expect(MIN_LINE_TARGET_SECONDS).toBe(0.5);
    expect(insight.lines.map((line) => line.rankable)).toEqual([false, false, false]);
    expect(insight.lines[0]!.targetCount).toBe(2);
    expect(insight.lines[0]!.targetSeconds).toBeCloseTo(0.4, 9);
    expect(insight.lines[1]!.targetCount).toBe(1);
    expect(insight.lines[2]).toMatchObject({ targetCount: 0, targetSeconds: 0, accuracy: null });
    expect(insight.best).toBeNull();
    expect(insight.hardest).toBeNull();
  });

  it('requires two supported lines and complete result evidence', () => {
    const f = fixture([{ t: 0, d: 0.25 }, { t: 0.25, d: 0.25 }, { t: 2, d: 0.25 }, { t: 2.25, d: 0.25 }], [{ start: 0, end: 1 }, { start: 2, end: 3 }]);
    const all = timedPhraseInsights(f.song, results(f.song, (i) => i < 2 ? 0.1 : 1), f.windows);
    expect(all.lines.every((line) => line.rankable)).toBe(true);
    expect(all.hardest?.index).toBe(0);
    expect(all.best?.index).toBe(1);
    const partial = timedPhraseInsights(f.song, results(f.song).slice(0, 3), f.windows);
    expect(partial.lines[1]!.rankable).toBe(false);
    expect(partial.best).toBeNull();
    expect(partial.hardest).toBeNull();
  });

  it('merges overlapping support and clips it to saved windows', () => {
    const f = fixture([{ t: 0, d: 0.4 }, { t: 0.1, d: 0.4 }, { t: 2, d: 5 }, { t: 2.1, d: 5 }], [{ start: 0, end: 0.3 }, { start: 2, end: 2.4 }]);
    const insight = timedPhraseInsights(f.song, results(f.song), f.windows);
    expect(insight.lines[0]!.targetSeconds).toBeCloseTo(0.3, 9);
    expect(insight.lines[1]!.targetSeconds).toBeCloseTo(0.4, 9);
    expect(insight.lines.every((line) => !line.rankable)).toBe(true);
  });

  it('averages the two middle sung-target biases for even counts', () => {
    const f = fixture([{ t: 0, d: 0.5 }, { t: 0.5, d: 0.5 }], [{ start: 0, end: 2 }]);
    const rs = results(f.song).map((result, i) => ({ ...result, biasCents: i === 0 ? -60 : 60 }));
    expect(timedPhraseInsights(f.song, rs, f.windows).lines[0]!.bias).toBe(0);
    expect(timedPhraseInsights(f.song, rs.slice(0, 1), f.windows).lines[0]!.bias).toBe(-60);
  });

  it('omits claims for absent, mismatched, or unset lyric timing', () => {
    const f = fixture([{ t: 1, d: 1 }], [{ start: 0, end: 3 }]);
    expect(buildTimedLyricLines(null, f.timing, f.map)).toBeNull();
    expect(buildTimedLyricLines(f.lyrics, null, f.map)).toBeNull();
    expect(buildTimedLyricLines(f.lyrics, { ...f.timing, hash: 'different' }, f.map)).toBeNull();
    expect(buildTimedLyricLines(f.lyrics, { ...f.timing, lineCount: 2 }, f.map)).toBeNull();
    expect(buildTimedLyricLines(f.lyrics, emptyTiming(f.lyrics), f.map)).toBeNull();
    expect(timedPhraseInsights(f.song, results(f.song), null)).toEqual({ lines: [], best: null, hardest: null });
  });
});
