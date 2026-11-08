import { parseNote, pitchClass, type Mode } from './music';

/**
 * Songs are authored as compact strings (see `SongSource`) and parsed into absolute-beat
 * events. Beats are the canonical time unit: tempo and practice speed only change how
 * beats map to seconds, so slowing down never changes pitch or the score scale.
 */

export type AccompStyle = 'gentle' | 'hymn' | 'waltz' | 'march' | 'ballad' | 'none';
export type ChordQuality = 'maj' | 'min' | '7' | 'maj7' | 'min7' | 'dim' | 'sus4' | 'none';

export interface SongSource {
  id: string;
  title: string;
  /** Composer / origin, shown in the library. */
  credit: string;
  /** Why this is public domain, shown in the song info. */
  pdNote: string;
  bpm: number;
  beatsPerBar: number;
  /** Tonic of the written key, e.g. "D" or "Bb". */
  tonic: string;
  mode: Mode;
  difficulty: 1 | 2 | 3;
  style: AccompStyle;
  /**
   * Space-separated `Pitch:beats` tokens, e.g. `C4:1 D4 E4:2`. Duration is sticky.
   * `R:beats` is a rest. `|` asserts a bar line falls here.
   */
  melody: string;
  /**
   * One token per sung note. A token ending in `-` joins the next syllable into one word.
   * `~` continues the previous syllable (melisma).
   */
  lyrics?: string;
  /** `Root[quality]:beats` tokens (`C`, `Am`, `G7`, `Fmaj7`, `Em7`, `Bdim`, `Dsus4`, `N`). */
  chords?: string;
  /** Named sections by 1-based bar numbers, inclusive. */
  sections?: { name: string; from: number; to: number }[];
}

export interface Note {
  index: number;
  midi: number;
  start: number;
  beats: number;
  /** Syllable as authored (may end in "-"), "" for melisma continuation. */
  lyric: string;
}

export interface Chord {
  start: number;
  beats: number;
  /** Root pitch class 0..11, or -1 for "no chord". */
  root: number;
  quality: ChordQuality;
}

export interface Section {
  name: string;
  startBeat: number;
  endBeat: number;
  /** Indices into `notes` (inclusive start, exclusive end). */
  noteFrom: number;
  noteTo: number;
}

export interface Song {
  id: string;
  title: string;
  credit: string;
  pdNote: string;
  bpm: number;
  beatsPerBar: number;
  tonicPc: number;
  mode: Mode;
  difficulty: 1 | 2 | 3;
  style: AccompStyle;
  notes: Note[];
  chords: Chord[];
  sections: Section[];
  totalBeats: number;
  low: number;
  high: number;
  /** Duration-weighted mean pitch (where the song "sits"). */
  tessitura: number;
  /** True for user-imported songs. */
  imported?: boolean;
}

const TONIC_PC: Record<string, number> = {
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7,
  'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11,
};

export function parseMelody(src: string, beatsPerBar: number): { midi: number | null; start: number; beats: number }[] {
  const events: { midi: number | null; start: number; beats: number }[] = [];
  let t = 0;
  let dur = 1;
  let bar = 1;
  for (const tok of src.trim().split(/\s+/)) {
    if (tok === '|') {
      bar++;
      if (Math.abs(t / beatsPerBar - Math.round(t / beatsPerBar)) > 1e-6) {
        throw new Error(`Bar line before bar ${bar} at beat ${t} is not on a bar boundary`);
      }
      continue;
    }
    const [p, d] = tok.split(':');
    if (d !== undefined) {
      dur = Number(d);
      if (!(dur > 0)) throw new Error(`Bad duration in "${tok}"`);
    }
    const midi = p === 'R' ? null : parseNote(p!);
    events.push({ midi, start: t, beats: dur });
    t += dur;
  }
  return events;
}

