/**
 * The audio of a recorded session, assembled from what was captured. Pure, so the alignment
 * can be tested without a browser.
 *
 * Two streams are captured in AudioContext time: the microphone and, when a song plays, a tap
 * on the music exactly as it was heard (speed, loops, seeks and the reference toggle
 * included). A sound the singer heard at AudioContext time T comes back through the
 * microphone at T + latency, the same round-trip latency the scorer removes, so the take puts
 * microphone time t next to music time t - latency.
 *
 * Recording is active in spans (playback running); between spans nothing is kept. A span
 * [a, b] keeps music from a to b and microphone from a + latency to b + latency, and the take
 * is the spans one after another.
 */

/** One stream's captured audio: pieces at their absolute sample position on the AudioContext clock. */
export class PieceStore {
  readonly sampleRate: number;
  /** Interleaved channels per sample; 0 until the first piece. */
  channels = 0;
  private pieces: { at: number; data: Int16Array }[] = [];
  private bytes = 0;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
  }

  /** Adds a chunk whose first sample was at AudioContext time `t`; channels are planar float. */
  push(channels: readonly Float32Array[], t: number): void {
    const n = channels[0]?.length ?? 0;
    if (!n) return;
    const ch = channels.length;
    if (!this.channels) this.channels = ch;
    const data = new Int16Array(n * this.channels);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < this.channels; c++) data[i * this.channels + c] = toInt16(channels[Math.min(c, ch - 1)]![i]!);
    }
    this.pieces.push({ at: Math.round(t * this.sampleRate), data });
    this.bytes += data.byteLength;
  }

  /** Drops pieces that end before absolute sample `before` (outside every span still to come). */
  dropBefore(before: number): void {
    const ch = Math.max(1, this.channels);
    let k = 0;
    while (k < this.pieces.length && this.pieces[k]!.at + this.pieces[k]!.data.length / ch <= before) {
      this.bytes -= this.pieces[k]!.data.byteLength;
      k++;
    }
    if (k) this.pieces = this.pieces.slice(k);
  }

  get byteLength(): number {
    return this.bytes;
  }

  /** Samples [from, to) on the absolute timeline, interleaved; gaps are silence. */
  extract(from: number, to: number, channels = this.channels || 1): Int16Array {
    const n = Math.max(0, to - from);
    const out = new Int16Array(n * channels);
    const ch = this.channels || channels;
    for (const p of this.pieces) {
      const len = p.data.length / ch;
      const a = Math.max(from, p.at);
      const b = Math.min(to, p.at + len);
      for (let s = a; s < b; s++) {
        for (let c = 0; c < channels; c++) out[(s - from) * channels + c] = p.data[(s - p.at) * ch + Math.min(c, ch - 1)]!;
      }
    }
    return out;
  }
}

export function toInt16(v: number): number {
  const x = Math.max(-1, Math.min(1, v));
  return x < 0 ? Math.round(x * 32768) : Math.round(x * 32767);
}

export interface Span {
  /** AudioContext seconds, on the music's clock. */
  start: number;
  end: number;
}

export interface CapturedFrame {
  /** AudioContext time of the microphone frame. */
  time: number;
  /** Song time the singer was responding to; NaN when unknown (no song, or before the clock settled). */
  songTime: number;
  /** Display pitch (MIDI); NaN when unvoiced. */
  midi: number;
}

export interface TakeAudio {
  sampleRate: number;
  /** Microphone, mono. */
  mic: Int16Array;
  /** Music as heard, interleaved; null without a song. */
  music: Int16Array | null;
  musicChannels: number;
  /** Seconds. */
  duration: number;
  /** Per frame: take time (s), song time (s, NaN unknown), display pitch (NaN unvoiced). */
  frames: { t: Float32Array; song: Float32Array; midi: Float32Array };
}

/**
 * The take: each span's music [a, b] and microphone [a + latency, b + latency], one span
 * after another, plus the voice frames placed on the take's own timeline.
 */
