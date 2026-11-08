/**
 * Owns the AudioContext and the output graph:
 *
 *   session gain -> backing / melody / click buses -> dry + reverb send -> compressor -> out
 *   preview bus (Hear Target Note, trainer tones) -> compressor -> out
 *
 * A "session" gain is created per playback so stopping a song can fade and detach every
 * already-scheduled voice at once instead of tracking hundreds of nodes.
 */
export interface Buses {
  backing: GainNode;
  melody: GainNode;
  click: GainNode;
}

export class AudioEngine {
  readonly ctx: AudioContext;
  readonly out: DynamicsCompressorNode;
  readonly reverb: ConvolverNode;
  readonly reverbSend: GainNode;
  readonly preview: GainNode;
  private readonly busGains: { backing: GainNode; melody: GainNode; click: GainNode };
  private readonly noise: AudioBuffer;
  private lastHeard = 0;

  private constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.out = ctx.createDynamicsCompressor();
    this.out.threshold.value = -14;
    this.out.knee.value = 10;
    this.out.ratio.value = 4;
    this.out.attack.value = 0.004;
    this.out.release.value = 0.2;
    const master = ctx.createGain();
    master.gain.value = 0.9;
    this.out.connect(master).connect(ctx.destination);

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = makeImpulse(ctx, 1.9, 2.8);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.22;
    this.reverbSend.connect(this.reverb).connect(this.out);

    const mk = (v: number) => {
      const g = ctx.createGain();
      g.gain.value = v;
      g.connect(this.out);
      g.connect(this.reverbSend);
      return g;
    };
    this.busGains = { backing: mk(0.8), melody: mk(0.8), click: mk(0.7) };
    this.preview = mk(0.8);
    this.noise = makeNoise(ctx);
  }

  static create(): AudioEngine {
    const Ctor: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctor({ latencyHint: 'interactive' });
    return new AudioEngine(ctx);
  }

  async resume(): Promise<void> {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  get noiseBuffer(): AudioBuffer {
    return this.noise;
  }

  setVolumes(v: { backing?: number; melody?: number; click?: number }): void {
    const t = this.ctx.currentTime;
    for (const k of ['backing', 'melody', 'click'] as const) {
      const val = v[k];
      if (val !== undefined) this.busGains[k].gain.setTargetAtTime(curve(val), t, 0.03);
    }
    if (v.melody !== undefined) this.preview.gain.setTargetAtTime(Math.max(0.35, curve(v.melody)), t, 0.03);
  }

  /** Per-playback buses, all routed through one gain so `close()` silences everything scheduled. */
  openSession(): { buses: Buses; close: (fade?: number) => void; setMute: (part: keyof Buses, muted: boolean) => void } {
    const ctx = this.ctx;
    const mk = (dest: GainNode) => {
      const g = ctx.createGain();
      g.connect(dest);
      return g;
    };
    const buses: Buses = { backing: mk(this.busGains.backing), melody: mk(this.busGains.melody), click: mk(this.busGains.click) };
    return {
      buses,
      setMute: (part, muted) => buses[part].gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.02),
      close: (fade = 0.06) => {
        const t = ctx.currentTime;
        for (const g of Object.values(buses)) {
          g.gain.cancelScheduledValues(t);
          g.gain.setValueAtTime(g.gain.value, t);
          g.gain.linearRampToValueAtTime(0, t + fade);
        }
        setTimeout(() => Object.values(buses).forEach((g) => g.disconnect()), (fade + 0.3) * 1000);
      },
    };
  }

  /** Estimated round-trip budget reported by the browser (before calibration). */
  defaultLatency(inputLatency = 0): number {
    const out = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
    const total = out + (inputLatency || 0.015);
    return clamp(total > 0.01 ? total : 0.06, 0.02, 0.4);
  }

  /**
   * AudioContext time of the audio currently reaching the speakers, interpolated with
   * performance.now() so the scroll is smooth between audio callbacks. Never goes backwards.
   */
  heardTime(): number {
    const ctx = this.ctx;
    let t: number;
    const ts = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null;
    if (ts && ts.contextTime !== undefined && ts.performanceTime !== undefined && ts.performanceTime > 0 && ts.contextTime > 0) {
      t = ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
      // Guard against implementations that report a stale timestamp.
      const lead = ctx.currentTime - t;
      if (lead < -0.05 || lead > 0.5) t = ctx.currentTime - (ctx.outputLatency || 0);
    } else {
      t = ctx.currentTime - (ctx.outputLatency || 0);
    }
    if (t < this.lastHeard && this.lastHeard - t < 0.05) t = this.lastHeard;
    this.lastHeard = t;
    return t;
  }
}

/** Perceptual volume curve for 0..1 sliders. */
function curve(v: number): number {
  const c = clamp(v, 0, 1);
  return c * c;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function makeImpulse(ctx: BaseAudioContext, seconds: number, decay: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  let seed = 1234567;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      // Short pre-delay, then exponentially decaying noise with gentle high damping.
      const env = i < ctx.sampleRate * 0.012 ? 0 : Math.pow(1 - t, decay);
      d[i] = (rnd() * 2 - 1) * env * (1 - 0.6 * t);
    }
  }
  return buf;
}

function makeNoise(ctx: BaseAudioContext): AudioBuffer {
  const len = ctx.sampleRate;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let seed = 99;
  for (let i = 0; i < len; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    d[i] = (seed / 0x7fffffff) * 2 - 1;
  }
  return buf;
}
