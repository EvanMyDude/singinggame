import { describe, expect, it } from 'vitest';
import { emptyTiming, fillEnds, hashLines, lineAt, parseLyrics, parseTiming, snapToOnset, timingFromPhrases, timingMatches, timingToJSON, wordAt } from '../src/core/lyrics';

const TEXT = `
[Intro]
first line here

[Chorus]
second line,  with   spaces
third line
`;

describe('lyrics text', () => {
  it('parses lines and bracketed section headers, ignoring blank lines', () => {
    const d = parseLyrics(TEXT);
    expect(d.lines.map((l) => l.text)).toEqual(['first line here', 'second line, with spaces', 'third line']);
    expect(d.sections).toEqual([
      { name: 'Intro', from: 0, to: 1 },
      { name: 'Chorus', from: 1, to: 3 },
    ]);
    expect(d.lines[2]!.section).toBe(1);
  });
  it('names an implicit first section and handles CRLF', () => {
    const d = parseLyrics('a\r\nb\r\n');
    expect(d.sections).toEqual([{ name: 'Part 1', from: 0, to: 2 }]);
  });
  it('hashes normalized text so whitespace edits do not invalidate timing', () => {
    expect(hashLines(['a  b', 'c'])).toBe(hashLines([' a b ', 'c']));
    expect(hashLines(['a b', 'c'])).not.toBe(hashLines(['a b', 'd']));
  });
});

describe('timing', () => {
  const doc = parseLyrics(TEXT);
  it('round-trips through JSON with unset lines as null', () => {
    const t = emptyTiming(doc);
    t.lines[0] = { start: 1.2346, end: 3 };
    const json = timingToJSON(t);
    expect(json).toContain('null');
    const back = parseTiming(JSON.parse(json));
    expect(back.lines[0]).toEqual({ start: 1.235, end: 3 });
    expect(Number.isNaN(back.lines[1]!.start)).toBe(true);
    expect(timingMatches(back, doc)).toBe(true);
    expect(timingMatches(back, parseLyrics('other'))).toBe(false);
  });
  it('rejects unknown formats', () => {
    expect(() => parseTiming({ version: 2 })).toThrow(/format/);
    expect(() => parseTiming(null)).toThrow();
  });
  it('finds the current line and word', () => {
    const t = emptyTiming(doc);
    t.lines[0] = { start: 1, end: 3 };
    t.lines[1] = { start: 4, end: 6, words: [{ start: 4, end: 4.5 }, { start: 4.5, end: 5 }, { start: 5, end: 5.5 }, { start: 5.5, end: 6 }] };
    t.lines[2] = { start: 8, end: 10 };
    expect(lineAt(t, 0.5)).toBe(-1);
    expect(lineAt(t, 1)).toBe(0);
    expect(lineAt(t, 3.5)).toBe(0);
    expect(lineAt(t, 4.6)).toBe(1);
    expect(lineAt(t, 99)).toBe(2);
    expect(wordAt(t, 1, 4.6)).toBe(1);
    expect(wordAt(t, 1, 5.9)).toBe(3);
    expect(wordAt(t, 0, 2)).toBe(-1);
  });
  it('fills line ends from the next start', () => {
    const t = emptyTiming(doc);
    t.lines[0] = { start: 1, end: NaN };
    t.lines[1] = { start: 4, end: NaN };
    t.lines[2] = { start: 8, end: NaN };
    const f = fillEnds(t, 20);
    expect(f.lines.map((l) => l.end)).toEqual([3.95, 7.95, 19.95]);
  });
  it('snaps taps to a nearby onset only', () => {
    expect(snapToOnset(10.2, [5, 10.05, 12])).toBe(10.05);
    expect(snapToOnset(11, [5, 10.05, 12])).toBe(11);
  });
  it('pre-fills from phrases only when the counts match', () => {
    expect(timingFromPhrases(doc, [{ t: 1, e: 2 }])).toBeNull();
    const t = timingFromPhrases(doc, [{ t: 1, e: 2 }, { t: 3, e: 4 }, { t: 5, e: 6 }]);
    expect(t?.lines.map((l) => l.start)).toEqual([1, 3, 5]);
  });
});
