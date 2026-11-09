import { describe, expect, it } from 'vitest';
import { centsError, hzToMidi, keyName, midiToHz, noteNameWithOctave, parseNote } from '../src/core/music';
import {
  ScoreEngine,
  frameAccuracy,
  gradeFor,
  multiplierFor,
  phraseInsights,
  pitchInsights,
  timingScore,
  weakestSection,
  zoneFor,
  type ScoreFrame,
} from '../src/core/scoring';
import { buildSong, lyricWords, parseMelody, type SongSource } from '../src/core/song';
import { simulateSinger } from './helpers/singer';

const TEST_SONG: SongSource = {
  id: 'test',
  title: 'Test',
  credit: 'test',
  bpm: 100,
  beatsPerBar: 4,
  tonic: 'C',
  mode: 'major',
  difficulty: 1,
  melody: 'C4:1 C4 G4 G4 | A4 A4 G4:2 | F4:1 F4 E4 E4 | D4 D4 C4:2',
  lyrics: 'Twin- kle twin- kle lit- tle star, How I won- der what you are.',
  sections: [
    { name: 'A', from: 1, to: 2 },
    { name: 'B', from: 3, to: 4 },
  ],
};

describe('music', () => {
  it('converts between Hz and MIDI', () => {
    expect(hzToMidi(440)).toBeCloseTo(69, 9);
    expect(midiToHz(60)).toBeCloseTo(261.6256, 3);
  });
  it('names notes and keys', () => {
    expect(noteNameWithOctave(60)).toBe('C4');
    expect(noteNameWithOctave(70, true)).toBe('B♭4');
    expect(keyName(10, 'major')).toBe('B♭ major');
    expect(keyName(2, 'major')).toBe('D major');
    expect(parseNote('F#3')).toBe(54);
    expect(parseNote('Bb4')).toBe(70);
  });
  it('folds octave errors only when asked', () => {
    expect(centsError(57.2, 69, true)).toBeCloseTo(20, 6);
    expect(centsError(57.2, 69, false)).toBeCloseTo(-1180, 6);
    expect(Math.abs(centsError(63, 69, true))).toBe(600);
  });
});

describe('song format', () => {
  it('parses melody with sticky durations and bar checks', () => {
    const ev = parseMelody('C4:1 D4 E4:2 | R:1 G4 A4:0.5 B4 C5:1', 4);
    expect(ev.map((e) => e.start)).toEqual([0, 1, 2, 4, 5, 6, 6.5, 7]);
    expect(ev[3]!.midi).toBeNull();
    expect(() => parseMelody('C4:1 D4 | E4', 4)).toThrow(/bar/);
  });
  it('builds a song with lyrics, sections and range', () => {
    const s = buildSong(TEST_SONG);
    expect(s.notes).toHaveLength(14);
    expect(s.totalBeats).toBe(16);
    expect(s.low).toBe(60);
    expect(s.high).toBe(69);
    expect(s.sections[1]).toMatchObject({ startBeat: 8, endBeat: 16, noteFrom: 7, noteTo: 14 });
    expect(lyricWords(s.notes).map((w) => w.text)).toEqual(['Twinkle', 'twinkle', 'little', 'star,', 'How', 'I', 'wonder', 'what', 'you', 'are.']);
  });
  it('rejects mismatched lyric counts', () => {
    expect(() => buildSong({ ...TEST_SONG, lyrics: 'too few' })).toThrow(/lyric/);
  });
});

describe('scoring primitives', () => {
  it('accuracy curve is monotonic with the documented anchor points', () => {
    expect(frameAccuracy(0)).toBe(1);
    expect(frameAccuracy(25)).toBeCloseTo(0.87, 2);
    expect(frameAccuracy(50)).toBeCloseTo(0.42, 2);
    expect(frameAccuracy(100)).toBeLessThan(0.03);
  });
  it('uses the specified cents bands: Perfect ±10, Great ±25, Good ±50', () => {
    expect([0, 10, 10.5, 25, 25.5, 50, 50.5, 200].map(zoneFor)).toEqual(['perfect', 'perfect', 'great', 'great', 'good', 'good', 'off', 'off']);
  });
  it('multiplier tiers and grades', () => {
    expect([0, 3, 4, 8, 16, 40].map(multiplierFor)).toEqual([1, 1, 1.5, 2, 3, 3]);
    expect([99, 90, 80, 65, 50, 10].map(gradeFor)).toEqual(['S', 'A', 'B', 'C', 'D', 'F']);
  });
  it('timing score forgives small offsets', () => {
    expect(timingScore(0.08)).toBe(1);
    expect(timingScore(-0.09)).toBe(1);
    expect(timingScore(0.25)).toBeCloseTo(0.5, 6);
    expect(timingScore(0.5)).toBe(0);
  });
});

