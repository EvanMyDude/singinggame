import { assembleTake, PieceStore, type CapturedFrame, type Span, type TakeAudio } from '../core/take';
import { loadWorklet } from './mic';
import type { VoiceRuntime } from './voice';

/**
 * Records a session: the microphone and, when a song plays, the music exactly as it was heard
 * (a tap on the track player's output, after speed, loops and the reference toggle). Both are
 * stamped with AudioContext time, so core/take.ts can line them up with the same round-trip
 * latency the scorer removes. Recording is active in spans (while the song plays); only audio
 * that belongs to a span is kept.
 */

export interface RecorderOptions {
  /** Round-trip latency (s) the scorer uses; 0 when nothing is played back. */
  latency: number;
  /** The node carrying the music to record, or null for microphone only. */
  music: AudioNode | null;
  /** Longest take (s); the recorder stops itself there. */
  maxSeconds?: number;
  onLimit?: () => void;
}

export const MAX_TAKE_SECONDS = 20 * 60;

export class SessionRecorder {
  private readonly rt: VoiceRuntime;
  private readonly opts: RecorderOptions;
  private readonly micStore: PieceStore;
  private readonly musicStore: PieceStore | null;
  private readonly spans: Span[] = [];
  private openStart: number | null = null;
  private readonly frames: CapturedFrame[] = [];
  private readonly offMic: () => void;
  private tap: AudioNode | null = null;
  private sink: GainNode | null = null;
  private stopped = false;
  private limited = false;

  private constructor(rt: VoiceRuntime, opts: RecorderOptions) {
    this.rt = rt;
    this.opts = opts;
    const sr = rt.engine.ctx.sampleRate;
    this.micStore = new PieceStore(sr);
    this.musicStore = opts.music ? new PieceStore(sr) : null;
    this.offMic = rt.onChunk((d, t) => {
      if (this.inWindow(t, d.length, this.opts.latency)) this.micStore.push([d], t);
    });
  }

  /** Starts capturing (recording begins with the first active span). */
  static async create(rt: VoiceRuntime, opts: RecorderOptions): Promise<SessionRecorder> {
    const r = new SessionRecorder(rt, opts);
    if (opts.music) await r.attachTap(opts.music);
    return r;
  }

  private async attachTap(source: AudioNode): Promise<void> {
    const ctx = this.rt.engine.ctx;
    const store = this.musicStore!;
    const onChunk = (chs: Float32Array[], t: number) => {
      if (this.inWindow(t, chs[0]?.length ?? 0, 0)) store.push(chs, t);
    };
    let node: AudioNode;
    if (await loadWorklet(ctx)) {
      const w = new AudioWorkletNode(ctx, 'pitchhero-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCountMode: 'max' });
      w.port.onmessage = (e: MessageEvent<{ t: number; d: Float32Array[] }>) => onChunk(e.data.d, e.data.t);
      node = w;
    } else {
      const sp = ctx.createScriptProcessor(2048, 2, 1);
      sp.onaudioprocess = (e) => {
        const chs = Array.from({ length: e.inputBuffer.numberOfChannels }, (_, c) => new Float32Array(e.inputBuffer.getChannelData(c)));
        onChunk(chs, e.playbackTime - (2 * e.inputBuffer.length) / ctx.sampleRate);
      };
      node = sp;
    }
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    source.connect(node);
    node.connect(this.sink).connect(ctx.destination);
    this.tap = node;
  }

  /** True when a chunk [t, t + n) overlaps a span shifted by `shift` seconds. */
  private inWindow(t: number, n: number, shift: number): boolean {
    const end = t + n / this.rt.engine.ctx.sampleRate;
    if (this.openStart !== null && end > this.openStart + shift) return true;
    for (let i = this.spans.length - 1; i >= 0 && i >= this.spans.length - 3; i--) {
      const s = this.spans[i]!;
      if (end > s.start + shift && t < s.end + shift) return true;
    }
    return false;
  }

  /** Call with the playback state; transitions open and close spans at the current AudioContext time. */
  setActive(on: boolean): void {
    if (this.stopped || this.limited) return;
    const now = this.rt.engine.ctx.currentTime;
    if (on && this.openStart === null) this.openStart = now;
    else if (!on && this.openStart !== null) {
      if (now > this.openStart) this.spans.push({ start: this.openStart, end: now });
      this.openStart = null;
    }
    if (this.activeSeconds >= (this.opts.maxSeconds ?? MAX_TAKE_SECONDS)) {
      this.setActive(false);
      this.limited = true;
      this.opts.onLimit?.();
    }
  }

  /** A voice frame and the song time it answered (NaN without a song or before the clock settles). */
  addFrame(time: number, songTime: number, midi: number): void {
    if (!this.stopped) this.frames.push({ time, songTime, midi });
  }

  get recording(): boolean {
    return this.openStart !== null;
  }

  /** Seconds recorded so far. */
  get activeSeconds(): number {
    const closed = this.spans.reduce((s, x) => s + (x.end - x.start), 0);
    return closed + (this.openStart !== null ? Math.max(0, this.rt.engine.ctx.currentTime - this.openStart) : 0);
  }

  /**
   * Ends the take: closes the open span, waits for the microphone to deliver the last
   * `latency` seconds, detaches, and assembles the audio. Null when nothing was recorded.
   */
  async stop(): Promise<TakeAudio | null> {
    if (this.stopped) return null;
    this.setActive(false);
    this.stopped = true;
    // The microphone runs `latency` behind the music, plus a chunk of buffering.
    await new Promise((r) => setTimeout(r, (this.opts.latency + 0.15) * 1000));
    this.detach();
    if (!this.spans.length) return null;
    return assembleTake(this.spans, this.opts.latency, this.micStore, this.musicStore, this.frames);
  }

  /** Stops capturing and drops everything. */
  discard(): void {
    this.stopped = true;
    this.detach();
  }

  private detach(): void {
    this.offMic();
    if (this.tap) {
      if (this.tap instanceof AudioWorkletNode) this.tap.port.onmessage = null;
      try {
        this.opts.music?.disconnect(this.tap);
      } catch {
        /* already disconnected */
      }
      this.tap.disconnect();
      this.sink?.disconnect();
      this.tap = null;
    }
  }
}
