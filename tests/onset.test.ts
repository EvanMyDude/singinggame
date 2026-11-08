import { describe, expect, it } from 'vitest';
import { OnsetDetector, estimateLatency } from '../src/audio/onset';
import { mulberry32 } from './helpers/signals';

const sr = 48000;

function clapTrack(clickTimes: number[], latency: number, jitter: number, seed = 1, noiseFloor = 0.002): Float32Array {
  const rand = mulberry32(seed);
  const total = Math.ceil((clickTimes[clickTimes.length - 1]! + 1) * sr);
  const out = new Float32Array(total);
  for (let i = 0; i < total; i++) out[i] = noiseFloor * (rand() * 2 - 1);
  for (const c of clickTimes) {
    const at = c + latency + (rand() * 2 - 1) * jitter;
    const s0 = Math.round(at * sr);
    for (let k = 0; k < sr * 0.08 && s0 + k < total; k++) {
      out[s0 + k]! += 0.6 * Math.exp(-k / (sr * 0.012)) * (rand() * 2 - 1);
    }
  }
  return out;
}

function detectAll(sig: Float32Array, startTime = 0) {
  const det = new OnsetDetector(sr);
  const onsets: number[] = [];
  for (let i = 0; i < sig.length; i += 512) onsets.push(...det.push(sig.subarray(i, i + 512), startTime + i / sr));
  return onsets;
}

describe('latency calibration', () => {
  const clicks = Array.from({ length: 8 }, (_, i) => 1 + i * 0.6667);

  it('locates clap onsets to within ~2 ms', () => {
    const sig = clapTrack(clicks, 0, 0);
    const onsets = detectAll(sig);
    expect(onsets).toHaveLength(8);
    onsets.forEach((o, i) => expect(Math.abs(o - clicks[i]!)).toBeLessThan(0.002));
  });

  it('estimates round-trip latency from claps with human jitter', () => {
    const sig = clapTrack(clicks, 0.135, 0.02, 4);
    const est = estimateLatency(clicks, detectAll(sig));
    expect(est).not.toBeNull();
    expect(Math.abs(est!.latency - 0.135)).toBeLessThan(0.015);
    expect(est!.hits).toBe(8);
  });

  it('refuses to guess when too few clicks were answered', () => {
    const sig = clapTrack(clicks.slice(0, 3), 0.1, 0.01);
    expect(estimateLatency(clicks, detectAll(sig))).toBeNull();
  });
});
