import { pitchClass } from './music';
import { songFromNotes, type Note, type Section, type Song } from './song';
import type { LyricTiming, LyricsDoc } from './lyrics';

/**
 * Target melody produced by `tools/extract_melody.py` from the instrumental and the
 * reference recording. Times are seconds on the instrumental's timeline.
 */
export interface MelodyNote {
  /** Start (s). */
  t: number;
  /** Duration (s). */
  d: number;
  /** MIDI note (integer, equal temperament). */
  m: number;
  /** Median deviation of the sung pitch from `m`, in semitones (informational). */
  c: number;
}

export interface MelodyPhrase {
  t: number;
  e: number;
}

export interface MelodyData {
  version: 1;
  duration: number;
  /** Reference (full mix) time = song time + referenceOffset. */
  referenceOffset: number;
  key: { tonic: number; mode: 'major' | 'minor' };
  bpm: number;
  /** Song time (s) of the first tracked beat (bar lines are drawn from here). */
  firstBeat: number;
  tuningCents: number;
  notes: MelodyNote[];
  phrases: MelodyPhrase[];
  /** Optional detected reference-vocal time, not phrase spans or user voicing. */
  analysis?: { presentSeconds: number };
}

export function parseMelody(json: unknown): MelodyData {
  if (!json || typeof json !== 'object') throw new Error('melody.json is not an object');
  const m = json as Partial<MelodyData>;
  if (m.version !== 1 || !Array.isArray(m.notes) || typeof m.duration !== 'number') throw new Error('melody.json has an unknown format');
  const notes: MelodyNote[] = m.notes
    .filter((n) => n && typeof n.t === 'number' && typeof n.d === 'number' && typeof n.m === 'number' && n.d > 0)
    .map((n) => ({ t: n.t, d: n.d, m: Math.round(n.m), c: typeof n.c === 'number' ? n.c : 0 }))
    .sort((a, b) => a.t - b.t);
  const phrases: MelodyPhrase[] = Array.isArray(m.phrases) ? m.phrases.filter((p) => p && typeof p.t === 'number' && typeof p.e === 'number') : [];
  const bpm = typeof m.bpm === 'number' && m.bpm > 20 ? m.bpm : 120;
  const targetSeconds = unionLength(notes.map((n) => [n.t, n.t + n.d]));
  const presentSeconds = validVocalSeconds(m.analysis?.presentSeconds, m.duration, targetSeconds);
  return {
    version: 1,
    duration: m.duration,
    referenceOffset: typeof m.referenceOffset === 'number' ? m.referenceOffset : 0,
    key: m.key && typeof m.key.tonic === 'number' ? { tonic: pitchClass(m.key.tonic), mode: m.key.mode === 'minor' ? 'minor' : 'major' } : { tonic: 0, mode: 'major' },
    bpm,
    firstBeat: typeof m.firstBeat === 'number' ? m.firstBeat : 0,
    tuningCents: typeof m.tuningCents === 'number' ? m.tuningCents : 0,
    notes,
    phrases,
    ...(presentSeconds !== null ? { analysis: { presentSeconds } } : {}),
  };
}

/**
 * Seconds <-> beats for the scoring engine and highway, which work in beats. Beat 0 is placed
 * one bar before the first tracked beat (never after song time 0), so bar lines fall on the
 * music and every song time maps to a non-negative beat.
 */
export class BeatMap {
  readonly secPerBeat: number;
  readonly origin: number;
  constructor(melody: Pick<MelodyData, 'bpm' | 'firstBeat'>, beatsPerBar = 4) {
    this.secPerBeat = 60 / melody.bpm;
    const bar = beatsPerBar * this.secPerBeat;
    this.origin = melody.firstBeat - bar * Math.ceil(melody.firstBeat / bar + 1e-9);
  }
  beat(seconds: number): number {
    return (seconds - this.origin) / this.secPerBeat;
  }
  seconds(beat: number): number {
    return this.origin + beat * this.secPerBeat;
  }
}

export interface SectionSpec {
  name: string;
  /** Song time range (s). */
  start: number;
  end: number;
}

/**
 * Practice/result sections. Lyric sections with timing are best; otherwise vocal phrases are
 * clustered where gaps exceed `gap` seconds; otherwise the whole song.
 */
export function buildSections(melody: MelodyData, lyrics: LyricsDoc | null, timing: LyricTiming | null, gap = 2.5): SectionSpec[] {
  if (lyrics && timing && timing.lines.length === lyrics.lines.length) {
    const out: SectionSpec[] = [];
    for (const s of lyrics.sections) {
      const starts = timing.lines.slice(s.from, s.to).map((l) => l.start).filter(Number.isFinite);
      const ends = timing.lines.slice(s.from, s.to).map((l) => l.end).filter(Number.isFinite);
      if (!starts.length) continue;
      out.push({ name: s.name, start: Math.max(0, Math.min(...starts) - 0.5), end: ends.length ? Math.max(...ends) : Math.max(...starts) + 4 });
    }
    if (out.length) return tidy(out, melody.duration);
  }
  if (melody.phrases.length) {
    const out: SectionSpec[] = [];
    let cur: SectionSpec | null = null;
    for (const p of melody.phrases) {
      if (cur && p.t - cur.end <= gap) cur.end = p.e;
      else {
        if (cur) out.push(cur);
        cur = { name: '', start: Math.max(0, p.t - 0.5), end: p.e };
      }
    }
    if (cur) out.push(cur);
    out.forEach((s, i) => (s.name = `Part ${i + 1} · ${fmtTime(s.start)}`));
    if (out.length) return tidy(out, melody.duration);
  }
  return [{ name: 'Whole song', start: 0, end: melody.duration }];
}

