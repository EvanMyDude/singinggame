/// <reference types="node" />
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { assembleTake, frameAt, mixTake, PieceStore, songTimeAt, suggestVocalGain, toInt16, type CapturedFrame } from '../src/core/take';
import { encodeWav } from '../src/core/wav';
import { readWav } from './helpers/wav';

const SR = 48000;
const CHUNK = 512;

/**
 * Feeds `seconds` of a signal into a store in 512-sample chunks stamped with their
 * AudioContext start time, starting at `t0`, as the capture worklets do.
 */
function capture(store: PieceStore, t0: number, seconds: number, sample: (t: number, c: number) => number, channels = 1): void {
  const n = Math.round(seconds * SR);
  for (let i = 0; i < n; i += CHUNK) {
    const len = Math.min(CHUNK, n - i);
    const chs = Array.from({ length: channels }, (_, c) => Float32Array.from({ length: len }, (_, k) => sample(t0 + (i + k) / SR, c)));
    store.push(chs, t0 + i / SR);
  }
}

/** An impulse train: 1 at each listed time (to the nearest sample), else 0. */
const clicks = (times: number[]) => (t: number) => (times.some((c) => Math.abs(t - c) < 0.5 / SR) ? 0.5 : 0);

function peaks(x: Int16Array, channels: number, channel: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < x.length / channels; i++) if (Math.abs(x[i * channels + channel]!) > 8000) out.push(i);
  return out;
}

describe('take assembly', () => {
  it('puts the voice next to the music it answered, removing the round-trip latency', () => {
    const latency = 0.137;
    const beats = [10.5, 11.0, 11.5, 12.0];
    const music = new PieceStore(SR);
    const mic = new PieceStore(SR);
    // The music clicks on the beat; the singer claps on each click, heard and captured `latency` later.
    capture(music, 10, 3, clicks(beats), 2);
    capture(mic, 10, 3.5, clicks(beats.map((b) => b + latency)));
    const take = assembleTake([{ start: 10.2, end: 12.4 }], latency, mic, music, []);
    expect(take.musicChannels).toBe(2);
    expect(take.duration).toBeCloseTo(2.2, 6);
    const m = peaks(take.music!, 2, 0);
    const v = peaks(take.mic, 1, 0);
    expect(m.length).toBe(4);
    expect(v.length).toBe(4);
    // Within one sample (0.02 ms): the acceptance gate is 1 ms.
    m.forEach((s, i) => expect(Math.abs(s - v[i]!)).toBeLessThanOrEqual(1));
    expect(m[0]! / SR).toBeCloseTo(0.3, 3);
  });

  it('joins the spans of a paused session and leaves nothing from the pause', () => {
    const latency = 0.05;
    const music = new PieceStore(SR);
    const mic = new PieceStore(SR);
    capture(music, 0, 6, (t) => (t < 2 || t >= 4 ? 0.25 : 0.9));
    capture(mic, 0, 6.1, (t) => (t - latency < 2 || t - latency >= 4 ? 0.1 : 0.7));
    const take = assembleTake([{ start: 0.5, end: 2 }, { start: 4, end: 5 }], latency, mic, music, []);
    expect(take.duration).toBeCloseTo(2.5, 6);
    // The paused stretch (2 to 4 s) is loud in both streams; none of it may survive.
    expect(Math.max(...Array.from(take.music!, Math.abs))).toBe(toInt16(0.25));
    expect(Math.max(...Array.from(take.mic, Math.abs))).toBe(toInt16(0.1));
  });

  it('places voice frames on the take timeline with the song time they answered', () => {
    const latency = 0.1;
    const music = new PieceStore(SR);
    const mic = new PieceStore(SR);
    capture(music, 0, 4, () => 0, 1);
    capture(mic, 0, 4.2, () => 0);
    const frames: CapturedFrame[] = [
      { time: 0.6, songTime: 30.5, midi: 60 },
      { time: 1.6, songTime: NaN, midi: NaN },
      { time: 2.4, songTime: 35, midi: 62 }, // in the pause: dropped
      { time: 3.6, songTime: 40.1, midi: 64 },
    ];
    const take = assembleTake([{ start: 0.5, end: 2 }, { start: 3, end: 4 }], latency, mic, music, frames);
    expect(Array.from(take.frames.t)).toEqual([expect.closeTo(0, 6), expect.closeTo(1, 6), expect.closeTo(1.5 + 0.5, 6)]);
    expect(Array.from(take.frames.song)).toEqual([30.5, NaN, expect.closeTo(40.1, 4)]);
    expect(Array.from(take.frames.midi)).toEqual([60, NaN, 64]);
  });

  it('fills a gap in the capture with silence instead of shifting what follows', () => {
    const music = new PieceStore(SR);
    capture(music, 0, 1, () => 0.5);
    capture(music, 1.5, 1, () => 0.5);
    const x = music.extract(0, 2.5 * SR);
    expect(x[Math.round(1.25 * SR)]).toBe(0);
    expect(x[Math.round(1.75 * SR)]).toBe(toInt16(0.5));
    expect(x.length).toBe(2.5 * SR);
  });

  it('drops pieces before a time to bound memory', () => {
    const s = new PieceStore(SR);
    capture(s, 0, 2, () => 0.1);
    const before = s.byteLength;
    s.dropBefore(SR);
    expect(s.byteLength).toBeLessThan(before * 0.55);
    expect(s.extract(SR + 1000, SR + 1001)[0]).toBe(toInt16(0.1));
  });

  it('mixes the voice into every music channel at the chosen level', () => {
    const mic = Int16Array.from([1000, -1000, 30000]);
    const music = Int16Array.from([100, 200, 300, 400, 10000, -10000]);
    expect(Array.from(mixTake(mic, music, 2, 0.5))).toEqual([600, 700, -200, -100, 25000, 5000]);
    expect(Array.from(mixTake(mic, music, 2, 1))).toEqual([1100, 1200, -700, -600, 32767, 20000]);
    expect(Array.from(mixTake(mic, null, 0, 2))).toEqual([2000, -2000, 32767]);
  });
});

