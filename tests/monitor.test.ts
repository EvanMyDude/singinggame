import { describe, expect, it } from 'vitest';
import {
  MAX_MIDI,
  MIN_MIDI,
  centsFromNearest,
  clampView,
  defaultView,
  followView,
  shiftView,
  viewLabel,
  zoomView,
} from '../src/ui/render/pitchGraph';

describe('pitch monitor view', () => {
  it('defaults to C2-C5 without a measured range', () => {
    expect(defaultView(null)).toEqual({ low: 36, high: 72 });
    expect(viewLabel(defaultView(null))).toBe('C2–C5');
  });

  it('fits a measured range with air on both sides', () => {
    const v = defaultView({ low: 45, high: 62 });
    expect(v.low).toBeLessThanOrEqual(40);
    expect(v.high).toBeGreaterThanOrEqual(67);
  });

  it('zooms in and out through fixed spans around the center', () => {
    const v = { low: 36, high: 72 };
    const zin = zoomView(v, 1);
    expect(zin.high - zin.low).toBe(30);
    expect((zin.low + zin.high) / 2).toBe(54);
    const zout = zoomView(v, -1);
    expect(zout.high - zout.low).toBe(48);
    let tight = v;
    for (let i = 0; i < 10; i++) tight = zoomView(tight, 1);
    expect(tight.high - tight.low).toBe(12);
  });

  it('shifts and clamps to the supported pitch range', () => {
    expect(shiftView({ low: 36, high: 72 }, 2)).toEqual({ low: 38, high: 74 });
    expect(shiftView({ low: 36, high: 72 }, -40)).toEqual({ low: MIN_MIDI, high: MIN_MIDI + 36 });
    expect(clampView({ low: 90, high: 126 })).toEqual({ low: MAX_MIDI - 36, high: MAX_MIDI });
  });

  it('follows a voice that leaves the view, moving as little as possible', () => {
    const v = { low: 48, high: 60 };
    expect(followView(v, 54)).toBe(v);
    expect(followView(v, 61.3)).toEqual({ low: 52, high: 64 });
    expect(followView(v, 45)).toEqual({ low: 43, high: 55 });
  });

  it('measures cents from the nearest note', () => {
    expect(centsFromNearest(48.34)).toBeCloseTo(34, 6);
    expect(centsFromNearest(47.8)).toBeCloseTo(-20, 6);
  });
});
