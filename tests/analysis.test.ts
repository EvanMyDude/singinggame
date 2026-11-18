/// <reference types="node" />
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { correlateValid, measureLag, xcorrLag } from '../src/analysis/align';
import { median, percentile, pyRound, roundHalfEven } from '../src/analysis/numeric';
import { analyzeSong, frameDb, phrasesFrom, SR, trackVocal } from '../src/analysis/prepare';
import { pyin } from '../src/analysis/pyin';
import { estimateKey, estimateTempo } from '../src/analysis/tempo';
import { notesFromContour, targetParams } from '../src/analysis/vocalTargets';
import { parseMelody } from '../src/core/melody';
import { readWav } from './helpers/wav';

/**
 * The browser port of the song analysis (src/analysis/) against the Python reference.
 * Fixtures come from tests/make_analysis_fixtures.py (librosa, tools/vocal_targets.py,
 * tools/prepare_song.py); rerun it when the reference changes.
 */

const FIX = join(__dirname, 'fixtures');
const bits = (s: string) => Uint8Array.from(s, (c) => (c === '1' ? 1 : 0));

interface FixtureNote {
  start: number;
  end: number;
  midi: number;
  median: number;
  madCents: number;
}

describe('numpy helpers', () => {
  it('rounds halves to even like Python', () => {
    expect([0.5, 1.5, 2.5, -0.5, -1.5, -2.5, 2.4, 2.6].map(roundHalfEven)).toEqual([0, 2, 2, -0, -2, -2, 2, 3]);
  });
  it('rounds to digits like Python, from the exact binary value', () => {
    // Python: round(30.05, 1) == 30.1, round(2.675, 2) == 2.67, round(0.125, 2) == 0.12, round(0.375, 2) == 0.38
    expect([pyRound(30.05, 1), pyRound(2.675, 2), pyRound(0.125, 2), pyRound(0.375, 2), pyRound(-0.0001, 2)]).toEqual([30.1, 2.67, 0.12, 0.38, 0]);
  });
  it('takes medians and percentiles like numpy', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(percentile([1, 2, 3, 4, 5], 95)).toBeCloseTo(4.8, 12);
  });
});

describe('note logic matches tools/vocal_targets.py', () => {
  const fx = JSON.parse(readFileSync(join(FIX, 'analysis-contours.json'), 'utf8')) as {
    hop: number;
    cases: { name: string; midi: (number | null)[]; voiced: string; notes: FixtureNote[]; stats: Record<string, unknown> & { inNote: string; voiced: string; lostSeconds: Record<string, number> } }[];
  };
  for (const c of fx.cases) {
    it(c.name, () => {
      const midi = Float64Array.from(c.midi, (v) => (v === null ? NaN : v));
      const { notes, stats } = notesFromContour(midi, bits(c.voiced), targetParams(fx.hop));
      expect(notes.map((n) => n.midi)).toEqual(c.notes.map((n) => n.midi));
      notes.forEach((n, i) => {
        const w = c.notes[i]!;
        expect(n.start).toBeCloseTo(w.start, 9);
        expect(n.end).toBeCloseTo(w.end, 9);
        expect(n.median).toBeCloseTo(w.median, 9);
        expect(n.madCents).toBeCloseTo(w.madCents, 6);
      });
      expect(stats.scoredSeconds).toBe(c.stats.scoredSeconds);
      expect(stats.voicedSeconds).toBe(c.stats.voicedSeconds);
      expect(stats.octaveRepairSeconds).toBe(c.stats.octaveRepairSeconds);
      expect(stats.lostSeconds).toEqual(c.stats.lostSeconds);
      expect(Array.from(stats.inNote).join('')).toBe(c.stats.inNote);
      expect(Array.from(stats.voiced).join('')).toBe(c.stats.voiced);
    });
  }
});