describe('WAV export', () => {
  it('writes 16-bit PCM that reads back sample for sample', () => {
    const samples = Int16Array.from({ length: 2000 }, (_, i) => Math.round(Math.sin(i / 7) * 20000));
    const dir = mkdtempSync(join(tmpdir(), 'wav-'));
    const path = join(dir, 'stereo.wav');
    writeFileSync(path, encodeWav(samples, 2, 44100));
    const back = readWav(path);
    expect(back.sr).toBe(44100);
    expect(back.samples.length).toBe(1000);
    // readWav averages channels.
    for (let i = 0; i < 1000; i++) expect(back.samples[i]).toBeCloseTo((samples[2 * i]! + samples[2 * i + 1]!) / 2 / 32768, 6);
  });
});

describe('review helpers', () => {
  it('suggests a voice level that brings quiet singing up to the music', () => {
    const music = Int16Array.from({ length: 48000 * 2 }, (_, i) => Math.round(8000 * Math.sin(i / 9)));
    const quiet = Int16Array.from({ length: 48000 }, (_, i) => (i % 20000 < 12000 ? Math.round(2000 * Math.sin(i / 5)) : 0));
    // 0.9 x the 4:1 level ratio, nudged up a little by blocks that straddle the end of a sung stretch.
    const g = suggestVocalGain(quiet, music, 2);
    expect(g).toBeGreaterThanOrEqual(3.6);
    expect(g).toBeLessThanOrEqual(3.8);
    expect(suggestVocalGain(quiet, null, 0)).toBe(1);
    const loud = Int16Array.from({ length: 48000 }, (_, i) => Math.round(20000 * Math.sin(i / 5)));
    expect(suggestVocalGain(loud, music, 2)).toBe(1);
  });

  it('finds the song time at a take time, through loop jumps', () => {
    const frames = {
      t: Float32Array.from([0, 0.01, 0.02, 0.03, 0.04]),
      song: Float32Array.from([NaN, 10, 10.01, 5, 5.01]),
      midi: new Float32Array(5),
    };
    expect(frameAt(frames.t, -0.001)).toBe(-1);
    expect(frameAt(frames.t, 0.025)).toBe(2);
    expect(songTimeAt(frames, 0.005)).toBeNaN();
    expect(songTimeAt(frames, 0.015)).toBeCloseTo(10.005, 4);
    // 0.02 -> 0.03 is a jump back (a loop): no interpolation across it.
    expect(songTimeAt(frames, 0.025)).toBeCloseTo(10.01, 4);
    expect(songTimeAt(frames, 0.035)).toBeCloseTo(5.005, 4);
  });
});
