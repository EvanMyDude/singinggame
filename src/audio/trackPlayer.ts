import type { AudioEngine } from './engine';
import { CtxClock, SmoothClock } from './songClock';

/**
 * Plays the instrumental and the reference recording as two HTMLMediaElements routed through
 * Web Audio. Both play at once, time-aligned by `referenceOffset`; "Reference Vocal" only
 * changes their gains, so toggling never restarts or loses the position. The media
 * element does the pitch-preserving time stretch for practice speeds (`preservesPitch`).
 *
 * The reference is either the full mix, which replaces the instrumental while it is on, or
 * an isolated vocal, which is layered over the instrumental (`referenceMode`).
 *
 * Song time is the instrumental's timeline (what the melody and lyric timing use).
 */

export interface TrackPlayerOptions {
  /** Reference time = song time + offset (s). */
  referenceOffset: number;
  /** `replace` (default): the reference is a full mix. `layer`: it is a vocal on top of the instrumental. */
  referenceMode?: 'replace' | 'layer';
  onEnded?: () => void;
  onLoop?: () => void;
  onError?: (message: string) => void;
}

interface Track {
  el: HTMLAudioElement;
  gain: GainNode;
}

const SYNC_TOLERANCE = 0.04;

export class TrackPlayer {
  private readonly engine: AudioEngine;
  private readonly opts: TrackPlayerOptions;
  private readonly inst: Track;
  private readonly ref: Track | null;
  private readonly master: GainNode;
  private readonly smooth = new SmoothClock();
  private readonly ctxClock = new CtxClock();
  private reference = false;
  private readonly layer: boolean;
  private rate = 1;
  private loopA: number | null = null;
  private loopB: number | null = null;
  private looping = false;
  private timer: number | null = null;
  private destroyed = false;
  private lastSync = 0;

  constructor(engine: AudioEngine, instrumentalUrl: string, referenceUrl: string | null, opts: TrackPlayerOptions) {
    this.engine = engine;
    this.opts = opts;
    this.layer = opts.referenceMode === 'layer';
    const ctx = engine.ctx;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    this.inst = this.makeTrack(instrumentalUrl, 1);
    this.ref = referenceUrl ? this.makeTrack(referenceUrl, 0) : null;
    this.inst.el.addEventListener('ended', () => {
      if (this.destroyed) return;
      if (this.looping && this.loopA !== null) this.seek(this.loopA);
      else {
        this.ref?.el.pause();
        this.smooth.setPlaying(false, this.inst.el.duration || this.inst.el.currentTime, performance.now());
        this.opts.onEnded?.();
      }
    });
    for (const t of [this.inst, this.ref]) {
      t?.el.addEventListener('error', () => this.opts.onError?.(`Could not play ${t === this.inst ? 'the instrumental' : 'the reference track'}.`));
    }
  }

  private makeTrack(url: string, gain: number): Track {
    const ctx = this.engine.ctx;
    const el = new Audio();
    el.preload = 'auto';
    el.src = url;
    const anyEl = el as HTMLAudioElement & { mozPreservesPitch?: boolean; webkitPreservesPitch?: boolean };
    el.preservesPitch = true;
    if ('mozPreservesPitch' in anyEl) anyEl.mozPreservesPitch = true;
    if ('webkitPreservesPitch' in anyEl) anyEl.webkitPreservesPitch = true;
    const g = ctx.createGain();
    g.gain.value = gain;
    ctx.createMediaElementSource(el).connect(g).connect(this.master);
    return { el, gain: g };
  }

  /** Resolves once both tracks know their duration. */
  load(): Promise<void> {
    const ready = (el: HTMLAudioElement) =>
      new Promise<void>((resolve, reject) => {
        if (el.readyState >= 1) return resolve();
        const ok = () => {
          cleanup();
          resolve();
        };
        const bad = () => {
          cleanup();
          reject(new Error(el.error?.message || 'media error'));
        };
        const cleanup = () => {
          el.removeEventListener('loadedmetadata', ok);
          el.removeEventListener('error', bad);
        };
        el.addEventListener('loadedmetadata', ok);
        el.addEventListener('error', bad);
        el.load();
      });
    return Promise.all([ready(this.inst.el), this.ref ? ready(this.ref.el) : Promise.resolve()]).then(() => {
      this.smooth.reset(0, performance.now());
    });
  }

  /** The underlying media elements (instrumental first), for diagnostics and tests. */
  get media(): HTMLAudioElement[] {
    return this.ref ? [this.inst.el, this.ref.el] : [this.inst.el];
  }

  get duration(): number {
    const d = this.inst.el.duration;
    return Number.isFinite(d) ? d : 0;
  }

  get hasReference(): boolean {
    return this.ref !== null;
  }

  get paused(): boolean {
    return this.inst.el.paused;
  }

  get referenceOn(): boolean {
    return this.reference;
  }

  get speed(): number {
    return this.rate;
  }

