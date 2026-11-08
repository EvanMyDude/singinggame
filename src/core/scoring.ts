import { centsError } from './music';
import type { Note, Song } from './song';

/**
 * Scoring model (see docs/superpowers/specs/2026-11-08-pitchline-design.md section 4).
 *
 * Input: voice frames stamped in AudioContext time. Each frame is shifted back by the
 * calibrated round-trip latency, mapped to a beat, matched to the target note (with a
 * boundary tolerance so slightly early/late transitions are not punished as wrong pitch),
 * and accumulated per note. Notes finalize once compensated time passes their end plus the
 * tolerance, producing a judgment, combo update and bonuses.
 */

export type Judgment = 'perfect' | 'great' | 'good' | 'off' | 'miss';
export type Zone = 'perfect' | 'great' | 'good' | 'off';

export const THRESHOLDS = { perfect: 15, great: 30, good: 50 } as const;
export const NOTE_POINTS_PER_BEAT = 100;
const MULTIPLIER_TIERS: [number, number][] = [
  [16, 3],
  [8, 2],
  [4, 1.5],
  [0, 1],
];

/** Continuous per-frame accuracy: ~0.87 at 25 cents, ~0.42 at 50, ~0.02 at 100. */
export function frameAccuracy(absCents: number): number {
  const x = Math.max(0, absCents - 8) / 45;
  return Math.exp(-x * x);
}

export function zoneFor(absCents: number): Zone {
  if (absCents <= THRESHOLDS.perfect) return 'perfect';
  if (absCents <= THRESHOLDS.great) return 'great';
  if (absCents <= THRESHOLDS.good) return 'good';
  return 'off';
}

export function multiplierFor(streak: number): number {
  for (const [min, mult] of MULTIPLIER_TIERS) if (streak >= min) return mult;
  return 1;
}

export function gradeFor(accuracyPct: number): string {
  if (accuracyPct >= 93) return 'S';
  if (accuracyPct >= 85) return 'A';
  if (accuracyPct >= 75) return 'B';
  if (accuracyPct >= 60) return 'C';
  if (accuracyPct >= 45) return 'D';
  return 'F';
}

export interface ScoreFrame {
  time: number;
  voiced: boolean;
  midi: number;
}

export interface FrameJudge {
  /** Song beat after latency compensation. */
  beat: number;
  /** Note index the frame was matched to, or -1. */
  note: number;
  /** Signed cents vs the matched note (octave-folded if enabled). NaN if unmatched/unvoiced. */
  cents: number;
  zone: Zone | null;
  /** Points added by this frame (after multiplier). */
  points: number;
}

export interface NoteResult {
  index: number;
  midi: number;
  lyric: string;
  start: number;
  beats: number;
  judgment: Judgment;
  /** Median signed cents over voiced frames (NaN if never sung). Positive = sharp. */
  biasCents: number;
  /** Median absolute cents (NaN if never sung). */
  medianAbsCents: number;
  /** Fraction of the note's duration that was voiced (0..1). */
  coverage: number;
  /** Pitch accuracy contribution 0..1 (accuracy curve x coverage). */
  accuracy: number;
  /** Seconds from note start until first within 50 cents; null if never reached. */
  onset: number | null;
  /** 0..1, null if the note was not sung. */
  timing: number | null;
  points: number;
  hold: boolean;
  cleanEntry: boolean;
}

export interface Counts {
  perfect: number;
  great: number;
  good: number;
  off: number;
  miss: number;
}

export interface ScoreOptions {
  /** AudioContext time at which `startBeat` is heard-scheduled. */
  t0: number;
  secPerBeat: number;
  /** Round-trip latency (s) subtracted from frame stamps. */
  latency: number;
  /** Seconds between analysis frames (tracker hop). */
  frameInterval: number;
  foldOctaves: boolean;
  /** Beat that `t0` corresponds to (section start in practice). */
  startBeat?: number;
  /** Note window [from, to) to score; defaults to the whole song. */
  noteFrom?: number;
  noteTo?: number;
  /** Boundary tolerance in seconds. */
  tolerance?: number;
}