describe('ScoreEngine with simulated singers', () => {
  const song = buildSong(TEST_SONG);
  const spb = 60 / song.bpm;
  const fi = 512 / 48000;
  const t0 = 5;

  function play(frames: ScoreFrame[], opts: Partial<{ latency: number; fold: boolean; spb: number }> = {}) {
    const eng = new ScoreEngine(song, {
      t0,
      secPerBeat: opts.spb ?? spb,
      latency: opts.latency ?? 0,
      frameInterval: fi,
      foldOctaves: opts.fold ?? true,
    });
    for (const f of frames) {
      eng.ingest(f);
      eng.advance(f.time);
    }
    eng.finishAll();
    return eng;
  }

  it('a near-perfect singer gets S with full timing', () => {
    const eng = play(simulateSinger(song, t0, spb, fi, { sigmaCents: 3 }));
    expect(eng.accuracyPct).toBeGreaterThan(95);
    expect(gradeFor(eng.accuracyPct)).toBe('S');
    expect(eng.counts.perfect).toBe(14);
    expect(eng.timingPct).toBeGreaterThan(95);
    expect(eng.bestStreak).toBe(14);
  });

  it('latency compensation recovers a singer heard through 180 ms of round trip', () => {
    const frames = simulateSinger(song, t0, spb, fi, { sigmaCents: 4, latency: 0.18 });
    const raw = play(frames, { latency: 0 });
    const comp = play(frames, { latency: 0.18 });
    expect(comp.timingPct).toBeGreaterThan(95);
    expect(comp.timingPct).toBeGreaterThan(raw.timingPct);
    expect(comp.accuracyPct).toBeGreaterThan(raw.accuracyPct);
  });

  it('small reaction lag is not punished as wrong pitch', () => {
    const eng = play(simulateSinger(song, t0, spb, fi, { sigmaCents: 4, reaction: 0.08 }));
    expect(eng.accuracyPct).toBeGreaterThan(90);
    expect(eng.timingPct).toBeGreaterThan(95);
  });

  it('a consistently flat singer is reported as flat', () => {
    const eng = play(simulateSinger(song, t0, spb, fi, { biasCents: -40, sigmaCents: 4 }));
    expect(eng.counts.good + eng.counts.off).toBe(14);
    for (const r of eng.results) expect(r.biasCents).toBeLessThan(-25);
    const ins = pitchInsights(eng.results);
    expect(ins.struggled.length).toBeGreaterThan(0);
    expect(ins.struggled[0]!.bias).toBeLessThan(-25);
  });

  it('silence scores zero and every note is a miss', () => {
    const eng = play(simulateSinger(song, t0, spb, fi, { silent: true }));
    expect(eng.score).toBe(0);
    expect(eng.counts.miss).toBe(14);
    expect(gradeFor(eng.accuracyPct)).toBe('F');
  });

  it('octave forgiveness accepts singing an octave down', () => {
    const frames = simulateSinger(song, t0, spb, fi, { sigmaCents: 4, octaveShift: -12 });
    expect(play(frames, { fold: true }).accuracyPct).toBeGreaterThan(95);
    expect(play(frames, { fold: false }).counts.perfect).toBe(0);
  });

  it('score scale does not depend on practice speed', () => {
    const fast = play(simulateSinger(song, t0, spb, fi, { sigmaCents: 8, seed: 3 }));
    const slowSpb = spb * 2;
    const slow = play(simulateSinger(song, t0, slowSpb, fi, { sigmaCents: 8, seed: 3 }), { spb: slowSpb });
    expect(Math.abs(slow.score - fast.score) / fast.score).toBeLessThan(0.08);
  });

  it('grades spread sensibly from trained to struggling singers', () => {
    const grade = (noteSigmaCents: number) => {
      const accs: number[] = [];
      for (let seed = 1; seed <= 12; seed++) {
        const frames = simulateSinger(song, t0, spb, fi, { noteSigmaCents, sigmaCents: 10, reaction: 0.06, gapFraction: 0.15, seed });
        accs.push(play(frames).accuracyPct);
      }
      return gradeFor(accs.reduce((a, b) => a + b, 0) / accs.length);
    };
    expect(grade(8)).toBe('S'); // trained
    expect(['A', 'B']).toContain(grade(25)); // decent amateur
    expect(['B', 'C']).toContain(grade(40)); // average untrained
    expect(['C', 'D', 'F']).toContain(grade(70)); // struggling
  });

  it('reports a pitch as struggled when only some occurrences go flat, and never as nailed', () => {
    // Same pitches appear in both halves; the second half is sung 45 cents flat.
    const frames = simulateSinger(song, t0, spb, fi, { sigmaCents: 3 }).map((f) =>
      f.time > t0 + 8 * spb ? { ...f, midi: f.midi - 0.45 } : f,
    );
    const ins = pitchInsights(play(frames).results);
    const flatPitches = new Set(song.notes.filter((n) => n.start >= 8).map((n) => n.midi));
    for (const p of ins.struggled) expect(p.bias).toBeLessThan(-25);
    expect(ins.struggled.some((p) => flatPitches.has(p.midi) && p.count < p.total)).toBe(true);
    for (const p of ins.nailed) expect(flatPitches.has(p.midi)).toBe(false);
  });

  it('names the hardest and best lyric lines', () => {
    const frames = simulateSinger(song, t0, spb, fi, { sigmaCents: 3 }).map((f) =>
      f.time > t0 + 8 * spb ? { ...f, midi: f.midi - 0.45 } : f,
    );
    const p = phraseInsights(song, play(frames).results);
    expect(p.lines.map((l) => l.text)).toEqual(['Twinkle twinkle little star,', 'How I wonder what you are.']);
    expect(p.hardest?.text).toBe('How I wonder what you are.');
    expect(p.hardest!.bias).toBeLessThan(-25);
    expect(p.best?.text).toBe('Twinkle twinkle little star,');
  });

  it('finds the weakest section', () => {
    const frames = simulateSinger(song, t0, spb, fi, { sigmaCents: 3 }).map((f) =>
      f.time > t0 + 8 * spb ? { ...f, midi: f.midi + 0.7 } : f,
    );
    const eng = play(frames);
    expect(weakestSection(song, eng.results)).toBe(1);
  });
});
