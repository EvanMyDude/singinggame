import { FFT } from '../audio/pitch/fft';

/**
 * Tempo and key for a song made in the browser. Neither affects scoring (the scorer converts
 * its tolerances and frame times through the same seconds-per-beat), so these are simpler
 * than tools/prepare_song.py, which uses librosa's beat tracker and the instrumental's
 * chroma:
 *
 * - tempo: a spectral-flux onset envelope of the instrumental, scored against beat grids from
 *   70 to 150 BPM (the range prepare_song folds into) by the contrast between the envelope on
 *   the beats and halfway between them, with librosa's log-normal preference around 120 BPM.
 *   The contrast keeps a grid at double or half the tempo from winning.
 * - key: the duration-weighted pitch classes of the target notes correlated with the same
 *   Krumhansl-style profiles prepare_song uses. The key only picks sharps or flats for note
 *   names on the results screen.
 */

export interface TempoEstimate {
  bpm: number;
  /** Time of the first beat of the grid (s). */
  firstBeat: number;
}

const N_FFT = 2048;
const HOP = 512;

/** Half-wave rectified spectral flux of log magnitude, minus a 1 s moving average. */
export function onsetEnvelope(y: ArrayLike<number>, sr: number): { env: Float64Array; fps: number } {
  const nFrames = 1 + Math.floor(y.length / HOP);
  const fft = new FFT(N_FFT);
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  const win = new Float64Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT);
  const bins = N_FFT / 2 + 1;
  let prev = new Float64Array(bins);
  let cur = new Float64Array(bins);
  const flux = new Float64Array(nFrames);
  for (let t = 0; t < nFrames; t++) {
    const start = t * HOP - N_FFT / 2;
    for (let i = 0; i < N_FFT; i++) {
      const k = start + i;
      re[i] = k >= 0 && k < y.length ? y[k]! * win[i]! : 0;
      im[i] = 0;
    }
    fft.transform(re, im);
    let f = 0;
    for (let b = 0; b < bins; b++) {
      cur[b] = Math.log1p(100 * Math.hypot(re[b]!, im[b]!));
      if (t > 0) f += Math.max(0, cur[b]! - prev[b]!);
    }
    flux[t] = f;
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  const fps = sr / HOP;
  const half = Math.round(fps / 2);
  const env = new Float64Array(nFrames);
  let acc = 0;
  for (let t = 0; t < nFrames + half; t++) {
    if (t < nFrames) acc += flux[t]!;
    if (t - 2 * half - 1 >= 0) acc -= flux[t - 2 * half - 1]!;
    const c = t - half;
    if (c >= 0 && c < nFrames) {
      const lo = Math.max(0, c - half);
      const hi = Math.min(nFrames - 1, c + half);
      env[c] = Math.max(0, flux[c]! - acc / (hi - lo + 1));
    }
  }
  return { env, fps };
}

function sampleAt(env: Float64Array, pos: number): number {
  const i = Math.floor(pos);
  const f = pos - i;
  if (i < 0 || i + 1 >= env.length) return 0;
  return env[i]! * (1 - f) + env[i + 1]! * f;
}

export function estimateTempo(y: ArrayLike<number>, sr: number): TempoEstimate {
  const { env, fps } = onsetEnvelope(y, sr);
  let best = { score: -Infinity, bpm: 120, phase: 0 };
  for (let bpm = 70; bpm <= 150.0001; bpm += 0.05) {
    const period = (60 / bpm) * fps;
    const beats = Math.floor((env.length - period) / period);
    if (beats < 4) continue;
    const prior = Math.exp(-0.5 * Math.log2(bpm / 120) ** 2);
    for (let phase = 0; phase < period; phase += 0.5) {
      let on = 0;
      let off = 0;
      for (let k = 0; k < beats; k++) {
        on += sampleAt(env, phase + k * period);
        off += sampleAt(env, phase + (k + 0.5) * period);
      }
      const score = ((on - off) / beats) * prior;
      if (score > best.score) best = { score, bpm, phase };
    }
  }
  return { bpm: best.bpm, firstBeat: best.phase / fps };
}

const KEY_PROFILES = {
  major: [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
  minor: [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
} as const;

function corr(a: readonly number[], b: readonly number[]): number {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i]! - ma) * (b[i]! - mb);
    saa += (a[i]! - ma) ** 2;
    sbb += (b[i]! - mb) ** 2;
  }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
}

/** Key from the target notes: tonic pitch class (0 = C) and mode. */
export function estimateKey(notes: readonly { midi: number; dur: number }[]): { tonic: number; mode: 'major' | 'minor'; r: number } {
  const hist = new Array<number>(12).fill(0);
  for (const n of notes) hist[((n.midi % 12) + 12) % 12]! += n.dur;
  let best: { tonic: number; mode: 'major' | 'minor'; r: number } = { tonic: 0, mode: 'major', r: -2 };
  for (const mode of ['major', 'minor'] as const) {
    const prof = KEY_PROFILES[mode];
    for (let tonic = 0; tonic < 12; tonic++) {
      const rolled = prof.map((_, i) => prof[(i - tonic + 12) % 12]!);
      const r = corr(rolled, hist);
      if (r > best.r) best = { tonic, mode, r };
    }
  }
  return best;
}
