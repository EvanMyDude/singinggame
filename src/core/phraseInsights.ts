import { timingMatches, type LyricsDoc, type LyricTiming } from './lyrics';
import type { BeatMap } from './melody';
import type { NoteResult } from './scoring';
import type { Song } from './song';

/** Reporting support thresholds, independent of the scoring engine. */
export const MIN_LINE_TARGETS = 2;
export const MIN_LINE_TARGET_SECONDS = 0.5;

export interface TimedLyricLine {
  index: number;
  text: string;
  startBeat: number;
  endBeat: number;
}

/**
 * Saved line windows only; no inferred word timing or fabricated lyric text. An overlap
 * ends at the next saved start. Equal starts belong to the later line in document order.
 * Invalid/unset windows are omitted, and a mismatched document is wholly unavailable.
 */
export function buildTimedLyricLines(lyrics: LyricsDoc | null, timing: LyricTiming | null, map: Pick<BeatMap, 'beat'>): TimedLyricLine[] | null {
  if (!lyrics || !timing || !timingMatches(timing, lyrics) || timing.lineCount !== lyrics.lines.length) return null;
  const starts = timing.lines
    .map((line, index) => ({ ...line, index }))
    .filter((line) => Number.isFinite(line.start))
    .sort((a, b) => a.start - b.start || a.index - b.index);
  const windows: TimedLyricLine[] = [];
  starts.forEach((line, i) => {
    const text = lyrics.lines[line.index]!.text;
    const end = Math.min(line.end, starts[i + 1]?.start ?? Infinity);
    if (!text.trim() || !Number.isFinite(end) || end <= line.start) return;
    windows.push({ index: line.index, text, startBeat: map.beat(line.start), endBeat: map.beat(end) });
  });
  return windows.length ? windows : null;
}

export interface TimedLineInsight extends TimedLyricLine {
  /** Each target is assigned once by onset, including targets with no sung frames. */
  noteIndices: number[];
  targetCount: number;
  /** Union of assigned target time clipped to this saved line window. */
  targetSeconds: number;
  /** Beat-weighted target accuracy; null when there are no assigned results. */
  accuracy: number | null;
  /** Median signed cents over sung target results, or NaN. */
  bias: number;
  rankable: boolean;
}

export interface TimedPhraseInsights {
  lines: TimedLineInsight[];
  best: TimedLineInsight | null;
  hardest: TimedLineInsight | null;
}

/**
 * Describes scored targets within actual timed lyric lines, not the entire vocal phrase.
 * Targets outside saved windows remain globally scored but unassigned here. Zero-target
 * and sparse lines remain visible in `lines`, and never become misses or ranked claims.
 */
export function timedPhraseInsights(song: Song, results: readonly NoteResult[], windows: readonly TimedLyricLine[] | null): TimedPhraseInsights {
  if (!windows) return { lines: [], best: null, hardest: null };
  const byIndex = new Map(results.map((result) => [result.index, result]));
  const lines = windows.map((line): TimedLineInsight => {
    const notes = song.notes.filter((note) => note.start >= line.startBeat && note.start < line.endBeat);
    const assigned = notes.map((note) => byIndex.get(note.index)).filter((result): result is NoteResult => result !== undefined);
    const weight = assigned.reduce((sum, result) => sum + result.beats, 0);
    const biases = assigned.map((result) => result.biasCents).filter(Number.isFinite).sort((a, b) => a - b);
    // Notes are onset ordered. Merge overlapping target spans before measuring support.
    let covered = 0;
    let end = line.startBeat;
    for (const note of notes) {
      const to = Math.min(line.endBeat, note.start + note.beats);
      covered += Math.max(0, to - Math.max(end, note.start));
      end = Math.max(end, to);
    }
    const targetSeconds = (covered * 60) / song.bpm;
    return {
      ...line,
      noteIndices: notes.map((note) => note.index),
      targetCount: notes.length,
      targetSeconds,
      accuracy: weight > 0 ? assigned.reduce((sum, result) => sum + result.accuracy * result.beats, 0) / weight : null,
      bias: biases.length ? (biases[(biases.length - 1) >> 1]! + biases[biases.length >> 1]!) / 2 : NaN,
      rankable: notes.length >= MIN_LINE_TARGETS && targetSeconds + 1e-9 >= MIN_LINE_TARGET_SECONDS && assigned.length === notes.length,
    };
  });
  const supported = lines.filter((line) => line.rankable && line.accuracy !== null);
  if (supported.length < 2) return { lines, best: null, hardest: null };
  const ranked = [...supported].sort((a, b) => a.accuracy! - b.accuracy! || a.index - b.index);
  const low = ranked[0]!;
  const high = ranked[ranked.length - 1]!;
  return {
    lines,
    hardest: low.accuracy! < 0.85 ? low : null,
    best: high.accuracy! >= 0.85 && high !== low ? high : null,
  };
}