function tidy(secs: SectionSpec[], duration: number): SectionSpec[] {
  // Non-overlapping, in order, clamped to the song.
  const out = [...secs].sort((a, b) => a.start - b.start);
  for (let i = 0; i < out.length; i++) {
    const s = out[i]!;
    s.start = Math.max(0, Math.min(duration, s.start));
    s.end = Math.max(s.start + 0.5, Math.min(duration, s.end));
    if (i + 1 < out.length && out[i + 1]!.start < s.end) s.end = out[i + 1]!.start;
  }
  return out;
}

export function fmtTime(s: number): string {
  const t = Math.max(0, Math.floor(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

/** The melody as a `Song` for the scoring engine and highway (beats via `BeatMap`). */
export function melodyToSong(melody: MelodyData, id: string, title: string, sections: SectionSpec[], map: BeatMap): Song {
  const notes: Note[] = melody.notes.map((n, i) => ({
    index: i,
    midi: n.m,
    start: map.beat(n.t),
    beats: n.d / map.secPerBeat,
    lyric: '',
  }));
  const base = songFromNotes(
    { id, title, credit: '', bpm: melody.bpm, beatsPerBar: 4, tonicPc: melody.key.tonic, mode: melody.key.mode, difficulty: 2 },
    notes,
    undefined,
    map.beat(melody.duration),
  );
  const secs: Section[] = sections.map((s) => {
    const startBeat = map.beat(s.start);
    const endBeat = map.beat(s.end);
    let noteFrom = notes.findIndex((n) => n.start >= startBeat - 1e-9);
    if (noteFrom < 0) noteFrom = notes.length;
    let noteTo = notes.findIndex((n) => n.start >= endBeat - 1e-9);
    if (noteTo < 0) noteTo = notes.length;
    return { name: s.name, startBeat, endBeat, noteFrom, noteTo };
  });
  return { ...base, sections: secs };
}

export interface TargetCoverage {
  /** Number of target notes. */
  notes: number;
  /** Union of target intervals in seconds at the written tempo. */
  seconds: number;
}

/**
 * How much of the song is actually graded: the count and union duration of the target notes
 * in [from, to). Everything outside the targets is free singing, so the results screen shows
 * this next to the grade instead of implying the whole track was scored.
 */
export function targetCoverage(song: Pick<Song, 'notes' | 'bpm'>, from = 0, to = song.notes.length): TargetCoverage {
  const notes = song.notes.slice(Math.max(0, from), Math.max(0, to));
  return { notes: notes.length, seconds: unionLength(notes.map((n) => [n.start, n.start + n.beats])) * 60 / song.bpm };
}

/** Time coverage is independent of onset-based score attribution. */
export function sectionTargetCoverage(song: Pick<Song, 'notes' | 'bpm'>, section: Pick<Section, 'startBeat' | 'endBeat'>): TargetCoverage {
  const intervals = song.notes
    .map((n): [number, number] => [Math.max(n.start, section.startBeat), Math.min(n.start + n.beats, section.endBeat)])
    .filter(([start, end]) => end > start);
  return { notes: intervals.length, seconds: unionLength(intervals) * 60 / song.bpm };
}

function unionLength(intervals: [number, number][]): number {
  let total = 0;
  let end = -Infinity;
  for (const [a, b] of intervals.sort((x, y) => x[0] - y[0])) {
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) continue;
    total += Math.max(0, b - Math.max(a, end));
    end = Math.max(end, b);
  }
  return total;
}

/** Metadata is rounded to tenths of a second; allow that much rounding, never an arbitrary ratio. */
const VOCAL_METADATA_TOLERANCE_SECONDS = 0.1;
function validVocalSeconds(value: unknown, duration: number, targetSeconds: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 &&
    Number.isFinite(duration) && duration > 0 && Number.isFinite(targetSeconds) &&
    value <= duration + VOCAL_METADATA_TOLERANCE_SECONDS && value + VOCAL_METADATA_TOLERANCE_SECONDS >= targetSeconds
    ? value : null;
}

export function detectedVocalCoverage(song: Pick<Song, 'notes' | 'bpm'>, duration: number, presentSeconds?: number): { seconds: number; percent: number } | null {
  const targets = targetCoverage(song).seconds;
  const seconds = validVocalSeconds(presentSeconds, duration, targets);
  return seconds === null ? null : { seconds, percent: Math.min(100, targets / seconds * 100) };
}

/** Coverage precision is separate from recording clock formatting. Positive time never reads zero. */
export function fmtSpan(seconds: number): string {
  if (seconds <= 0) return '0 s';
  if (seconds < 0.1) return '<0.1 s';
  return `${seconds.toFixed(1)} s`;
}

/** Onset times (s) useful for snapping lyric taps: note starts and phrase starts. */
export function vocalOnsets(melody: MelodyData): number[] {
  const set = new Set<number>();
  for (const p of melody.phrases) set.add(Number(p.t.toFixed(3)));
  for (const n of melody.notes) set.add(Number(n.t.toFixed(3)));
  return [...set].sort((a, b) => a - b);
}