interface Acc {
  voiced: number;
  sumA: number;
  base: number;
  points: number;
  within30: number;
  errs: number[];
  firstHit: number | null;
  done: boolean;
}

export class ScoreEngine {
  readonly song: Song;
  readonly notes: readonly Note[];
  private readonly o: Required<ScoreOptions>;
  private readonly acc: Acc[];
  private readonly expected: number[];
  private finalizedUpTo: number;
  readonly results: NoteResult[] = [];
  score = 0;
  streak = 0;
  bestStreak = 0;
  counts: Counts = { perfect: 0, great: 0, good: 0, off: 0, miss: 0 };

  constructor(song: Song, opts: ScoreOptions) {
    this.song = song;
    this.o = {
      startBeat: 0,
      noteFrom: 0,
      noteTo: song.notes.length,
      tolerance: 0.1,
      ...opts,
    };
    this.notes = song.notes;
    this.acc = song.notes.map(() => ({ voiced: 0, sumA: 0, base: 0, points: 0, within30: 0, errs: [], firstHit: null, done: false }));
    this.expected = song.notes.map((n) => Math.max(1, (n.beats * this.o.secPerBeat) / this.o.frameInterval));
    this.finalizedUpTo = this.o.noteFrom;
  }

  get multiplier(): number {
    return multiplierFor(this.streak);
  }

  /** Re-anchor timing after a pause: `startBeat` now sounds at AudioContext time `t0`. */
  rebase(t0: number, startBeat: number): void {
    this.o.t0 = t0;
    this.o.startBeat = startBeat;
  }

  get noteFrom(): number {
    return this.o.noteFrom;
  }

  get noteTo(): number {
    return this.o.noteTo;
  }

  /** Song beat for an AudioContext time, after latency compensation. */
  beatAt(ctxTime: number): number {
    return this.o.startBeat + (ctxTime - this.o.latency - this.o.t0) / this.o.secPerBeat;
  }

  private err(midi: number, n: Note): number {
    return centsError(midi, n.midi, this.o.foldOctaves);
  }

