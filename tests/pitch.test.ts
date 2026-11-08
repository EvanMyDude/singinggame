import { describe, expect, it } from 'vitest';
import { FFT } from '../src/audio/pitch/fft';
import { MpmDetector } from '../src/audio/pitch/mpm';
import { PitchTracker, median } from '../src/audio/pitch/tracker';
import { hzToMidi } from '../src/core/music';
import { concat, noise, sine, voice } from './helpers/signals';

const cents = (hz: number, ref: number) => 1200 * Math.log2(hz / ref);

describe('FFT', () => {
  it('matches a direct DFT', () => {
    const n = 64;
    const fft = new FFT(n);
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    const src: number[] = [];
    for (let i = 0; i < n; i++) {
      src.push(Math.sin(i * 0.7) + 0.3 * Math.cos(i * 2.1) + (i % 5) * 0.1);
      re[i] = src[i]!;
    }
    fft.transform(re, im);
    for (let k = 0; k < n; k++) {
      let dr = 0;
      let di = 0;
      for (let t = 0; t < n; t++) {
        dr += src[t]! * Math.cos((-2 * Math.PI * k * t) / n);
        di += src[t]! * Math.sin((-2 * Math.PI * k * t) / n);
      }
      expect(re[k]).toBeCloseTo(dr, 9);
      expect(im[k]).toBeCloseTo(di, 9);
    }
  });

  it('round-trips through the inverse', () => {
    const n = 256;
    const fft = new FFT(n);
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.sin(i * 0.37) * (i % 7);
    const orig = Float64Array.from(re);
    fft.transform(re, im);
    fft.transform(re, im, true);
    for (let i = 0; i < n; i++) expect(re[i]! / n).toBeCloseTo(orig[i]!, 9);
  });

  it('rejects non power-of-two sizes', () => {
    expect(() => new FFT(100)).toThrow();
  });
});

describe('MpmDetector', () => {
  for (const sr of [44100, 48000]) {
    const det = new MpmDetector(sr, 2048);
    const freqs = [65.41, 82.41, 110, 196, 261.63, 329.63, 440, 659.25, 880, 1046.5];

    it(`detects pure sines within 2 cents @${sr}`, () => {
      for (const f of freqs) {
        const est = det.detect(sine(f, sr, 2048));
        expect(Math.abs(cents(est.hz, f)), `sine ${f}`).toBeLessThan(2);
        expect(est.clarity).toBeGreaterThan(0.95);
      }
    });

    it(`detects voice-like tones (harmonic-rich) within 3 cents @${sr}`, () => {
      for (const f of freqs) {
        const est = det.detect(voice(f, sr, 2048));
        expect(Math.abs(cents(est.hz, f)), `voice ${f}`).toBeLessThan(3);
        expect(est.clarity).toBeGreaterThan(0.9);
      }
    });

    it(`finds the fundamental when it is missing (no octave-up error) @${sr}`, () => {
      for (const f of [98, 130.81, 220, 293.66]) {
        const est = det.detect(voice(f, sr, 2048, { dropFundamental: true }));
        expect(Math.abs(cents(est.hz, f)), `missing-fundamental ${f}`).toBeLessThan(5);
      }
    });

    it(`stays accurate with moderate noise @${sr}`, () => {
      for (const f of [130.81, 220, 440]) {
        const est = det.detect(voice(f, sr, 2048, { noise: 0.03, seed: Math.round(f) }));
        expect(Math.abs(cents(est.hz, f)), `noisy ${f}`).toBeLessThan(8);
      }
    });
  }

  it('reports low clarity for white noise', () => {
    const det = new MpmDetector(48000, 2048);
    for (let seed = 1; seed <= 10; seed++) {
      const est = det.detect(noise(48000, 2048, 0.3, seed));
      expect(est.clarity).toBeLessThan(0.8);
    }
  });

  it('reports nothing for silence', () => {
    const det = new MpmDetector(48000, 2048);
    const est = det.detect(new Float32Array(2048));
    expect(est.hz).toBe(0);
    expect(est.clarity).toBe(0);
  });
});

describe('PitchTracker', () => {
  const sr = 48000;

  function run(tracker: PitchTracker, signal: Float32Array, chunk = 512, t0 = 10) {
    const frames = [];
    for (let i = 0; i + chunk <= signal.length; i += chunk) {
      frames.push(...tracker.push(signal.subarray(i, i + chunk), t0 + i / sr));
    }
    return frames;
  }

  it('emits one frame per hop once the window is full, stamped at window center', () => {
    const tr = new PitchTracker(sr);
    const sig = voice(220, sr, sr); // 1 s
    const frames = run(tr, sig);
    // First frame after 2048 samples, then every 512.
    expect(frames.length).toBe(Math.floor((sr - 2048) / 512) + 1);
    const first = frames[0]!;
    expect(first.time).toBeCloseTo(10 + 2048 / sr - 1024 / sr, 6);
    expect(frames[1]!.time - first.time).toBeCloseTo(512 / sr, 6);
  });

  it('tracks a held note and reports it as voiced', () => {
    const tr = new PitchTracker(sr);
    const frames = run(tr, voice(196, sr, sr, { vibratoCents: 0 }));
    const voiced = frames.filter((f) => f.voiced);
    expect(voiced.length).toBe(frames.length);
    for (const f of voiced) expect(Math.abs((f.midi - hzToMidi(196)) * 100)).toBeLessThan(3);
  });

  it('gates out quiet input and noise', () => {
    const tr = new PitchTracker(sr, { gateDb: -40 });
    const quiet = run(tr, voice(220, sr, sr / 2, { amp: 0.003 }));
    expect(quiet.every((f) => !f.voiced)).toBe(true);
    const tr2 = new PitchTracker(sr, { gateDb: -60 });
    const hiss = run(tr2, noise(sr, sr / 2, 0.2));
    expect(hiss.filter((f) => f.voiced).length).toBeLessThan(hiss.length * 0.1);
  });

  it('follows a note change quickly (under ~60 ms to settle)', () => {
    const tr = new PitchTracker(sr);
    const a = voice(220, sr, sr / 2);
    const b = voice(293.66, sr, sr / 2);
    const frames = run(tr, concat(a, b), 512, 0);
    const changeAt = 0.5;
    const target = hzToMidi(293.66);
    const settled = frames.find((f) => f.time > changeAt && f.voiced && Math.abs(f.midi - target) < 0.15);
    expect(settled).toBeDefined();
    expect(settled!.time - changeAt).toBeLessThan(0.06);
  });

  it('median removes a single-frame octave glitch', () => {
    expect(median([57, 57, 69, 57, 57])).toBe(57);
  });

  it('display smoothing keeps vibrato visible but reduces jitter', () => {
    const tr = new PitchTracker(sr);
    const frames = run(tr, voice(220, sr, sr, { vibratoCents: 40, vibratoHz: 5.5 }));
    const disp = frames.filter((f) => f.voiced).map((f) => f.displayMidi);
    const span = (Math.max(...disp) - Math.min(...disp)) * 100;
    expect(span).toBeGreaterThan(30); // vibrato still shows
    expect(span).toBeLessThan(100);
  });
});
