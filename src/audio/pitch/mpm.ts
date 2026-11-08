import { FFT } from './fft';

/**
 * McLeod Pitch Method (McLeod & Wyvill, "A Smarter Way to Find Pitch", 2005).
 *
 * NSDF n(t) = 2 r(t) / m(t), with r the (shrinking-window) autocorrelation computed by FFT
 * and m the matching energy term computed incrementally. Key maxima of n are found between
 * zero crossings; the first one within k * (highest key maximum) is taken as the period,
 * which avoids the sub-octave errors of picking the global maximum. The interpolated NSDF
 * peak ("clarity", 0..1) says how periodic the frame is and drives voicing decisions.
 */
export interface PitchEstimate {
  /** Fundamental in Hz, or 0 when no periodicity was found. */
  hz: number;
  /** NSDF peak value in [0, 1]; ~0.95+ for a clean sung vowel, low for noise. */
  clarity: number;
  /** RMS of the (DC-removed) frame, linear full-scale. */
  rms: number;
  /** Peak absolute sample value of the frame. */
  peak: number;
}

export interface MpmOptions {
  minHz?: number;
  maxHz?: number;
  /** Key-maximum threshold ratio. 0.9 is a good default for voice. */
  k?: number;
}

export class MpmDetector {
  readonly sampleRate: number;
  readonly windowSize: number;
  private readonly fft: FFT;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly x: Float64Array;
  private readonly nsdf: Float64Array;
  private readonly minTau: number;
  private readonly maxTau: number;
  private readonly k: number;
  private readonly keyTau: Int32Array;
  private readonly keyVal: Float64Array;

  constructor(sampleRate: number, windowSize: number, opts: MpmOptions = {}) {
    this.sampleRate = sampleRate;
    this.windowSize = windowSize;
    const minHz = opts.minHz ?? 60;
    const maxHz = opts.maxHz ?? 1500;
    this.k = opts.k ?? 0.9;
    this.fft = new FFT(windowSize * 2);
    this.re = new Float64Array(windowSize * 2);
    this.im = new Float64Array(windowSize * 2);
    this.x = new Float64Array(windowSize);
    this.minTau = Math.max(2, Math.floor(sampleRate / maxHz));
    // Keep at least ~40 % of the window overlapping at the longest lag.
    this.maxTau = Math.min(Math.ceil(sampleRate / minHz), Math.floor(windowSize * 0.6));
    this.nsdf = new Float64Array(this.maxTau + 2);
    this.keyTau = new Int32Array(64);
    this.keyVal = new Float64Array(64);
  }

  /** Analyze exactly `windowSize` samples (extra samples are ignored). */
  detect(frame: ArrayLike<number>): PitchEstimate {
    const n = this.windowSize;
    const x = this.x;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += frame[i]!;
    mean /= n;
    let sumSq = 0;
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const v = frame[i]! - mean;
      x[i] = v;
      sumSq += v * v;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
    }
    const rms = Math.sqrt(sumSq / n);
    if (rms < 1e-6) return { hz: 0, clarity: 0, rms, peak };

    // Autocorrelation via |FFT|^2 of the zero-padded frame.
    const re = this.re;
    const im = this.im;
    re.fill(0);
    im.fill(0);
    re.set(x);
    this.fft.transform(re, im, false);
    for (let i = 0; i < re.length; i++) {
      re[i] = re[i]! * re[i]! + im[i]! * im[i]!;
      im[i] = 0;
    }
    this.fft.transform(re, im, true);
    const scale = 1 / re.length;

    // NSDF with incrementally updated energy term.
    const nsdf = this.nsdf;
    const maxTau = this.maxTau;
    let m = 2 * sumSq;
    nsdf[0] = 1;
    for (let tau = 1; tau <= maxTau; tau++) {
      m -= x[tau - 1]! * x[tau - 1]! + x[n - tau]! * x[n - tau]!;
      const r = re[tau]! * scale;
      nsdf[tau] = m > 1e-12 ? (2 * r) / m : 0;
    }

    // Key maxima: highest point of each positive lobe after the first negative crossing.
    let count = 0;
    let tau = 1;
    while (tau <= maxTau && nsdf[tau]! > 0) tau++;
    let inLobe = false;
    let bestTau = -1;
    let bestVal = -Infinity;
    for (; tau <= maxTau; tau++) {
      const v = nsdf[tau]!;
      const prev = nsdf[tau - 1]!;
      if (!inLobe && prev <= 0 && v > 0) {
        inLobe = true;
        bestTau = -1;
        bestVal = -Infinity;
      }
      if (inLobe) {
        if (v > bestVal) {
          bestVal = v;
          bestTau = tau;
        }
        if (v <= 0 || tau === maxTau) {
          // A lobe cut off by maxTau only counts if its peak is interior.
          const interior = v <= 0 || bestTau < maxTau;
          if (interior && bestTau >= this.minTau && count < this.keyTau.length) {
            this.keyTau[count] = bestTau;
            this.keyVal[count] = bestVal;
            count++;
          }
          inLobe = false;
        }
      }
    }
    if (count === 0) return { hz: 0, clarity: 0, rms, peak };

    let highest = 0;
    for (let i = 0; i < count; i++) if (this.keyVal[i]! > highest) highest = this.keyVal[i]!;
    const threshold = this.k * highest;
    let chosen = 0;
    for (let i = 0; i < count; i++) {
      if (this.keyVal[i]! >= threshold) {
        chosen = i;
        break;
      }
    }

    const tp = this.keyTau[chosen]!;
    const a = nsdf[tp - 1]!;
    const b = nsdf[tp]!;
    const c = tp + 1 <= maxTau ? nsdf[tp + 1]! : b;
    const denom = a - 2 * b + c;
    let delta = 0;
    let peakVal = b;
    if (denom < 0) {
      delta = (0.5 * (a - c)) / denom;
      if (delta > 0.5) delta = 0.5;
      if (delta < -0.5) delta = -0.5;
      peakVal = b - 0.25 * (a - c) * delta;
    }
    const period = tp + delta;
    const hz = this.sampleRate / period;
    const clarity = peakVal > 1 ? 1 : peakVal < 0 ? 0 : peakVal;
    return { hz, clarity, rms, peak };
  }
}
