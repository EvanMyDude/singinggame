import { arrange, countIn } from '../core/arrange';
import type { Song } from '../core/song';
import type { AudioEngine, Buses } from './engine';
import { playDrum, playLead, playTone } from './synth';

/**
 * Lookahead scheduler ("A Tale of Two Clocks" pattern): a 25 ms timer schedules every event
 * due in the next 200 ms at exact AudioContext times. Supports a beat window, looping with
 * a count-in bar between passes, and per-part muting.
 */

type Ev =
  | { beat: number; kind: 'tone'; part: 'bass' | 'keys' | 'pad'; midi: number; beats: number; vel: number }
  | { beat: number; kind: 'lead'; midi: number; beats: number }
  | { beat: number; kind: 'drum'; drum: Parameters<typeof playDrum>[2]; vel: number; bus: 'backing' | 'click' };

export interface PlayerOptions {
  speed: number;
  /** Section window in beats. */
  fromBeat: number;
  toBeat: number;
  loop: boolean;
  guide: boolean;
  backing: boolean;
}

export interface Pass {
  index: number;
  /** AudioContext time at which `fromBeat` sounds. */
  t0: number;
  /** AudioContext time at which the count-in starts. */
  countInStart: number;
  /** AudioContext time at which the pass ends (after `toBeat`). */
  end: number;
}

export class SongPlayer {
  readonly secPerBeat: number;
  readonly opts: PlayerOptions;
  readonly countInBeats: number;
  private readonly engine: AudioEngine;
  private readonly events: Ev[];
  private session: ReturnType<AudioEngine['openSession']> | null = null;
  private timer: number | null = null;
  private passIndex = 0;
  private cursor = 0;
  private passes: Pass[] = [];
  private stopped = false;
  onPass: (pass: Pass) => void = () => {};
  onEnd: () => void = () => {};

  constructor(engine: AudioEngine, song: Song, opts: PlayerOptions) {
    this.engine = engine;
    this.opts = opts;
    this.secPerBeat = 60 / (song.bpm * opts.speed);
    const { fromBeat, toBeat } = opts;
    const inWindow = (b: number) => b >= fromBeat - 1e-9 && b < toBeat - 1e-9;
    const arr = arrange(song);
    const evs: Ev[] = [];
    for (const t of arr.tones) {
      if (inWindow(t.beat)) evs.push({ beat: t.beat, kind: 'tone', part: t.part, midi: t.midi, beats: Math.min(t.beats, toBeat - t.beat), vel: t.vel });
    }
    for (const d of arr.drums) if (inWindow(d.beat)) evs.push({ beat: d.beat, kind: 'drum', drum: d.kind, vel: d.vel, bus: 'backing' });
    for (const n of song.notes) if (inWindow(n.start)) evs.push({ beat: n.start, kind: 'lead', midi: n.midi, beats: n.beats });
    const clicks = countIn(song, fromBeat);
    for (const c of clicks) evs.push({ beat: c.beat, kind: 'drum', drum: c.kind, vel: c.vel, bus: 'click' });
    evs.sort((a, b) => a.beat - b.beat);
    this.events = evs;
    this.countInBeats = fromBeat - (clicks[0]?.beat ?? fromBeat);
  }

  /** Length of one pass, count-in included, in beats. */
  get passBeats(): number {
    return this.countInBeats + (this.opts.toBeat - this.opts.fromBeat);
  }

  get currentPasses(): readonly Pass[] {
    return this.passes;
  }

  start(lead = 0.12): Pass {
    this.session = this.engine.openSession();
    this.session.setMute('melody', !this.opts.guide);
    this.session.setMute('backing', !this.opts.backing);
    const startAt = this.engine.ctx.currentTime + lead;
    this.passIndex = 0;
    this.cursor = 0;
    this.passes = [this.makePass(0, startAt)];
    this.tick();
    this.timer = window.setInterval(() => this.tick(), 25);
    this.onPass(this.passes[0]!);
    return this.passes[0]!;
  }

  private makePass(index: number, countInStart: number): Pass {
    const spb = this.secPerBeat;
    const t0 = countInStart + this.countInBeats * spb;
    return { index, t0, countInStart, end: t0 + (this.opts.toBeat - this.opts.fromBeat) * spb };
  }

  setGuide(on: boolean): void {
    this.opts.guide = on;
    this.session?.setMute('melody', !on);
  }

  setBacking(on: boolean): void {
    this.opts.backing = on;
    this.session?.setMute('backing', !on);
  }

  get buses(): Buses | null {
    return this.session?.buses ?? null;
  }

  private tick(): void {
    if (this.stopped || !this.session) return;
    const ctx = this.engine.ctx;
    const horizon = ctx.currentTime + 0.2;
    const spb = this.secPerBeat;
    const buses = this.session.buses;
    for (;;) {
      const pass = this.passes[this.passIndex]!;
      if (this.cursor >= this.events.length) {
        if (this.opts.loop) {
          const next = this.makePass(this.passIndex + 1, pass.end);
          if (next.countInStart > horizon) break;
          this.passes.push(next);
          this.passIndex++;
          this.cursor = 0;
          this.onPass(next);
          continue;
        }
        if (ctx.currentTime > pass.end + 0.3) {
          this.finish();
        }
        break;
      }
      const ev = this.events[this.cursor]!;
      let when = pass.t0 + (ev.beat - this.opts.fromBeat) * spb;
      if (when > horizon) break;
      this.cursor++;
      if (when < ctx.currentTime - 0.05) continue; // timer stalled; drop rather than pile up
      when = Math.max(when, ctx.currentTime);
      switch (ev.kind) {
        case 'tone':
          playTone(this.engine, buses.backing, ev.part, ev.midi, when, ev.beats * spb, ev.vel);
          break;
        case 'lead':
          playLead(this.engine, buses.melody, ev.midi, when, ev.beats * spb, 0.55);
          break;
        case 'drum':
          playDrum(this.engine, ev.bus === 'click' ? buses.click : buses.backing, ev.drum, when, ev.vel);
          break;
      }
    }
  }

  private finish(): void {
    if (this.stopped) return;
    this.stop(0.4);
    this.onEnd();
  }

  stop(fade = 0.06): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.session?.close(fade);
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  /** Pass and beat (relative to the song) for an AudioContext time. */
  locate(ctxTime: number): { pass: Pass; beat: number } {
    let p = this.passes[0]!;
    for (const q of this.passes) if (q.countInStart <= ctxTime) p = q;
    return { pass: p, beat: this.opts.fromBeat + (ctxTime - p.t0) / this.secPerBeat };
  }
}
