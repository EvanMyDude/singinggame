import { describe, expect, it } from 'vitest';
import { CtxClock, SmoothClock } from '../src/audio/songClock';

describe('SmoothClock', () => {
  it('extrapolates smoothly between stepped media readings', () => {
    const c = new SmoothClock();
    c.setPlaying(true, 10, 0);
    // Media time updates every 250 ms in steps; the clock should still move every frame.
    const out: number[] = [];
    for (let ms = 16; ms <= 1000; ms += 16) {
      if (ms % 250 === 0) c.sample(10 + ms / 1000, ms);
      out.push(c.now(ms));
    }
    for (let i = 1; i < out.length; i++) expect(out[i]).toBeGreaterThanOrEqual(out[i - 1]!);
    expect(out[out.length - 1]).toBeCloseTo(11, 1);
  });
  it('honors the playback rate and resets on seeks', () => {
    const c = new SmoothClock();
    c.setPlaying(true, 0, 0);
    c.setRate(0.5, 0);
    expect(c.now(1000)).toBeCloseTo(0.5, 6);
    c.sample(30, 1016); // a seek: far from the prediction
    expect(c.now(1016)).toBeCloseTo(30, 6);
  });
  it('holds still while paused', () => {
    const c = new SmoothClock();
    c.setPlaying(false, 7, 0);
    expect(c.now(5000)).toBe(7);
  });
});

describe('CtxClock', () => {
  it('maps context time to song time from jittery samples', () => {
    const c = new CtxClock();
    expect(c.ready).toBe(false);
    const jitter = [0.012, -0.01, 0.004, 0.02, -0.015, 0.001, 0.008, -0.004, 0.003];
    jitter.forEach((j, i) => c.sample(100 + i * 0.1, 5 + i * 0.1 + j));
    expect(c.songTimeAt(101)).toBeCloseTo(6, 1);
    expect(c.ctxTimeAt(6)).toBeCloseTo(101, 1);
  });
  it('accounts for the playback rate', () => {
    const c = new CtxClock();
    c.setRate(0.5);
    c.sample(10, 20);
    expect(c.songTimeAt(12)).toBeCloseTo(21, 9);
  });
});