export function parseChordSymbol(sym: string): { root: number; quality: ChordQuality } {
  if (sym === 'N') return { root: -1, quality: 'none' };
  const m = /^([A-G])([#b]?)(maj7|m7|m|7|dim|sus4)?$/.exec(sym);
  if (!m) throw new Error(`Bad chord "${sym}"`);
  const root = TONIC_PC[m[1]! + (m[2] ?? '')];
  if (root === undefined) throw new Error(`Bad chord root "${sym}"`);
  const q = m[3];
  const quality: ChordQuality =
    q === 'maj7' ? 'maj7' : q === 'm7' ? 'min7' : q === 'm' ? 'min' : q === '7' ? '7' : q === 'dim' ? 'dim' : q === 'sus4' ? 'sus4' : 'maj';
  return { root, quality };
}

export function parseChords(src: string, beatsPerBar: number): Chord[] {
  const out: Chord[] = [];
  let t = 0;
  let dur = beatsPerBar;
  for (const tok of src.trim().split(/\s+/)) {
    if (tok === '|') {
      if (Math.abs(t / beatsPerBar - Math.round(t / beatsPerBar)) > 1e-6) {
        throw new Error(`Chord bar line at beat ${t} is not on a bar boundary`);
      }
      continue;
    }
    const [sym, d] = tok.split(':');
    if (d !== undefined) dur = Number(d);
    out.push({ start: t, beats: dur, ...parseChordSymbol(sym!) });
    t += dur;
  }
  return out;
}

export function buildSong(src: SongSource): Song {
  const events = parseMelody(src.melody, src.beatsPerBar);
  const sung = events.filter((e) => e.midi !== null);
  const lyricTokens = src.lyrics ? src.lyrics.trim().split(/\s+/) : [];
  if (src.lyrics && lyricTokens.length !== sung.length) {
    throw new Error(`${src.id}: ${lyricTokens.length} lyric tokens for ${sung.length} notes`);
  }
  const notes: Note[] = sung.map((e, i) => ({
    index: i,
    midi: e.midi!,
    start: e.start,
    beats: e.beats,
    lyric: lyricTokens[i] === '~' ? '' : (lyricTokens[i] ?? ''),
  }));
  const chords = src.chords ? parseChords(src.chords, src.beatsPerBar) : [];
  const tonicPc = TONIC_PC[src.tonic];
  if (tonicPc === undefined) throw new Error(`${src.id}: bad tonic ${src.tonic}`);
  const last = events[events.length - 1]!;
  return songFromNotes(
    {
      id: src.id,
      title: src.title,
      credit: src.credit,
      pdNote: src.pdNote,
      bpm: src.bpm,
      beatsPerBar: src.beatsPerBar,
      tonicPc,
      mode: src.mode,
      difficulty: src.difficulty,
      style: src.style,
    },
    notes,
    chords,
    src.sections,
    last.start + last.beats,
  );
}

export type SongMeta = Pick<Song, 'id' | 'title' | 'credit' | 'pdNote' | 'bpm' | 'beatsPerBar' | 'tonicPc' | 'mode' | 'difficulty' | 'style'>;

/** Assemble a Song from already-timed notes (used by the text format and MIDI import). */
export function songFromNotes(
  meta: SongMeta,
  notes: Note[],
  chords: Chord[],
  sectionsSrc?: { name: string; from: number; to: number }[],
  melodyEnd?: number,
): Song {
  if (!notes.length) throw new Error(`${meta.id}: no notes`);
  const lastNote = notes[notes.length - 1]!;
  const end = Math.max(melodyEnd ?? 0, lastNote.start + lastNote.beats);
  const totalBeats = Math.ceil(end / meta.beatsPerBar - 1e-9) * meta.beatsPerBar;
  const bars = totalBeats / meta.beatsPerBar;
  const src = sectionsSrc ?? [{ name: 'Song', from: 1, to: bars }];
  const sections: Section[] = src.map((s) => {
    const startBeat = (s.from - 1) * meta.beatsPerBar;
    const endBeat = s.to * meta.beatsPerBar;
    let noteFrom = notes.findIndex((n) => n.start >= startBeat - 1e-9);
    if (noteFrom < 0) noteFrom = notes.length;
    let noteTo = notes.findIndex((n) => n.start >= endBeat - 1e-9);
    if (noteTo < 0) noteTo = notes.length;
    return { name: s.name, startBeat, endBeat, noteFrom, noteTo };
  });
  return { ...meta, notes, chords, sections, totalBeats, ...rangeOf(notes) };
}

export function rangeOf(notes: readonly Note[]): { low: number; high: number; tessitura: number } {
  let low = Infinity;
  let high = -Infinity;
  let wsum = 0;
  let w = 0;
  for (const n of notes) {
    low = Math.min(low, n.midi);
    high = Math.max(high, n.midi);
    wsum += n.midi * n.beats;
    w += n.beats;
  }
  return { low, high, tessitura: w ? wsum / w : 60 };
}

/** A copy of the song shifted by `semitones` (melody and chords). */
export function transposeSong(song: Song, semitones: number): Song {
  if (semitones === 0) return song;
  const notes = song.notes.map((n) => ({ ...n, midi: n.midi + semitones }));
  const chords = song.chords.map((c) => (c.root < 0 ? c : { ...c, root: pitchClass(c.root + semitones) }));
  return {
    ...song,
    notes,
    chords,
    tonicPc: pitchClass(song.tonicPc + semitones),
    ...rangeOf(notes),
  };
}

/** Join syllables into display words: "Twin-" + "kle" -> "Twinkle". */
export function lyricWords(notes: readonly Note[]): { text: string; noteFrom: number; noteTo: number }[] {
  const words: { text: string; noteFrom: number; noteTo: number }[] = [];
  let cur: { text: string; noteFrom: number; noteTo: number } | null = null;
  for (let i = 0; i < notes.length; i++) {
    const syl = notes[i]!.lyric;
    if (syl === '') {
      if (cur) cur.noteTo = i + 1;
      else if (words.length) words[words.length - 1]!.noteTo = i + 1;
      continue;
    }
    const joins = syl.endsWith('-');
    const text = joins ? syl.slice(0, -1) : syl;
    if (cur) {
      cur.text += text;
      cur.noteTo = i + 1;
    } else {
      cur = { text, noteFrom: i, noteTo: i + 1 };
    }
    if (!joins) {
      words.push(cur);
      cur = null;
    }
  }
  if (cur) words.push(cur);
  return words;
}

/** Seconds per beat at a practice speed factor (1 = written tempo). */
export function secondsPerBeat(song: Pick<Song, 'bpm'>, speed: number): number {
  return 60 / (song.bpm * speed);
}
