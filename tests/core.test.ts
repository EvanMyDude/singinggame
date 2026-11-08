import { describe, expect, it } from 'vitest';
import { arrange, countIn, voiceChord } from '../src/core/arrange';
import { centsError, hzToMidi, keyName, midiToHz, noteNameWithOctave, parseNote } from '../src/core/music';
import { chooseTransposition, voiceTypeFor } from '../src/core/range';
import {
  ScoreEngine,
  frameAccuracy,
  gradeFor,
  multiplierFor,
  pitchInsights,
  timingScore,
  weakestSection,
  type ScoreFrame,
} from '../src/core/scoring';
import { buildSong, lyricWords, parseChords, parseMelody, transposeSong, type SongSource } from '../src/core/song';
import { simulateSinger } from './helpers/singer';

const TEST_SONG: SongSource = {
  id: 'test',
  title: 'Test',
  credit: 'test',
  pdNote: 'test',
  bpm: 100,
  beatsPerBar: 4,
  tonic: 'C',
  mode: 'major',
  difficulty: 1,
  style: 'hymn',
  melody: 'C4:1 C4 G4 G4 | A4 A4 G4:2 | F4:1 F4 E4 E4 | D4 D4 C4:2',
  lyrics: 'Twin- kle twin- kle lit- tle star, How I won- der what you are.',
  chords: 'C:2 C:2 | F:2 C:2 | F:2 C:2 | G:2 C:2',
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
  it('parses chords', () => {
    const c = parseChords('C:2 Am:1 D7:1 | Gsus4:2 G:2', 4);
    expect(c.map((x) => [x.root, x.quality])).toEqual([
      [0, 'maj'],
      [9, 'min'],
      [2, '7'],
      [7, 'sus4'],
      [7, 'maj'],
    ]);
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
  it('transposes melody, chords and key', () => {
    const s = transposeSong(buildSong(TEST_SONG), -3);
    expect(s.notes[0]!.midi).toBe(57);
    expect(s.tonicPc).toBe(9);
    expect(s.chords[2]!.root).toBe(2);
    expect(s.high).toBe(66);
  });
});

describe('range fitting', () => {
  const song = buildSong(TEST_SONG); // C4..A4, tessitura ~ E4
  it('keeps the original key when it already sits well', () => {
    const r = chooseTransposition(song, { low: 57, high: 74 });
    expect(r).toMatchObject({ semitones: 0, keptOriginal: true });
  });
  it('moves a song down into a low voice and keeps it in range', () => {
    const r = chooseTransposition(song, { low: 43, high: 60 });
    expect(r.maxOutside).toBe(0);
    expect(song.low + r.semitones).toBeGreaterThanOrEqual(43);
    expect(song.high + r.semitones).toBeLessThanOrEqual(60);
  });
  it('compromises sensibly when the range is narrower than the song', () => {
    const r = chooseTransposition(song, { low: 50, high: 56 });
    expect(r.maxOutside).toBeLessThanOrEqual(2);
  });
  it('labels voice types roughly', () => {
    expect(voiceTypeFor({ low: 43, high: 60 })).toBe('Bass');
    expect(voiceTypeFor({ low: 60, high: 79 })).toBe('Soprano');
  });
});

describe('arrangement', () => {
  it('voices chords in the keys register with smooth voice leading', () => {
    const c = voiceChord(0, 'maj', 62);
    expect(c.every((m) => m >= 53 && m <= 72)).toBe(true);
    expect(new Set(c.map((m) => m % 12))).toEqual(new Set([0, 4, 7]));
  });
  it('produces bass, keys and drums within the song length', () => {
    const s = buildSong(TEST_SONG);
    const a = arrange(s);
    expect(a.tones.some((t) => t.part === 'bass')).toBe(true);
    expect(a.tones.some((t) => t.part === 'keys')).toBe(true);
    expect(a.tones.every((t) => t.beat >= 0 && t.beat < s.totalBeats)).toBe(true);
    expect(a.drums.length).toBeGreaterThan(0);
  });
  it('counts in one bar and through pickup rests', () => {
    const s = buildSong({ ...TEST_SONG, beatsPerBar: 3, melody: 'R:2 C4:1 | D4:3', lyrics: 'a b', chords: 'N:2 C:1 | C:3', sections: undefined });
    expect(countIn(s).map((c) => c.beat)).toEqual([-3, -2, -1, 0, 1]);
  });
});

describe('scoring primitives', () => {
  it('accuracy curve is monotonic with the documented anchor points', () => {
    expect(frameAccuracy(0)).toBe(1);
    expect(frameAccuracy(25)).toBeCloseTo(0.87, 2);
    expect(frameAccuracy(50)).toBeCloseTo(0.42, 2);
    expect(frameAccuracy(100)).toBeLessThan(0.03);
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

  it('finds the weakest section', () => {
    const frames = simulateSinger(song, t0, spb, fi, { sigmaCents: 3 }).map((f) =>
      f.time > t0 + 8 * spb ? { ...f, midi: f.midi + 0.7 } : f,
    );
    const eng = play(frames);
    expect(weakestSection(song, eng.results)).toBe(1);
  });
});