describe('pYIN and the vocal path match librosa and tools/prepare_song.py', () => {
  const fx = JSON.parse(readFileSync(join(FIX, 'analysis-vocal.json'), 'utf8')) as {
    sr: number;
    hop: number;
    frameLength: number;
    fmin: number;
    fmax: number;
    samples: number;
    f0: (number | null)[];
    voiced: string;
    voicedProb: number[];
    rms: number[];
    present: string;
    sung: string;
    notes: FixtureNote[];
    phrases: [number, number][];
  };
  const { sr, samples } = readWav(join(FIX, 'analysis-vocal.wav'));
  const p = pyin(samples, { sr, frameLength: fx.frameLength, hopLength: fx.hop, fmin: fx.fmin, fmax: fx.fmax });

  it('reads the same audio', () => {
    expect(sr).toBe(fx.sr);
    expect(samples.length).toBe(fx.samples);
  });

  it('gives the same voicing probability per frame', () => {
    expect(p.voicedProb.length).toBe(fx.voicedProb.length);
    let worst = 0;
    p.voicedProb.forEach((v, i) => (worst = Math.max(worst, Math.abs(v - fx.voicedProb[i]!))));
    expect(worst).toBeLessThan(1e-4);
  });

  it('decodes the same voicing and pitch bins', () => {
    const want = bits(fx.voiced);
    let sameVoicing = 0;
    let sameBin = 0;
    let bothVoiced = 0;
    for (let i = 0; i < want.length; i++) {
      if (!!p.voiced[i] === !!want[i]) sameVoicing++;
      const w = fx.f0[i];
      if (p.voiced[i] && want[i] && w !== null && w !== undefined) {
        bothVoiced++;
        if (Math.abs(1200 * Math.log2(p.f0[i]! / w)) < 1) sameBin++;
      }
    }
    expect(sameVoicing / want.length).toBe(1);
    expect(sameBin).toBe(bothVoiced);
  });

  it('measures the same level per frame', () => {
    const db = frameDb(samples, 512, fx.hop);
    expect(db.length).toBe(fx.rms.length);
    fx.rms.forEach((r, i) => expect(db[i]!).toBeCloseTo(20 * Math.log10(Math.max(r, 1e-7)), 3));
  });

  it('marks the same frames present and sung, and makes the same notes and phrases', () => {
    const t = trackVocal(samples, 35);
    expect(Array.from(t.present).join('')).toBe(fx.present);
    expect(Array.from(t.sung).join('')).toBe(fx.sung);
    const hopS = fx.hop / fx.sr;
    const { notes, stats } = notesFromContour(t.midi, t.sung, targetParams(hopS));
    expect(notes.map((n) => n.midi)).toEqual(fx.notes.map((n) => n.midi));
    notes.forEach((n, i) => {
      expect(n.start).toBeCloseTo(fx.notes[i]!.start, 9);
      expect(n.end).toBeCloseTo(fx.notes[i]!.end, 9);
      expect(n.median).toBeCloseTo(fx.notes[i]!.median, 6);
    });
    const ph = phrasesFrom(stats.voiced, hopS);
    expect(ph.length).toBe(fx.phrases.length);
    ph.forEach(([a, b], i) => {
      expect(a).toBeCloseTo(fx.phrases[i]![0], 9);
      expect(b).toBeCloseTo(fx.phrases[i]![1], 9);
    });
  });
});

