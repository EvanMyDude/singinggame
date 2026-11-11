import { describe, expect, it } from 'vitest';
import melody from '../public/songs/old-town-road/melody.json';
import { TARGET_FREE_DELAY_SECONDS, TargetAvailability } from '../src/core/targetAvailability';

describe('playback target availability', () => {
  it('uses the union of target windows expanded by the scorer’s 100 ms tolerance', () => {
    const status = new TargetAvailability([{ t: 1, d: 0.5 }, { t: 1.6, d: 0.4 }, { t: 1.8, d: 0.5 }]);
    expect(status.hasTargetAt(0.8999)).toBe(false);
    expect(status.hasTargetAt(0.9)).toBe(true);
    expect(status.hasTargetAt(1.55)).toBe(true); // short raw gap, joined after expansion
    expect(status.hasTargetAt(2.4)).toBe(true);
    expect(status.hasTargetAt(2.4001)).toBe(false);
  });

  it('delays the free state and removes it immediately at the next target', () => {
    const status = new TargetAvailability([{ t: 3, d: 1 }]);
    expect(status.update(0, true)).toBe(false);
    expect(status.update(TARGET_FREE_DELAY_SECONDS - 0.001, true)).toBe(false);
    expect(status.update(TARGET_FREE_DELAY_SECONDS, true)).toBe(true);
    expect(status.update(2.9, true)).toBe(false);
    expect(status.update(3.5, true)).toBe(false);
  });

  it('keeps a silent microphone in target status during scorable passages', () => {
    // There is intentionally no voice-frame input: rendering follows playback alone.
    const status = new TargetAvailability([{ t: 1, d: 3 }]);
    for (let t = 1; t <= 4; t += 0.25) expect(status.update(t, true)).toBe(false);
  });

  it('never flashes free singing in short inter-note gaps', () => {
    const status = new TargetAvailability([{ t: 0, d: 1 }, { t: 1.7, d: 1 }]);
    expect(status.update(1, true)).toBe(false);
    expect(status.update(1.101, true)).toBe(false);
    expect(status.update(1.59, true)).toBe(false);
    expect(status.update(1.6, true)).toBe(false);
  });

  it('counts an intervening target even when rendering skips over its whole window', () => {
    const status = new TargetAvailability([{ t: 2, d: 0.2 }]);
    expect(status.update(0, true)).toBe(false);
    expect(status.update(1, true)).toBe(true);
    expect(status.update(2.6, true)).toBe(false);
    expect(status.update(3.1, true)).toBe(true);
  });

  it('resets after pause/resume, restart, and forward practice seeks', () => {
    const status = new TargetAvailability([]);
    expect(status.update(10, true)).toBe(false);
    expect(status.update(11, true)).toBe(true);
    expect(status.update(11, false)).toBe(false);
    expect(status.update(11, true)).toBe(false);
    expect(status.update(11.749, true)).toBe(false);
    expect(status.update(11.75, true)).toBe(true);
    status.reset(); // restart/seek transport hook
    expect(status.update(60, true)).toBe(false);
    expect(status.update(60.75, true)).toBe(true);
    expect(status.update(0, true)).toBe(false); // backward-loop fallback
  });

  it.each([
    [45.175, 50.376],
    [51.351, 57.551],
    [73.004, 78.797],
    [80.086, 84.277],
  ])('explains the reported pack gap from %s to %s using playback time', (end, next) => {
    const status = new TargetAvailability(melody.notes);
    expect(status.update(end + 0.099, true)).toBe(false);
    expect(status.update(end + 0.101, true)).toBe(false);
    expect(status.update(end + 0.849, true)).toBe(false);
    expect(status.update(end + 0.852, true)).toBe(true);
    expect(status.update(next - 0.099, true)).toBe(false);
  });
});
