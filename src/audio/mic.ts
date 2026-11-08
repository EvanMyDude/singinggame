import type { AudioEngine } from './engine';

/**
 * Microphone capture. The AudioWorklet only copies samples into 512-sample chunks and stamps
 * each with the AudioContext time of its first sample; all analysis happens on the main
 * thread so heavy work can never cause audio dropouts. ScriptProcessor is a fallback for
 * browsers without AudioWorklet.
 */

const WORKLET_SRC = `
class PitchlineCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 512;
    this.buf = new Float32Array(this.size);
    this.n = 0;
    this.start = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      const ch = input[0];
      for (let i = 0; i < ch.length; i++) {
        if (this.n === 0) this.start = currentTime + i / sampleRate;
        this.buf[this.n++] = ch[i];
        if (this.n === this.size) {
          this.port.postMessage({ t: this.start, d: this.buf }, [this.buf.buffer]);
          this.buf = new Float32Array(this.size);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pitchline-capture', PitchlineCapture);
`;

const workletLoaded = new WeakMap<BaseAudioContext, Promise<boolean>>();

function loadWorklet(ctx: AudioContext): Promise<boolean> {
  let p = workletLoaded.get(ctx);
  if (!p) {
    p = (async () => {
      if (!ctx.audioWorklet) return false;
      const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
      try {
        await ctx.audioWorklet.addModule(url);
        return true;
      } catch {
        try {
          await ctx.audioWorklet.addModule(`data:application/javascript;base64,${btoa(WORKLET_SRC)}`);
          return true;
        } catch {
          return false;
        }
      } finally {
        URL.revokeObjectURL(url);
      }
    })();
    workletLoaded.set(ctx, p);
  }
  return p;
}

export type ChunkListener = (samples: Float32Array, startTime: number) => void;

export interface MicOpenOptions {
  deviceId?: string | null;
  /** Browser echo cancellation; only worth enabling when playing through speakers. */
  echoCancellation?: boolean;
}

export class MicError extends Error {
  constructor(
    readonly kind: 'denied' | 'notfound' | 'busy' | 'insecure' | 'unsupported' | 'unknown',
    message: string,
  ) {
    super(message);
  }
}

export class MicInput {
  private readonly engine: AudioEngine;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private highpass: BiquadFilterNode | null = null;
  private capture: AudioNode | null = null;
  private sink: GainNode | null = null;
  private monitor: GainNode | null = null;
  private readonly listeners = new Set<ChunkListener>();
  private openOpts: MicOpenOptions = {};
  usingWorklet = false;

  constructor(engine: AudioEngine) {
    this.engine = engine;
  }

  get isOpen(): boolean {
    return !!this.stream && this.stream.getAudioTracks().some((t) => t.readyState === 'live');
  }

  get track(): MediaStreamTrack | null {
    return this.stream?.getAudioTracks()[0] ?? null;
  }

  get deviceId(): string | null {
    return (this.track?.getSettings().deviceId as string | undefined) ?? null;
  }

  get label(): string {
    return this.track?.label || 'Microphone';
  }

  /** Input latency reported by the browser (s), if any. */
  get inputLatency(): number {
    const s = this.track?.getSettings() as MediaTrackSettings & { latency?: number };
    return typeof s?.latency === 'number' ? s.latency : 0;
  }

  get echoCancellation(): boolean {
    return !!this.openOpts.echoCancellation;
  }

  onChunk(cb: ChunkListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async open(opts: MicOpenOptions = {}): Promise<void> {
    if (!window.isSecureContext) {
      throw new MicError('insecure', 'Microphone access needs a secure page (https:// or http://localhost).');
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new MicError('unsupported', 'This browser does not support microphone input.');
    }
    this.close();
    this.openOpts = opts;
    const audio: MediaTrackConstraints = {
      echoCancellation: !!opts.echoCancellation,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: { ideal: 1 },
    };
    if (opts.deviceId) audio.deviceId = { exact: opts.deviceId };
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio });
    } catch (e) {
      const err = e as DOMException;
      if (err.name === 'OverconstrainedError' && opts.deviceId) {
        // Saved device disappeared; fall back to the default one.
        return this.open({ ...opts, deviceId: null });
      }
      if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
        throw new MicError('denied', 'Microphone permission was blocked. Allow it from the address bar, then try again.');
      }
      if (err.name === 'NotFoundError') throw new MicError('notfound', 'No microphone was found. Plug one in and try again.');
      if (err.name === 'NotReadableError') throw new MicError('busy', 'The microphone is in use by another app or could not be started.');
      throw new MicError('unknown', `Could not open the microphone (${err.name || 'error'}).`);
    }
    this.stream = stream;
    await this.engine.resume();
    const ctx = this.engine.ctx;
    this.source = ctx.createMediaStreamSource(stream);
    this.highpass = ctx.createBiquadFilter();
    this.highpass.type = 'highpass';
    this.highpass.frequency.value = 50;
    this.highpass.Q.value = 0.6;
    this.source.connect(this.highpass);

    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.sink.connect(ctx.destination);

    this.usingWorklet = await loadWorklet(ctx);
    if (this.usingWorklet) {
      const node = new AudioWorkletNode(ctx, 'pitchline-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
      });
      node.port.onmessage = (e: MessageEvent<{ t: number; d: Float32Array }>) => this.emit(e.data.d, e.data.t);
      this.capture = node;
    } else {
      const sp = ctx.createScriptProcessor(512, 1, 1);
      sp.onaudioprocess = (e) => {
        const d = new Float32Array(e.inputBuffer.getChannelData(0));
        this.emit(d, e.playbackTime - (2 * d.length) / ctx.sampleRate);
      };
      this.capture = sp;
    }
    this.highpass.connect(this.capture);
    this.capture.connect(this.sink);

    this.monitor = ctx.createGain();
    this.monitor.gain.value = 0;
    this.source.connect(this.monitor).connect(this.engine.out);

    stream.getAudioTracks()[0]?.addEventListener('ended', () => this.close());
  }

  private emit(d: Float32Array, t: number): void {
    for (const l of this.listeners) l(d, t);
  }

  setMonitoring(on: boolean, volume: number): void {
    if (!this.monitor) return;
    this.monitor.gain.setTargetAtTime(on ? Math.max(0, Math.min(1, volume)) ** 2 : 0, this.engine.ctx.currentTime, 0.03);
  }

  close(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    for (const n of [this.source, this.highpass, this.capture, this.sink, this.monitor]) n?.disconnect();
    if (this.capture instanceof AudioWorkletNode) this.capture.port.onmessage = null;
    this.source = this.highpass = this.capture = this.sink = this.monitor = null;
  }
}

export async function listMics(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === 'audioinput');
}