/** Deterministic noise for synthetic signals. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296 - 0.5;
  };
}

describe('alignment', () => {
  it('finds a known lag with the blocked correlation, as a full correlation would', () => {
    const r = rng(1);
    const n = 30000;
    const x = Float32Array.from({ length: n }, () => r());
    const lag = 1234;
    const y = new Float32Array(n);
    for (let i = 0; i < n; i++) y[i] = (i - lag >= 0 ? x[i - lag]! : 0) + 0.3 * r();
    // y[n] = x[n - lag], so y[n + lag] <-> x[n]
    expect(xcorrLag(x, y, n, 3000).lag).toBe(lag);
    expect(xcorrLag(y, x, n, 3000).lag).toBe(-lag);
  });

  it('correlates over the valid lags only', () => {
    const c = correlateValid([1, 2], [0, 1, 2, 0]);
    expect(Array.from(c).map((v) => Math.round(v * 1e9) / 1e9)).toEqual([2, 5, 2]);
  });

  it('measures where a stem sits in the mix, per window', () => {
    const r = rng(7);
    // The first window is skipped (its search range starts before the mix), so 5 windows fit.
    const secs = 48;
    const n = secs * SR;
    const stem = Float32Array.from({ length: n }, () => r());
    const other = Float32Array.from({ length: n + SR }, () => r());
    const delay = Math.round(0.045 * SR);
    const mix = new Float32Array(n + SR);
    for (let i = 0; i < mix.length; i++) mix[i] = other[i]! + (i - delay >= 0 && i - delay < n ? stem[i - delay]! : 0);
    const warnings: string[] = [];
    const m = measureLag(stem, mix, SR, 'the stem', 0.2, false, (w) => warnings.push(w));
    expect(m.lag).toBe(delay);
    expect(m.info.windows).toBeGreaterThanOrEqual(4);
    expect(warnings).toEqual([]);
  }, 30000);
});

/** A synthetic song like tests/synth_song.py: known notes, a noisy backing with beats, a mix. */
function synthSong(bpm = 96) {
  const notes: [number, number, number, number][] = [
    [1.0, 0.5, 60, 0],
    [1.5, 0.5, 62, 0],
    [2.0, 1.2, 64, 0.5],
    [3.6, 0.3, 62, 0],
    [3.9, 0.3, 60, 0],
    [4.6, 1.0, 67, 0.3],
    [6.0, 0.25, 65, 0],
    [6.25, 0.25, 64, 0],
    [6.5, 0.8, 62, 0],
    [8.0, 1.5, 60, 0.6],
  ];
  // Four repeats, as tests/test_prepare_song.py: the offset check needs four 8 s windows
  // after the first, which is skipped when its search range starts before the mix.
  const repeats = 4;
  const dur = 11 * repeats;
  const n = Math.round(dur * SR);
  const vocal = new Float32Array(n);
  const all = notes.flatMap(([s, d, m, v]) => Array.from({ length: repeats }, (_, k) => [s + 11 * k, d, m, v] as const));
  for (const [s, d, m, vib] of all) {
    const a = Math.round(s * SR);
    const b = Math.round((s + d) * SR);
    let phase = 0;
    for (let i = a; i < b; i++) {
      const t = (i - a) / SR;
      const midi = m + vib * Math.sin(2 * Math.PI * 5.8 * t);
      phase += (2 * Math.PI * 440 * 2 ** ((midi - 69) / 12)) / SR;
      let tone = 0;
      for (let h = 1; h <= 6; h++) tone += Math.sin(h * phase) / h;
      const env = Math.min(1, Math.min(t, d - t) / 0.015);
      vocal[i]! += 0.25 * tone * env;
    }
  }
  const r = rng(3);
  const backing = new Float32Array(n);
  // Uniform noise with the standard deviation of synth_song.py's 0.1 * N(0, 1).
  for (let i = 0; i < n; i++) backing[i] = 0.35 * r() + 0.03 * Math.sin((2 * Math.PI * 98 * i) / SR);
  const firstBeat = 0.37;
  for (let beat = firstBeat; beat < dur - 0.1; beat += 60 / bpm) {
    const a = Math.round(beat * SR);
    for (let i = 0; i < 0.03 * SR && a + i < n; i++) backing[a + i]! += 3 * Math.exp(-i / (0.004 * SR)) * r(); // well above the noise, so the tempo is in the signal
  }
  return { all, vocal, backing, dur, firstBeat, bpm };
}

function delayed(y: Float32Array, seconds: number): Float32Array {
  const d = Math.round(seconds * SR);
  const out = new Float32Array(y.length + d);
  out.set(y, d);
  return out;
}

