import { hzToMidi } from '../../core/music';
import { MpmDetector } from './mpm';

export interface VoiceFrame {
  /** AudioContext time (s) of the analysis window center. */
  time: number;
  /** True when the frame passed the level gate and clarity check. */
  voiced: boolean;
  /** Median-filtered pitch (MIDI, fractional). NaN when unvoiced. Used for scoring. */
  midi: number;
  /** Additionally One-Euro smoothed pitch for display. NaN when unvoiced. */
  displayMidi: number;
  clarity: number;
  /** Frame RMS in dBFS. */
  db: number;
  /** Frame peak, linear 0..1+. */
  peak: number;
}

export interface TrackerOptions {
  /** Frames quieter than this (dBFS) are treated as silence. */
  gateDb?: number;
  /** Minimum NSDF clarity for a frame to count as sung. */
  minClarity?: number;
  minHz?: number;
  maxHz?: number;
}

/**
 * One Euro filter (Casiez et al., 2012): adaptive low-pass whose cutoff rises with speed,
 * so held notes are steady while note changes are followed with little lag.
 */
export class OneEuroFilter {
  private x: number | null = null;
  private dx = 0;
  private t = 0;
  constructor(
    private readonly minCutoff: number,
    private readonly beta: number,
    private readonly dCutoff = 1,
  ) {}

  reset(): void {
    this.x = null;
    this.dx = 0;
  }

  filter(value: number, time: number): number {
    if (this.x === null) {
      this.x = value;
      this.t = time;
      return value;
    }
    const dt = Math.max(1e-4, time - this.t);
    this.t = time;
    const ad = alpha(this.dCutoff, dt);
    const rawDx = (value - this.x) / dt;
    this.dx = ad * rawDx + (1 - ad) * this.dx;
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    const a = alpha(cutoff, dt);
    this.x = a * value + (1 - a) * this.x;
    return this.x;
  }
}

function alpha(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

export function dbfs(linear: number): number {
  return linear > 1e-9 ? 20 * Math.log10(linear) : -180;
}

/**
 * Turns a stream of timestamped mic chunks into pitch frames: ring buffer, one MPM analysis
 * per hop, level gate, clarity gate, median-of-5 de-spiking, One Euro display smoothing.
 */
export class PitchTracker {
  readonly sampleRate: number;
  readonly windowSize: number;
  readonly hop: number;
  private readonly detector: MpmDetector;
  private readonly ring: Float32Array;
  private readonly frame: Float32Array;
  private pos = 0;
  private filled = 0;
  private sinceHop = 0;
  private gateDb: number;
  private readonly minClarity: number;
  private readonly recent: number[] = [];
  private lastVoicedTime = -Infinity;
  private readonly euro = new OneEuroFilter(1.5, 0.35, 1);

  constructor(sampleRate: number, opts: TrackerOptions = {}) {
    this.sampleRate = sampleRate;
    this.windowSize = sampleRate >= 32000 ? 2048 : 1024;
    this.hop = this.windowSize / 4;
    this.detector = new MpmDetector(sampleRate, this.windowSize, {
      minHz: opts.minHz ?? 60,
      maxHz: opts.maxHz ?? 1500,
    });
    this.ring = new Float32Array(this.windowSize);
    this.frame = new Float32Array(this.windowSize);
    this.gateDb = opts.gateDb ?? -45;
    // White noise measures < 0.1 clarity; slightly breathy or noisy vowels measure 0.67-0.87.
    this.minClarity = opts.minClarity ?? 0.65;
  }

  /** Seconds between the newest sample and the stamped window center. */
  get analysisDelay(): number {
    return this.windowSize / 2 / this.sampleRate;
  }

  setGateDb(db: number): void {
    this.gateDb = db;
  }

  reset(): void {
    this.pos = 0;
    this.filled = 0;
    this.sinceHop = 0;
    this.recent.length = 0;
    this.lastVoicedTime = -Infinity;
    this.euro.reset();
  }

  /**
   * Feed a chunk whose first sample was captured at AudioContext time `startTime`.
   * Returns the frames completed by this chunk (usually one per 512 samples).
   */
  push(chunk: Float32Array, startTime: number): VoiceFrame[] {
    const out: VoiceFrame[] = [];
    const n = this.windowSize;
    for (let i = 0; i < chunk.length; i++) {
      this.ring[this.pos] = chunk[i]!;
      this.pos = (this.pos + 1) % n;
      if (this.filled < n) this.filled++;
      this.sinceHop++;
      if (this.sinceHop >= this.hop && this.filled === n) {
        this.sinceHop = 0;
        const endTime = startTime + (i + 1) / this.sampleRate;
        out.push(this.analyze(endTime - this.analysisDelay));
      }
    }
    return out;
  }

  private analyze(time: number): VoiceFrame {
    const n = this.windowSize;
    // Unroll ring so the oldest sample is first.
    const head = this.pos;
    this.frame.set(this.ring.subarray(head), 0);
    this.frame.set(this.ring.subarray(0, head), n - head);
    const est = this.detector.detect(this.frame);
    const db = dbfs(est.rms);
    const voiced = est.hz > 0 && db >= this.gateDb && est.clarity >= this.minClarity;

    if (!voiced) {
      if (time - this.lastVoicedTime > 0.12) {
        this.recent.length = 0;
        this.euro.reset();
      }
      return { time, voiced: false, midi: NaN, displayMidi: NaN, clarity: est.clarity, db, peak: est.peak };
    }

    const raw = hzToMidi(est.hz);
    if (time - this.lastVoicedTime > 0.12) {
      this.recent.length = 0;
      this.euro.reset();
    }
    this.lastVoicedTime = time;
    this.recent.push(raw);
    if (this.recent.length > 5) this.recent.shift();
    const midi = median(this.recent);
    const displayMidi = this.euro.filter(midi, time);
    return { time, voiced: true, midi, displayMidi, clarity: est.clarity, db, peak: est.peak };
  }
}

export function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
