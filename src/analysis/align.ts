import { FFT } from '../audio/pitch/fft';
import { median, pyRound, roundHalfEven } from './numeric';

/**
 * Where a stem sits inside the full mix, ported from `measure_lag` in tools/prepare_song.py:
 * a whole-file cross-correlation (up to 10 s either way), then a check in 8 s windows so a
 * file from another master or running at another speed is reported instead of silently
 * shifting every target.
 *
 * The whole-file correlation is computed block by block (overlap-save over the lag range)
 * instead of in one transform of the whole song, which would need hundreds of megabytes in
 * a browser. The values are the same; only the bookkeeping differs.
 */

const fftCache = new Map<number, FFT>();
function fftOf(n: number): FFT {
  let f = fftCache.get(n);
  if (!f) {
    f = new FFT(n);
    fftCache.set(n, f);
  }
  return f;
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * c[m] = sum_i x[i] y[i + m] for m = 0..y.length - x.length (x no longer than y), with the
 * given means removed first. Only these lags are needed, so the circular correlation of size
 * >= y.length never wraps. One complex transform carries both real inputs.
 */
export function correlateValid(x: ArrayLike<number>, y: ArrayLike<number>, xMean = 0, yMean = 0): Float64Array {
  const n = nextPow2(Math.max(x.length, y.length));
  const fft = fftOf(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < x.length; i++) re[i] = x[i]! - xMean;
  for (let i = 0; i < y.length; i++) im[i] = y[i]! - yMean;
  fft.transform(re, im);
  // X = (Z_k + conj Z_{N-k}) / 2, Y = (Z_k - conj Z_{N-k}) / 2i; product conj(X) * Y.
  const pr = new Float64Array(n);
  const pi = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const m = (n - k) & (n - 1);
    const xr = (re[k]! + re[m]!) / 2;
    const xi = (im[k]! - im[m]!) / 2;
    const yr = (im[k]! + im[m]!) / 2;
    const yi = -(re[k]! - re[m]!) / 2;
    pr[k] = xr * yr + xi * yi;
    pi[k] = xr * yi - xi * yr;
  }
  fft.transform(pr, pi, true);
  const out = new Float64Array(Math.max(0, y.length - x.length + 1));
  for (let m = 0; m < out.length; m++) out[m] = pr[m]! / n;
  return out;
}

function mean(x: ArrayLike<number>, from = 0, to = x.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i]!;
  return to > from ? s / (to - from) : 0;
}

function sumSq(x: ArrayLike<number>, from = 0, to = x.length, mu = 0): number {
  let s = 0;
  for (let i = from; i < to; i++) {
    const v = x[i]! - mu;
    s += v * v;
  }
  return s;
}

/**
 * Lag l in [-maxLag, maxLag] maximizing |sum x[n] y[n + l]| over the first `len` samples of
 * both (each with its mean removed), and the peak normalized by both energies
 * (`xcorr_lag` in tools/extract_melody.py).
 */
export function xcorrLag(x: ArrayLike<number>, y: ArrayLike<number>, len: number, maxLag: number): { lag: number; peak: number } {
  const xm = mean(x, 0, len);
  const ym = mean(y, 0, len);
  const L = maxLag;
  const N = Math.max(1 << 16, nextPow2(4 * L));
  const B = N - 2 * L;
  const r = new Float64Array(2 * L + 1); // r[l + L]
  const xs = new Float64Array(B);
  const ys = new Float64Array(B + 2 * L);
  for (let s = 0; s < len; s += B) {
    const bl = Math.min(B, len - s);
    xs.fill(0);
    for (let i = 0; i < bl; i++) xs[i] = x[s + i]! - xm;
    for (let i = 0; i < B + 2 * L; i++) {
      const k = s - L + i;
      ys[i] = k >= 0 && k < len ? y[k]! - ym : 0;
    }
    const c = correlateValid(xs, ys);
    for (let m = 0; m <= 2 * L; m++) r[m]! += c[m]!;
  }
  // numpy's order: lags 0..maxLag, then -maxLag..-1; the first largest |value| wins.
  let best = -1;
  let lag = 0;
  const visit = (l: number) => {
    const v = Math.abs(r[l + L]!);
    if (v > best) {
      best = v;
      lag = l;
    }
  };
  for (let l = 0; l <= L; l++) visit(l);
  for (let l = -L; l < 0; l++) visit(l);
  const norm = r[lag + L]! / (Math.sqrt(sumSq(x, 0, len, xm) * sumSq(y, 0, len, ym)) + 1e-12);
  return { lag, peak: norm };
}

export interface LagInfo {
  coarseLag: number;
  coarsePeak: number;
  windows: number;
  medianLag?: number;
  madSamples?: number;
  slopePpm?: number;
}

/**
 * Lag l (samples) with mix[n + l] <-> x[n], for a track `x` that is part of the mix.
 * `activeOnly` skips windows where `x` is nearly silent (a vocal between phrases).
 */
export function measureLag(x: Float32Array, mix: Float32Array, sr: number, what: string, minCorr: number, activeOnly: boolean, warn: (m: string) => void): { lag: number; info: LagInfo } {
  const n = Math.min(x.length, mix.length);
  const coarse = xcorrLag(x, mix, n, 10 * sr);
  const W = 8 * sr;
  const R = Math.floor(sr / 2);
  const level = Math.sqrt(sumSq(x) / Math.max(1, x.length)) + 1e-9;
  const rows: { t: number; l: number }[] = [];
  for (let s = 0; s < x.length - W; s += W) {
    const lo = s + coarse.lag - R;
    const hi = s + W + coarse.lag + R;
    if (lo < 0 || hi > mix.length) continue;
    if (activeOnly && Math.sqrt(sumSq(x, s, s + W) / W) < 0.5 * level) continue;
    const seg = x.subarray(s, s + W);
    const y = mix.subarray(lo, hi);
    const cc = correlateValid(seg, y, mean(seg), mean(y));
    let k = 0;
    for (let m = 1; m < cc.length; m++) if (Math.abs(cc[m]!) > Math.abs(cc[k]!)) k = m;
    const c = cc[k]! / (Math.sqrt(sumSq(seg) * sumSq(y, k, k + seg.length)) + 1e-12);
    if (Math.abs(c) > minCorr) rows.push({ t: s / sr, l: lo + k - s });
  }
  const info: LagInfo = { coarseLag: coarse.lag, coarsePeak: pyRound(coarse.peak, 3), windows: rows.length };
  if (rows.length >= 4) {
    const l = rows.map((r) => r.l);
    const med = median(l);
    const mad = median(l.map((v) => Math.abs(v - med)));
    const slopes: number[] = [];
    for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) slopes.push((rows[j]!.l - rows[i]!.l) / (rows[j]!.t - rows[i]!.t));
    const slope = median(slopes);
    Object.assign(info, { medianLag: med, madSamples: mad, slopePpm: pyRound((slope / sr) * 1e6, 3) });
    if (Math.abs(slope / sr) > 2e-4) warn(`${what} and the full mix run at different speeds (${Math.round((slope / sr) * 1e6)} ppm); one offset will not align them.`);
    if (mad > 0.01 * sr) warn(`Per-window offsets of ${what} disagree (MAD ${((mad / sr) * 1000).toFixed(1)} ms); check that it comes from the same recording as the full mix.`);
    return { lag: roundHalfEven(med), info };
  }
  warn(`Could not verify the offset of ${what} per window; using the whole-file estimate.`);
  return { lag: coarse.lag, info };
}