describe('the whole analysis on a synthetic song', () => {
  const song = synthSong();
  const INST = 0.04;
  const VOC = 0.015;
  const mix = new Float32Array(song.vocal.length);
  for (let i = 0; i < mix.length; i++) mix[i] = song.vocal[i]! + song.backing[i]!;
  const { doc, report } = analyzeSong({ instrumental: delayed(song.backing, INST), vocal: delayed(song.vocal, VOC), mix, referenceKind: 'mix' });

  it('recovers every note on the song timeline', () => {
    const want = song.all.map(([s, d, m]) => [s + INST, d, m] as const).sort((a, b) => a[0] - b[0]);
    expect(doc.notes.map((x) => x.m)).toEqual(want.map((w) => w[2]));
    doc.notes.forEach((x, i) => {
      expect(Math.abs(x.t - want[i]![0])).toBeLessThan(0.05);
      expect(Math.abs(x.t + x.d - (want[i]![0] + want[i]![1]))).toBeLessThan(0.06);
    });
    expect(report.noteCount).toBe(want.length);
  });

  it('measures the offsets', () => {
    expect(doc.referenceOffset).toBeCloseTo(-INST, 2);
    const v = doc.analysis.alignment.vocal as { method: string; songOffsetSeconds: number };
    expect(v.method).toBe('measured');
    expect(Math.abs(v.songOffsetSeconds - (INST - VOC))).toBeLessThan(0.002);
    expect(report.warnings).toEqual([]);
  });

  it('writes a melody the app loads, with the tempo of the backing', () => {
    const m = parseMelody(JSON.parse(JSON.stringify(doc)));
    expect(m.notes.length).toBe(doc.notes.length);
    expect(m.analysis?.presentSeconds).toBe(doc.analysis.presentSeconds);
    expect(Math.abs(doc.bpm - song.bpm) / song.bpm).toBeLessThan(0.01);
    const period = 60 / song.bpm;
    const phaseErr = Math.abs(((doc.firstBeat - (song.firstBeat + INST)) / period + 0.5) % 1 - 0.5) * period;
    expect(phaseErr).toBeLessThan(0.03);
    expect(doc.source).toEqual({ kind: 'isolated-vocal', tracker: 'pyin', tool: 'browser' });
  });

  it('without a mix, assumes the stems start together and layers the vocal', () => {
    const r = analyzeSong({ instrumental: song.backing, vocal: song.vocal, mix: null, referenceKind: 'vocal' });
    expect((r.doc.analysis.alignment.vocal as { method: string }).method).toBe('assumed');
    expect(r.doc.referenceOffset).toBe(0);
    expect(r.doc.notes.length).toBe(song.all.length);
  });
}, 120000);

describe('tempo and key estimates', () => {
  it('finds the tempo of a click track and not its double or half', () => {
    for (const bpm of [78, 96, 128, 143]) {
      const r = rng(bpm);
      const n = 20 * SR;
      const y = Float32Array.from({ length: n }, () => 0.02 * r());
      for (let b = 0.21; b < 19.9; b += 60 / bpm) {
        const a = Math.round(b * SR);
        for (let i = 0; i < 0.02 * SR; i++) y[a + i]! += Math.exp(-i / (0.003 * SR)) * r();
      }
      const t = estimateTempo(y, SR);
      expect(Math.abs(t.bpm - bpm) / bpm).toBeLessThan(0.01);
    }
  });

  it('reads the key from the notes', () => {
    const cMajor = [60, 62, 64, 65, 67, 69, 71, 72].map((m) => ({ midi: m, dur: m % 12 === 0 || m % 12 === 7 ? 2 : 1 }));
    expect(estimateKey(cMajor)).toMatchObject({ tonic: 0, mode: 'major' });
    const aMinor = [57, 59, 60, 62, 64, 65, 67, 69].map((m) => ({ midi: m, dur: m % 12 === 9 || m % 12 === 4 ? 2 : 1 }));
    expect(estimateKey(aMinor)).toMatchObject({ tonic: 9, mode: 'minor' });
  });
});