  /** Note index whose span contains `beat` within the scored window, or -1. */
  private containing(beat: number): number {
    const notes = this.notes;
    let lo = this.o.noteFrom;
    let hi = this.o.noteTo - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const n = notes[mid]!;
      if (beat < n.start) hi = mid - 1;
      else if (beat >= n.start + n.beats) lo = mid + 1;
      else return mid;
    }
    return -1;
  }

  /** Index of the last note starting at or before `beat` (window-bounded), or noteFrom-1. */
  private lastStartingBefore(beat: number): number {
    let lo = this.o.noteFrom;
    let hi = this.o.noteTo - 1;
    let ans = this.o.noteFrom - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.notes[mid]!.start <= beat) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  /** Match a voiced pitch at `beat` to a note, with boundary tolerance. */
  match(beat: number, midi: number): number {
    const tolB = this.o.tolerance / this.o.secPerBeat;
    const p = this.containing(beat);
    const candidates: number[] = [];
    if (p >= 0) candidates.push(p);
    const before = p >= 0 ? p - 1 : this.lastStartingBefore(beat);
    const after = p >= 0 ? p + 1 : before + 1;
    if (before >= this.o.noteFrom) {
      const n = this.notes[before]!;
      if (n.start + n.beats > beat - tolB) candidates.push(before);
    }
    if (after < this.o.noteTo) {
      const n = this.notes[after]!;
      if (n.start < beat + tolB) candidates.push(after);
    }
    if (!candidates.length) return -1;
    if (p >= 0 && Math.abs(this.err(midi, this.notes[p]!)) <= THRESHOLDS.good) return p;
    let best = -1;
    let bestErr = Infinity;
    for (const i of candidates) {
      const e = Math.abs(this.err(midi, this.notes[i]!));
      if (e < bestErr) {
        bestErr = e;
        best = i;
      }
    }
    if (best !== p && bestErr > THRESHOLDS.good) return p;
    return best;
  }

  /** Accumulate one tracker frame. Unvoiced frames are never scored. */
  ingest(frame: ScoreFrame): FrameJudge {
    const beat = this.beatAt(frame.time);
    if (!frame.voiced || !Number.isFinite(frame.midi)) return { beat, note: -1, cents: NaN, zone: null, points: 0 };
    const idx = this.match(beat, frame.midi);
    if (idx < 0) return { beat, note: -1, cents: NaN, zone: null, points: 0 };
    const a = this.acc[idx]!;
    const n = this.notes[idx]!;
    const cents = this.err(frame.midi, n);
    const abs = Math.abs(cents);
    if (a.done) return { beat, note: idx, cents, zone: zoneFor(abs), points: 0 };
    const fa = frameAccuracy(abs);
    a.voiced++;
    a.sumA += fa;
    a.errs.push(cents);
    if (abs <= THRESHOLDS.great) a.within30++;
    if (a.firstHit === null && abs <= THRESHOLDS.good) a.firstHit = beat;
    const value = NOTE_POINTS_PER_BEAT * n.beats;
    const inc = Math.min((value * fa) / (0.8 * this.expected[idx]!), value - a.base);
    let pts = 0;
    if (inc > 0) {
      a.base += inc;
      pts = inc * this.multiplier;
      a.points += pts;
      this.score += pts;
    }
    return { beat, note: idx, cents, zone: zoneFor(abs), points: pts };
  }

  /** Finalize every note whose end (+ tolerance) is before compensated `ctxTime`. */
  advance(ctxTime: number): NoteResult[] {
    const beat = this.beatAt(ctxTime);
    const tolB = this.o.tolerance / this.o.secPerBeat;
    const out: NoteResult[] = [];
    while (this.finalizedUpTo < this.o.noteTo) {
      const n = this.notes[this.finalizedUpTo]!;
      if (n.start + n.beats + tolB > beat) break;
      out.push(this.finalize(this.finalizedUpTo));
      this.finalizedUpTo++;
    }
    return out;
  }

  /** Finalize everything left (song ended or stopped). */
  finishAll(): NoteResult[] {
    const out: NoteResult[] = [];
    while (this.finalizedUpTo < this.o.noteTo) {
      out.push(this.finalize(this.finalizedUpTo));
      this.finalizedUpTo++;
    }
    return out;
  }

  get done(): boolean {
    return this.finalizedUpTo >= this.o.noteTo;
  }

  private finalize(i: number): NoteResult {
    const n = this.notes[i]!;
    const a = this.acc[i]!;
    a.done = true;
    const expected = this.expected[i]!;
    const coverage = Math.min(1, a.voiced / expected);
    const accuracy = Math.min(1, a.sumA / (0.8 * expected));
    let judgment: Judgment;
    let bias = NaN;
    let medAbs = NaN;
    if (a.voiced === 0 || coverage < 0.3) {
      judgment = 'miss';
      if (a.voiced) {
        bias = medianOf(a.errs);
        medAbs = medianOf(a.errs.map(Math.abs));
      }
    } else {
      bias = medianOf(a.errs);
      medAbs = medianOf(a.errs.map(Math.abs));
      judgment = medAbs <= THRESHOLDS.perfect ? 'perfect' : medAbs <= THRESHOLDS.great ? 'great' : medAbs <= THRESHOLDS.good ? 'good' : 'off';
      if (coverage < 0.55) judgment = judgment === 'perfect' ? 'great' : judgment === 'great' ? 'good' : judgment;
    }
    const sung = judgment !== 'miss';
    const onset = a.firstHit === null ? null : (a.firstHit - n.start) * this.o.secPerBeat;
    const timing = sung ? (onset === null ? 0 : timingScore(onset)) : null;

    const value = NOTE_POINTS_PER_BEAT * n.beats;
    const mult = this.multiplier;
    let points = a.points;
    const hold = sung && n.beats >= 1.5 && a.within30 / expected >= 0.7;
    if (hold) points += 0.5 * value * mult;
    const cleanEntry = sung && onset !== null && onset <= 0.12 && judgment !== 'off';
    if (cleanEntry) points += 0.2 * value * mult;
    this.score += points - a.points;

    if (judgment === 'perfect' || judgment === 'great' || judgment === 'good') {
      this.streak++;
      if (this.streak > this.bestStreak) this.bestStreak = this.streak;
    } else {
      this.streak = 0;
    }
    this.counts[judgment]++;

    const r: NoteResult = {
      index: i,
      midi: n.midi,
      lyric: n.lyric,
      start: n.start,
      beats: n.beats,
      judgment,
      biasCents: bias,
      medianAbsCents: medAbs,
      coverage,
      accuracy: sung ? accuracy : 0,
      onset,
      timing,
      points,
      hold,
      cleanEntry,
    };
    this.results.push(r);
    return r;
  }

  /** Beat-weighted pitch accuracy over finalized notes, 0..100. */
  get accuracyPct(): number {
    return accuracyPct(this.results);
  }

  get timingPct(): number {
    return timingPct(this.results);
  }
}

