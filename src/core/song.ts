import { parseNote, type Mode } from './music';

/**
 * Song model used by the scoring engine and the note highway. Beats are the canonical time
 * unit: for the recorded song, `BeatMap` (core/melody.ts) converts seconds to beats so the
 * same engine scores at any practice speed. The compact text format (`melody: "C4:1 D4 …"`)
 * is kept for unit tests, where a hand-written tune is easier to reason about than a pitch
 * track extracted from audio.
 */

export interface SongSource {
  id: string;
  title: string;
  credit: string;
  bpm: number;
  beatsPerBar: number;
  /** Tonic of the written key, e.g. "D" or "Bb". */
  tonic: string;
  mode: Mode;
  difficulty: 1 | 2 | 3;
  /**
   * Space-separated `Pitch:beats` tokens, e.g. `C4:1 D4 E4:2`. Duration is sticky.
   * `R:beats` is a rest. `|` asserts a bar line falls here.
   */
  melody: string;
  /**
   * One token per sung note. A token ending in `-` joins the next syllable into one word.
   * `~` continues the previous syllable (melisma). `/` (not a note) starts a new display line.
   */
  lyrics?: string;
  /**
   * Named practice sections, by 1-based bar numbers (inclusive) or, for phrases that start
   * on a pickup, by beat range `[start, end)`.
   */
  sections?: SectionSource[];
}

export type SectionSource = { name: string; from: number; to: number } | { name: string; beats: [number, number] };

export interface Note {
  index: number;
  midi: number;
  start: number;
  beats: number;
  /** Syllable as authored (may end in "-"), "" for melisma continuation or no lyric. */
  lyric: string;
  /** True when an authored lyric line starts at this note. */
  line?: boolean;
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
  bpm: number;
  beatsPerBar: number;
  tonicPc: number;
  mode: Mode;
  difficulty: 1 | 2 | 3;
  notes: Note[];
  sections: Section[];
  totalBeats: number;
  low: number;
  high: number;
  /** Duration-weighted mean pitch (where the song "sits"). */
  tessitura: number;
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

export function buildSong(src: SongSource): Song {
  const events = parseMelody(src.melody, src.beatsPerBar);
  const sung = events.filter((e) => e.midi !== null);
  const rawTokens = src.lyrics ? src.lyrics.trim().split(/\s+/) : [];
  const lyricTokens: string[] = [];
  const lineStarts = new Set<number>();
  for (const t of rawTokens) {
    if (t === '/') lineStarts.add(lyricTokens.length);
    else lyricTokens.push(t);
  }
  if (src.lyrics && lyricTokens.length !== sung.length) {
    throw new Error(`${src.id}: ${lyricTokens.length} lyric tokens for ${sung.length} notes`);
  }
  const explicitLines = lineStarts.size > 0;
  const notes: Note[] = sung.map((e, i) => ({
    index: i,
    midi: e.midi!,
    start: e.start,
    beats: e.beats,
    lyric: lyricTokens[i] === '~' ? '' : (lyricTokens[i] ?? ''),
    ...(explicitLines ? { line: i === 0 || lineStarts.has(i) } : {}),
  }));
  const tonicPc = TONIC_PC[src.tonic];
  if (tonicPc === undefined) throw new Error(`${src.id}: bad tonic ${src.tonic}`);
  const last = events[events.length - 1]!;
  return songFromNotes(
    {
      id: src.id,
      title: src.title,
      credit: src.credit,
      bpm: src.bpm,
      beatsPerBar: src.beatsPerBar,
      tonicPc,
      mode: src.mode,
      difficulty: src.difficulty,
    },
    notes,
    src.sections,
    last.start + last.beats,
  );
}

export type SongMeta = Pick<Song, 'id' | 'title' | 'credit' | 'bpm' | 'beatsPerBar' | 'tonicPc' | 'mode' | 'difficulty'>;

/** Assemble a Song from already-timed notes. */
export function songFromNotes(meta: SongMeta, notes: Note[], sectionsSrc?: SectionSource[], melodyEnd?: number): Song {
  if (!notes.length) throw new Error(`${meta.id}: no notes`);
  const lastNote = notes[notes.length - 1]!;
  const end = Math.max(melodyEnd ?? 0, lastNote.start + lastNote.beats);
  const totalBeats = Math.ceil(end / meta.beatsPerBar - 1e-9) * meta.beatsPerBar;
  const bars = totalBeats / meta.beatsPerBar;
  const src: SectionSource[] = sectionsSrc ?? [{ name: 'Song', from: 1, to: bars }];
  const sections: Section[] = src.map((s) => {
    const startBeat = 'beats' in s ? s.beats[0] : (s.from - 1) * meta.beatsPerBar;
    const endBeat = 'beats' in s ? s.beats[1] : s.to * meta.beatsPerBar;
    let noteFrom = notes.findIndex((n) => n.start >= startBeat - 1e-9);
    if (noteFrom < 0) noteFrom = notes.length;
    let noteTo = notes.findIndex((n) => n.start >= endBeat - 1e-9);
    if (noteTo < 0) noteTo = notes.length;
    return { name: s.name, startBeat, endBeat, noteFrom, noteTo };
  });
  return { ...meta, notes, sections, totalBeats, ...rangeOf(notes) };
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

/**
 * Display lines for notes [from, to): authored `/` breaks when the song has them, otherwise
 * a heuristic that breaks at punctuation, rests and long phrases without splitting words.
 */
export function lyricLines(song: Song, from: number, to: number): { noteFrom: number; noteTo: number }[] {
  const out: { noteFrom: number; noteTo: number }[] = [];
  let start = from;
  if (song.notes.some((n) => n.line !== undefined)) {
    for (let i = from + 1; i < to; i++) {
      if (song.notes[i]!.line) {
        out.push({ noteFrom: start, noteTo: i });
        start = i;
      }
    }
    out.push({ noteFrom: start, noteTo: to });
    return out;
  }
  for (let i = from; i < to; i++) {
    const n = song.notes[i]!;
    const next = song.notes[i + 1];
    const punct = /[,.;:!?]$/.test(n.lyric) && (i - start >= 5 || /[.!?]$/.test(n.lyric));
    const gap = next ? next.start - (n.start + n.beats) >= 1 : true;
    const long = i - start >= 13;
    const lastInWindow = i === to - 1;
    const midWord = n.lyric.endsWith('-') || (next !== undefined && next.lyric === '');
    if (lastInWindow || ((punct || gap || long) && !midWord)) {
      out.push({ noteFrom: start, noteTo: i + 1 });
      start = i + 1;
    }
  }
  return out;
}
