import { describe, expect, it } from 'vitest';
import { arrange, countIn } from '../src/core/arrange';
import { LIBRARY, SOURCES } from '../src/core/library';
import { noteNameWithOctave } from '../src/core/music';
import { chooseTransposition, RANGE_PRESETS } from '../src/core/range';
import { lyricWords } from '../src/core/song';
import { buildPhrases } from '../src/ui/screens/play';

describe('built-in library', () => {
  it('has the six verified songs with unique ids and PD notes', () => {
    expect(LIBRARY.map((s) => s.id)).toEqual(['twinkle', 'frere-jacques', 'ode-to-joy', 'saints', 'amazing-grace', 'auld-lang-syne']);
    for (const s of SOURCES) expect(s.pdNote.length).toBeGreaterThan(20);
  });

  for (const song of LIBRARY) {
    describe(song.title, () => {
      it('has a lyric syllable or melisma marker for every note, starting with a word', () => {
        expect(song.notes[0]!.lyric).not.toBe('');
        expect(lyricWords(song.notes).length).toBeGreaterThan(5);
      });

      it('has a chord track covering the whole song exactly', () => {
        const total = song.chords.reduce((s, c) => s + c.beats, 0);
        expect(total).toBe(song.totalBeats);
        let t = 0;
        for (const c of song.chords) {
          expect(c.start).toBe(t);
          t += c.beats;
        }
      });

      it('has notes in order without overlaps', () => {
        for (let i = 1; i < song.notes.length; i++) {
          const a = song.notes[i - 1]!;
          expect(song.notes[i]!.start).toBeGreaterThanOrEqual(a.start + a.beats - 1e-9);
        }
      });

      it('has contiguous practice sections that cover every note once', () => {
        const secs = song.sections;
        expect(secs[0]!.startBeat).toBe(0);
        expect(secs[secs.length - 1]!.endBeat).toBe(song.totalBeats);
        for (let i = 1; i < secs.length; i++) {
          expect(secs[i]!.startBeat).toBe(secs[i - 1]!.endBeat);
          expect(secs[i]!.noteFrom).toBe(secs[i - 1]!.noteTo);
        }
        for (const s of secs) expect(s.noteTo).toBeGreaterThan(s.noteFrom);
        expect(secs[secs.length - 1]!.noteTo).toBe(song.notes.length);
      });

      it('starts each section on the first syllable of a word', () => {
        for (const s of song.sections) {
          const first = song.notes[s.noteFrom]!;
          expect(first.lyric, `${s.name} starts on a melisma`).not.toBe('');
          const prev = song.notes[s.noteFrom - 1];
          if (prev) expect(prev.lyric.endsWith('-'), `${s.name} starts mid-word`).toBe(false);
        }
      });

      it('stays within a singable span (at most an octave and a fourth)', () => {
        expect(song.high - song.low).toBeLessThanOrEqual(17);
      });

      it('fits every voice-type preset without notes outside the range', () => {
        for (const p of RANGE_PRESETS) {
          const t = chooseTransposition(song, p.range);
          expect(t.maxOutside, `${p.label}: ${noteNameWithOctave(song.low + t.semitones)}-${noteNameWithOctave(song.high + t.semitones)}`).toBe(0);
        }
      });

      it('arranges and counts in', () => {
        const a = arrange(song);
        expect(a.tones.length).toBeGreaterThan(song.totalBeats / 2);
        const ci = countIn(song);
        expect(ci.length).toBeGreaterThanOrEqual(song.beatsPerBar);
        expect(ci[ci.length - 1]!.beat).toBeLessThan(song.notes[0]!.start);
      });

      it('splits lyrics into display lines without breaking words', () => {
        const phrases = buildPhrases(song, 0, song.notes.length);
        expect(phrases[0]!.noteFrom).toBe(0);
        expect(phrases[phrases.length - 1]!.noteTo).toBe(song.notes.length);
        for (const p of phrases) {
          expect(song.notes[p.noteFrom]!.lyric).not.toBe('');
          expect(song.notes[p.noteTo - 1]!.lyric.endsWith('-')).toBe(false);
        }
      });
    });
  }

  it('matches the verified Amazing Grace second phrase (Excell hymnal form)', () => {
    const ag = LIBRARY.find((s) => s.id === 'amazing-grace')!;
    const sec = ag.sections[2]!;
    const names = ag.notes.slice(sec.noteFrom, sec.noteTo).map((n) => noteNameWithOctave(n.midi));
    // I once was lost, but now am found: B4 | D5 B4 D5 B4 | G4 D4 | E4 G4 G4 E4 | D4
    expect(names).toEqual(['B4', 'D5', 'B4', 'D5', 'B4', 'G4', 'D4', 'E4', 'G4', 'G4', 'E4', 'D4']);
  });
});