export function accuracyPct(results: readonly NoteResult[]): number {
  let w = 0;
  let s = 0;
  for (const r of results) {
    w += r.beats;
    s += r.beats * r.accuracy;
  }
  return w ? (100 * s) / w : 0;
}

export function timingPct(results: readonly NoteResult[]): number {
  const sung = results.filter((r) => r.timing !== null);
  if (!sung.length) return 0;
  return (100 * sung.reduce((s, r) => s + r.timing!, 0)) / sung.length;
}

/** 1 within 100 ms of the note start, falling linearly to 0 at 400 ms. */
export function timingScore(onsetSec: number): number {
  const d = Math.abs(onsetSec);
  if (d <= 0.1) return 1;
  return Math.max(0, 1 - (d - 0.1) / 0.3);
}

function medianOf(v: readonly number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export interface PitchInsight {
  midi: number;
  accuracy: number;
  bias: number;
  count: number;
  lyrics: string[];
}

/** Aggregate results per pitch: which notes were nailed and which went sharp/flat. */
export function pitchInsights(results: readonly NoteResult[]): { nailed: PitchInsight[]; struggled: PitchInsight[] } {
  const by = new Map<number, { acc: number; w: number; biases: number[]; count: number; lyrics: Set<string> }>();
  for (const r of results) {
    const e = by.get(r.midi) ?? { acc: 0, w: 0, biases: [], count: 0, lyrics: new Set<string>() };
    e.acc += r.accuracy * r.beats;
    e.w += r.beats;
    if (Number.isFinite(r.biasCents)) e.biases.push(r.biasCents);
    e.count++;
    if (r.lyric) e.lyrics.add(r.lyric.replace(/-$/, '').replace(/[.,;:!?]+$/, ''));
    by.set(r.midi, e);
  }
  const all: PitchInsight[] = [...by.entries()].map(([midi, e]) => ({
    midi,
    accuracy: e.w ? e.acc / e.w : 0,
    bias: e.biases.length ? medianOf(e.biases) : NaN,
    count: e.count,
    lyrics: [...e.lyrics].slice(0, 3),
  }));
  const nailed = all.filter((p) => p.accuracy >= 0.85).sort((a, b) => b.accuracy - a.accuracy).slice(0, 4);
  const struggled = all
    .filter((p) => p.accuracy < 0.7 || (Number.isFinite(p.bias) && Math.abs(p.bias) > THRESHOLDS.great))
    .sort((a, b) => a.accuracy - b.accuracy)
    .slice(0, 4);
  return { nailed, struggled };
}

/** Section with the lowest beat-weighted accuracy (for "Practice weak section"). */
export function weakestSection(song: Song, results: readonly NoteResult[]): number {
  let worst = 0;
  let worstAcc = Infinity;
  song.sections.forEach((s, si) => {
    const rs = results.filter((r) => r.index >= s.noteFrom && r.index < s.noteTo);
    if (!rs.length) return;
    const acc = accuracyPct(rs);
    if (acc < worstAcc) {
      worstAcc = acc;
      worst = si;
    }
  });
  return worst;
}
