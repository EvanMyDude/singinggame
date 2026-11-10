import melodyJson from '../public/songs/old-town-road/melody.json';
import { describe, expect, it } from 'vitest';
import { parseLyrics } from '../src/core/lyrics';
import { BeatMap, buildSections, fmtSpan, melodyToSong, parseMelody, targetCoverage, vocalOnsets, type MelodyData } from '../src/core/melody';

const SAMPLE: MelodyData = {
  version: 1,
  duration: 20,
  referenceOffset: -0.05,
  key: { tonic: 6, mode: 'major' },
  bpm: 120,
  firstBeat: 0.7,
  tuningCents: 0,
  notes: [
    { t: 1, d: 0.5, m: 60, c: 0 },
    { t: 1.5, d: 0.5, m: 62, c: 0.1 },
    { t: 5, d: 1, m: 64, c: 0 },
    { t: 12, d: 0.5, m: 65, c: 0 },
  ],
  phrases: [
    { t: 1, e: 2.2 },
    { t: 4.5, e: 6 },
    { t: 12, e: 12.6 },
  ],
};

describe('melody data', () => {
  it('parses and validates the committed melody.json', () => {
    const m = parseMelody(melodyJson);
    expect(m.notes.length).toBeGreaterThan(100);
    expect(m.duration).toBeGreaterThan(150);
    expect(m.referenceOffset).toBeCloseTo(-0.0458, 3);
    expect(m.bpm).toBeCloseTo(136, 0);
    // Notes are sorted and sane for a singing voice.
    for (let i = 1; i < m.notes.length; i++) expect(m.notes[i]!.t).toBeGreaterThanOrEqual(m.notes[i - 1]!.t);
    for (const n of m.notes) {
      expect(n.m).toBeGreaterThanOrEqual(40);
      expect(n.m).toBeLessThanOrEqual(84);
      expect(n.d).toBeGreaterThanOrEqual(0.1);
    }
  });
  it('rejects malformed input', () => {
    expect(() => parseMelody({ version: 2 })).toThrow();
    expect(() => parseMelody('x')).toThrow();
  });
});

describe('BeatMap', () => {
  it('puts beat 0 one bar before the first beat and keeps song time non-negative', () => {
    const map = new BeatMap(SAMPLE);
    expect(map.secPerBeat).toBeCloseTo(0.5, 9);
    expect(map.origin).toBeCloseTo(0.7 - 2, 9);
    expect(map.beat(0.7)).toBeCloseTo(4, 9); // a bar line on the first beat
    expect(map.beat(0)).toBeGreaterThanOrEqual(0);
    expect(map.seconds(map.beat(7.25))).toBeCloseTo(7.25, 9);
  });
});

describe('sections and song conversion', () => {
  it('clusters phrases into parts when there are no synced lyrics', () => {
    const secs = buildSections(SAMPLE, null, null);
    expect(secs.length).toBe(2); // phrases 1 and 2 are 2.3 s apart (within the 2.5 s gap); 12 is far
    expect(secs[0]!.start).toBeCloseTo(0.5, 9);
    expect(secs[1]!.name).toMatch(/Part 2/);
  });
  it('uses lyric sections when timing is available', () => {
    const doc = parseLyrics('[Verse]\na\nb\n[Chorus]\nc');
    const timing = { version: 1 as const, hash: doc.hash, lineCount: 3, lines: [{ start: 1, end: 2 }, { start: 3, end: 4 }, { start: 11, end: 13 }] };
    const secs = buildSections(SAMPLE, doc, timing);
    expect(secs.map((s) => s.name)).toEqual(['Verse', 'Chorus']);
    expect(secs[0]!.end).toBe(4);
    expect(secs[1]!.start).toBe(10.5);
  });
  it('converts to a Song with beat-timed notes and section note ranges', () => {
    const map = new BeatMap(SAMPLE);
    const song = melodyToSong(SAMPLE, 'x', 'X', buildSections(SAMPLE, null, null), map);
    expect(song.notes.length).toBe(4);
    expect(song.notes[0]!.start).toBeCloseTo(map.beat(1), 9);
    expect(song.notes[2]!.beats).toBeCloseTo(2, 9);
    expect(song.sections[0]).toMatchObject({ noteFrom: 0, noteTo: 3 });
    expect(song.sections[1]).toMatchObject({ noteFrom: 3, noteTo: 4 });
    expect(song.totalBeats).toBeGreaterThanOrEqual(map.beat(20));
  });
  it('lists unique onsets for tap snapping', () => {
    expect(vocalOnsets(SAMPLE)).toEqual([1, 1.5, 4.5, 5, 12]);
  });
});

describe('target coverage', () => {
  it('reports how many notes and seconds are graded, overall and per section', () => {
    const map = new BeatMap(SAMPLE);
    const specs = [
      { name: 'A', start: 0, end: 4 },
      { name: 'B', start: 4, end: 8 },
      { name: 'Gap', start: 8, end: 11 },
      { name: 'C', start: 11, end: 20 },
    ];
    const song = melodyToSong(SAMPLE, 'x', 'X', specs, map);
    const all = targetCoverage(song);
    expect(all.notes).toBe(4);
    expect(all.seconds).toBeCloseTo(2.5, 9);
    const per = song.sections.map((s) => targetCoverage(song, s.noteFrom, s.noteTo));
    expect(per.map((c) => c.notes)).toEqual([2, 1, 0, 1]);
    expect(per[0]!.seconds).toBeCloseTo(1, 9);
    expect(per[2]!.seconds).toBe(0);
  });
  it('matches the extractor summary for the committed melody', () => {
    const m = parseMelody(melodyJson);
    const song = melodyToSong(m, 'x', 'X', [{ name: 'Whole song', start: 0, end: m.duration }], new BeatMap(m));
    const c = targetCoverage(song);
    expect(c.notes).toBe(m.notes.length);
    expect(c.seconds).toBeCloseTo(m.notes.reduce((s, n) => s + n.d, 0), 6);
    expect(c.seconds).toBeLessThan(m.duration / 2);
  });
  it('formats spans', () => {
    expect(fmtSpan(43.3)).toBe('43 s');
    expect(fmtSpan(157.683)).toBe('2:37');
  });
});