export function assembleTake(spans: readonly Span[], latency: number, mic: PieceStore, music: PieceStore | null, frames: readonly CapturedFrame[]): TakeAudio {
  const sr = mic.sampleRate;
  const L = Math.round(latency * sr);
  const bounds = spans.map((s) => ({ a: Math.round(s.start * sr), b: Math.round(s.end * sr) })).filter((s) => s.b > s.a);
  const total = bounds.reduce((n, s) => n + (s.b - s.a), 0);
  const musicChannels = music && music.channels ? music.channels : music ? 1 : 0;
  const micOut = new Int16Array(total);
  const musicOut = music ? new Int16Array(total * musicChannels) : null;
  let o = 0;
  const placed: { t: number; song: number; midi: number }[] = [];
  for (const { a, b } of bounds) {
    micOut.set(mic.extract(a + L, b + L, 1), o);
    if (music && musicOut) musicOut.set(music.extract(a, b, musicChannels), o * musicChannels);
    for (const f of frames) {
      // The frame's music-clock time is its microphone time minus the latency.
      const s = Math.round(f.time * sr) - L;
      if (s >= a && s < b) placed.push({ t: (o + s - a) / sr, song: f.songTime, midi: f.midi });
    }
    o += b - a;
  }
  placed.sort((x, y) => x.t - y.t);
  return {
    sampleRate: sr,
    mic: micOut,
    music: musicOut,
    musicChannels,
    duration: total / sr,
    frames: {
      t: Float32Array.from(placed, (p) => p.t),
      song: Float32Array.from(placed, (p) => p.song),
      midi: Float32Array.from(placed, (p) => p.midi),
    },
  };
}

/** Music plus the voice at `vocalGain`, interleaved with the music's channels (mono without music). */
export function mixTake(mic: Int16Array, music: Int16Array | null, musicChannels: number, vocalGain = 1, musicGain = 1): Int16Array {
  if (!music || !musicChannels) {
    const out = new Int16Array(mic.length);
    for (let i = 0; i < mic.length; i++) out[i] = clamp16(mic[i]! * vocalGain);
    return out;
  }
  const n = mic.length;
  const out = new Int16Array(n * musicChannels);
  for (let i = 0; i < n; i++) {
    const v = mic[i]! * vocalGain;
    for (let c = 0; c < musicChannels; c++) out[i * musicChannels + c] = clamp16(music[i * musicChannels + c]! * musicGain + v);
  }
  return out;
}

function clamp16(v: number): number {
  return v > 32767 ? 32767 : v < -32768 ? -32768 : Math.round(v);
}

/**
 * A voice level that sits the singing just under the music: the power of the voice where it
 * is sung (blocks above -40 dBFS) against the power of the music where it plays. Between 1 and
 * 6; 1 without music or without singing.
 */
export function suggestVocalGain(mic: Int16Array, music: Int16Array | null, musicChannels: number): number {
  if (!music || !musicChannels) return 1;
  const B = 1024;
  const gate = (10 ** (-40 / 20) * 32768) ** 2;
  const power = (x: Int16Array, step: number) => {
    let sum = 0;
    let n = 0;
    for (let i = 0; i + B * step <= x.length; i += B * step) {
      let p = 0;
      for (let k = 0; k < B * step; k += step) p += x[i + k]! * x[i + k]!;
      p /= B;
      if (p > gate) {
        sum += p;
        n++;
      }
    }
    return n ? sum / n : 0;
  };
  const v = power(mic, 1);
  const m = power(music, musicChannels);
  if (!v || !m) return 1;
  return Math.min(6, Math.max(1, Math.round(0.9 * Math.sqrt(m / v) * 10) / 10));
}

/** Index of the last frame at or before take time `t`; -1 before the first. */
export function frameAt(times: ArrayLike<number>, t: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/**
 * Song time heard at take time `t`, interpolated between the frames around it; NaN where the
 * take has no song time (a microphone-only take, or before the song's clock settled).
 */
export function songTimeAt(frames: TakeAudio['frames'], t: number): number {
  const i = frameAt(frames.t, t);
  if (i < 0) return NaN;
  const a = frames.song[i]!;
  const j = i + 1;
  if (j >= frames.t.length || !Number.isFinite(a)) return a;
  const b = frames.song[j]!;
  const dt = frames.t[j]! - frames.t[i]!;
  // A seek or loop jump between the two frames: hold the earlier one.
  if (!Number.isFinite(b) || dt <= 0 || Math.abs(b - a) > 4 * dt + 0.05) return a;
  return a + ((b - a) * (t - frames.t[i]!)) / dt;
}
