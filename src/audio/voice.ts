import { AudioEngine } from './engine';
import { MicInput, type MicOpenOptions } from './mic';
import { PitchTracker, type VoiceFrame } from './pitch/tracker';

/**
 * Shared audio runtime: one AudioContext, one mic, one tracker, many subscribers.
 * Created lazily on the first user gesture (browsers require it for audio).
 */
export class VoiceRuntime {
  readonly engine: AudioEngine;
  readonly mic: MicInput;
  private tracker: PitchTracker;
  private readonly frameListeners = new Set<(f: VoiceFrame) => void>();
  private readonly chunkListeners = new Set<(d: Float32Array, t: number) => void>();
  latest: VoiceFrame | null = null;
  /** Highest absolute sample seen since last `takePeak()` (for clipping warnings). */
  private peakHold = 0;
  private gateDb = -45;

  constructor() {
    this.engine = AudioEngine.create();
    this.mic = new MicInput(this.engine);
    this.tracker = new PitchTracker(this.engine.ctx.sampleRate, { gateDb: this.gateDb });
    this.mic.onChunk((d, t) => {
      for (let i = 0; i < d.length; i++) {
        const a = d[i]! < 0 ? -d[i]! : d[i]!;
        if (a > this.peakHold) this.peakHold = a;
      }
      for (const l of this.chunkListeners) l(d, t);
      for (const f of this.tracker.push(d, t)) {
        this.latest = f;
        for (const l of this.frameListeners) l(f);
      }
    });
  }

  get sampleRate(): number {
    return this.engine.ctx.sampleRate;
  }

  get frameInterval(): number {
    return this.tracker.hop / this.tracker.sampleRate;
  }

  async openMic(opts: MicOpenOptions): Promise<void> {
    await this.engine.resume();
    await this.mic.open(opts);
    this.tracker.reset();
  }

  setGate(db: number): void {
    this.gateDb = db;
    this.tracker.setGateDb(db);
  }

  get gate(): number {
    return this.gateDb;
  }

  onFrame(cb: (f: VoiceFrame) => void): () => void {
    this.frameListeners.add(cb);
    return () => this.frameListeners.delete(cb);
  }

  onChunk(cb: (d: Float32Array, t: number) => void): () => void {
    this.chunkListeners.add(cb);
    return () => this.chunkListeners.delete(cb);
  }

  takePeak(): number {
    const p = this.peakHold;
    this.peakHold = 0;
    return p;
  }
}

let runtime: VoiceRuntime | null = null;

export function getRuntime(): VoiceRuntime {
  if (!runtime) runtime = new VoiceRuntime();
  return runtime;
}

export function hasRuntime(): boolean {
  return runtime !== null;
}
