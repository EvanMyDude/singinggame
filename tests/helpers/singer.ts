import type { ScoreFrame } from '../../src/core/scoring';
import type { Song } from '../../src/core/song';
import { mulberry32 } from './signals';

export interface SingerOpts {
  /** Constant offset in cents (negative = flat). */
  biasCents?: number;
  /** Gaussian pitch scatter (cents, per frame, low-passed). */
  sigmaCents?: number;
  /** Per-note random offset (cents std): untrained singers miss each note differently. */
  noteSigmaCents?: number;
  /** Seconds the singer lags what they hear. */
  reaction?: number;
  /** Actual hardware round-trip latency added to frame stamps. */
  latency?: number;
  /** Semitone offset (e.g. -12 for singing an octave down). */
  octaveShift?: number;
  /** Fraction of each note (from its end) the singer is silent, e.g. breaths. */
  gapFraction?: number;
  silent?: boolean;
  seed?: number;
}

/** Produce tracker-like frames for a virtual singer performing `song`. */
export function simulateSinger(
  song: Song,
  t0: number,
  secPerBeat: number,
  frameInterval: number,
  opts: SingerOpts = {},
): ScoreFrame[] {
  const rand = mulberry32(opts.seed ?? 42);
  const gauss = () => {
    const u = Math.max(1e-9, rand());
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const frames: ScoreFrame[] = [];
  const end = t0 + song.totalBeats * secPerBeat + 0.5;
  let drift = 0;
  const noteOffset = song.notes.map(() => gauss() * (opts.noteSigmaCents ?? 0));
  for (let t = t0 - 0.5; t < end; t += frameInterval) {
    const heardBeat = (t - (opts.reaction ?? 0) - t0) / secPerBeat;
    const note = song.notes.find((n) => heardBeat >= n.start && heardBeat < n.start + n.beats);
    const stamp = t + (opts.latency ?? 0);
    if (!note || opts.silent) {
      frames.push({ time: stamp, voiced: false, midi: NaN });
      continue;
    }
    const pos = (heardBeat - note.start) / note.beats;
    if (pos > 1 - (opts.gapFraction ?? 0.08)) {
      frames.push({ time: stamp, voiced: false, midi: NaN });
      continue;
    }
    drift = 0.8 * drift + 0.2 * gauss() * (opts.sigmaCents ?? 0) * 2.2;
    const cents = (opts.biasCents ?? 0) + noteOffset[note.index]! + drift;
    frames.push({ time: stamp, voiced: true, midi: note.midi + (opts.octaveShift ?? 0) + cents / 100 });
  }
  return frames;
}