  /** Current song time (s), smoothed for rendering. */
  get time(): number {
    const now = performance.now();
    this.smooth.sample(this.rawTime(), now);
    return this.smooth.now(now);
  }

  /** True when the reference is the only audible element (a full mix replacing the instrumental). */
  private get referenceLeads(): boolean {
    return this.reference && this.ref !== null && !this.layer;
  }

  /** Song time straight from the element that carries the backing. */
  rawTime(): number {
    if (this.referenceLeads) return this.ref!.el.currentTime - this.opts.referenceOffset;
    return this.inst.el.currentTime;
  }

  async play(): Promise<void> {
    await this.engine.resume();
    this.alignReference();
    const plays = [this.inst.el.play()];
    if (this.ref) plays.push(this.ref.el.play());
    try {
      await Promise.all(plays);
    } catch (e) {
      this.opts.onError?.(`Playback was blocked: ${(e as Error).message}`);
      return;
    }
    this.smooth.setPlaying(true, this.rawTime(), performance.now());
    this.ctxClock.reset();
    if (this.timer === null) this.timer = window.setInterval(() => this.tick(), 50);
  }

  pause(): void {
    this.inst.el.pause();
    this.ref?.el.pause();
    this.smooth.setPlaying(false, this.rawTime(), performance.now());
    this.ctxClock.reset();
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  seek(t: number): void {
    const d = this.duration || Infinity;
    const s = Math.max(0, Math.min(d, t));
    this.inst.el.currentTime = s;
    if (this.ref) this.ref.el.currentTime = Math.max(0, s + this.opts.referenceOffset);
    this.smooth.reset(s, performance.now());
    this.ctxClock.reset();
  }

  setRate(rate: number): void {
    this.rate = rate;
    this.inst.el.playbackRate = rate;
    if (this.ref) this.ref.el.playbackRate = rate;
    this.smooth.setRate(rate, performance.now());
    this.ctxClock.setRate(rate);
  }

  setReference(on: boolean): void {
    if (!this.ref) return;
    this.reference = on;
    const t = this.engine.ctx.currentTime;
    this.inst.gain.gain.setTargetAtTime(on && !this.layer ? 0 : 1, t, 0.03);
    this.ref.gain.gain.setTargetAtTime(on ? 1 : 0, t, 0.03);
    // The clock source changed elements; re-anchor so the switch is not seen as a jump.
    this.smooth.reset(this.rawTime(), performance.now());
  }

  setVolume(v: number): void {
    const c = Math.max(0, Math.min(1, v));
    this.master.gain.setTargetAtTime(c * c, this.engine.ctx.currentTime, 0.03);
  }

  setLoop(a: number | null, b: number | null, on: boolean): void {
    this.loopA = a;
    this.loopB = b;
    this.looping = on && a !== null && b !== null && b > a + 0.2;
  }

  get loop(): { a: number | null; b: number | null; on: boolean } {
    return { a: this.loopA, b: this.loopB, on: this.looping };
  }

  /** Song time for a microphone frame stamped at AudioContext time `ctxTime`. */
  songTimeAt(ctxTime: number): number {
    return this.ctxClock.songTimeAt(ctxTime);
  }

  /** AudioContext time at which song time `t` sounds (NaN until playing). */
  ctxTimeAt(t: number): number {
    return this.ctxClock.ctxTimeAt(t);
  }

  get clockReady(): boolean {
    return this.ctxClock.ready;
  }

  private alignReference(): void {
    if (!this.ref) return;
    const want = Math.max(0, this.inst.el.currentTime + this.opts.referenceOffset);
    if (Math.abs(this.ref.el.currentTime - want) > SYNC_TOLERANCE) this.ref.el.currentTime = want;
  }

  private tick(): void {
    if (this.destroyed || this.inst.el.paused) return;
    const now = performance.now();
    const raw = this.rawTime();
    this.smooth.sample(raw, now);
    this.ctxClock.sample(this.engine.ctx.currentTime, raw);
    if (this.looping && this.loopA !== null && this.loopB !== null && raw >= this.loopB) {
      this.seek(this.loopA);
      this.opts.onLoop?.();
      return;
    }
    // Keep the other element within tolerance of the one carrying the backing (never touch that one).
    if (this.ref && now - this.lastSync > 500) {
      this.lastSync = now;
      const drift = this.ref.el.currentTime - (this.inst.el.currentTime + this.opts.referenceOffset);
      if (Math.abs(drift) > SYNC_TOLERANCE) {
        if (this.referenceLeads) this.inst.el.currentTime = this.ref.el.currentTime - this.opts.referenceOffset;
        else this.ref.el.currentTime = this.inst.el.currentTime + this.opts.referenceOffset;
      }
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.pause();
    for (const t of [this.inst, this.ref]) {
      if (!t) continue;
      t.el.removeAttribute('src');
      t.el.load();
      t.gain.disconnect();
    }
    this.master.disconnect();
  }
}
