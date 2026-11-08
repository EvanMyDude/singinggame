/**
 * Energy-onset detector used for latency calibration (claps, taps on the mic, "ta").
 * Works on 64-sample blocks (~1.3 ms) against a slowly adapting background level, then
 * refines to the first sample above half the block peak.
 */
export class OnsetDetector {
  private readonly sr: number;
  private readonly block: number;
  private readonly gateMs: number;
  private readonly ratio: number;
  private readonly refractory: number;
  private bg = 1e-7;
  private lastOnset = -Infinity;
  private buf: Float32Array;
  private fill = 0;
  private bufStart = 0;

  constructor(sampleRate: number, opts: { gateDb?: number; ratio?: number; refractory?: number } = {}) {
    this.sr = sampleRate;
    this.block = 64;
    const gateLin = Math.pow(10, (opts.gateDb ?? -42) / 20);
    this.gateMs = gateLin * gateLin;
    this.ratio = opts.ratio ?? 10; // power ratio, +10 dB over background
    this.refractory = opts.refractory ?? 0.2;
    this.buf = new Float32Array(this.block);
  }

  push(chunk: Float32Array, startTime: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < chunk.length; i++) {
      if (this.fill === 0) this.bufStart = startTime + i / this.sr;
      this.buf[this.fill++] = chunk[i]!;
      if (this.fill === this.block) {
        const t = this.processBlock();
        if (t !== null) out.push(t);
        this.fill = 0;
      }
    }
    return out;
  }

  private processBlock(): number | null {
    let ms = 0;
    let peak = 0;
    for (let i = 0; i < this.block; i++) {
      const v = this.buf[i]!;
      ms += v * v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    ms /= this.block;
    const t = this.bufStart;
    const inRefractory = t - this.lastOnset < this.refractory;
    if (!inRefractory && ms > this.gateMs && ms > this.ratio * this.bg) {
      this.lastOnset = t;
      let k = 0;
      while (k < this.block && Math.abs(this.buf[k]!) < 0.5 * peak) k++;
      return t + k / this.sr;
    }
    if (!inRefractory) {
      // ~60 ms time constant at 64-sample blocks / 48 kHz.
      const a = this.block / this.sr / 0.06;
      this.bg += Math.min(1, a) * (ms - this.bg);
      if (this.bg < 1e-9) this.bg = 1e-9;
    }
    return null;
  }
}

export interface LatencyEstimate {
  latency: number;
  /** Median absolute deviation of the per-click offsets (s). */
  spread: number;
  hits: number;
  offsets: number[];
}

/**
 * For each click, take the first onset in [click - 0.1, click + 0.45] and return the
 * median offset. Returns null when fewer than `minHits` clicks were answered.
 */
export function estimateLatency(clicks: readonly number[], onsets: readonly number[], minHits = 5): LatencyEstimate | null {
  const offsets: number[] = [];
  for (const c of clicks) {
    const o = onsets.find((t) => t >= c - 0.1 && t <= c + 0.45);
    if (o !== undefined) offsets.push(o - c);
  }
  if (offsets.length < minHits) return null;
  const sorted = [...offsets].sort((a, b) => a - b);
  const med = sorted[sorted.length >> 1]!;
  const devs = offsets.map((o) => Math.abs(o - med)).sort((a, b) => a - b);
  const spread = devs[devs.length >> 1]!;
  return { latency: Math.max(0, med), spread, hits: offsets.length, offsets };
}
