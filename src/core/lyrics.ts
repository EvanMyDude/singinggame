/**
 * Lyrics text and line timing.
 *
 * `lyrics.txt` is plain text: one lyric line per line, blank lines ignored, optional
 * `[Section name]` headers. Timing is a separate JSON document so the text can be re-imported
 * without losing the sync; a hash of the normalized text ties the two together.
 */

export interface LyricLine {
  index: number;
  text: string;
  /** Index into `sections`. */
  section: number;
}

export interface LyricSection {
  name: string;
  /** Line index range [from, to). */
  from: number;
  to: number;
}

export interface LyricsDoc {
  lines: LyricLine[];
  sections: LyricSection[];
  /** FNV-1a of the normalized line texts, hex. */
  hash: string;
}

export interface WordTiming {
  start: number;
  end: number;
}

export interface LineTiming {
  /** Song time (s) the line starts; NaN while unset. */
  start: number;
  /** Song time (s) the line ends; NaN while unset. */
  end: number;
  /** Verified word times, one per whitespace-separated word of the line. Absent = line-level only. */
  words?: WordTiming[];
}

export interface LyricTiming {
  version: 1;
  hash: string;
  lineCount: number;
  lines: LineTiming[];
}

export function normalizeLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** FNV-1a 32-bit over the joined lines; short and stable across platforms. */
export function hashLines(lines: readonly string[]): string {
  let h = 0x811c9dc5;
  const text = lines.map(normalizeLine).join('\n');
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function parseLyrics(text: string): LyricsDoc {
  const lines: LyricLine[] = [];
  const sections: LyricSection[] = [];
  let current: LyricSection | null = null;
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const s = normalizeLine(raw);
    if (!s) continue;
    const header = /^\[(.+)\]$/.exec(s);
    if (header) {
      if (current && current.to > current.from) sections.push(current);
      current = { name: header[1]!.trim(), from: lines.length, to: lines.length };
      continue;
    }
    if (!current) current = { name: `Part ${sections.length + 1}`, from: lines.length, to: lines.length };
    lines.push({ index: lines.length, text: s, section: sections.length });
    current.to = lines.length;
  }
  if (current && current.to > current.from) sections.push(current);
  return { lines, sections, hash: hashLines(lines.map((l) => l.text)) };
}

export function emptyTiming(doc: LyricsDoc): LyricTiming {
  return { version: 1, hash: doc.hash, lineCount: doc.lines.length, lines: doc.lines.map(() => ({ start: NaN, end: NaN })) };
}

/** Parses and validates a timing document; throws with a readable message. */
export function parseTiming(json: unknown): LyricTiming {
  if (!json || typeof json !== 'object') throw new Error('timing.json is not an object');
  const t = json as Partial<LyricTiming>;
  if (t.version !== 1 || typeof t.hash !== 'string' || !Array.isArray(t.lines)) throw new Error('timing.json has an unknown format');
  const lines: LineTiming[] = t.lines.map((l) => {
    const x = (l ?? {}) as Partial<LineTiming>;
    const start = typeof x.start === 'number' ? x.start : NaN;
    const end = typeof x.end === 'number' ? x.end : NaN;
    const words = Array.isArray(x.words) && x.words.every((w) => w && typeof w.start === 'number' && typeof w.end === 'number') ? x.words.map((w) => ({ start: w.start, end: w.end })) : undefined;
    return words ? { start, end, words } : { start, end };
  });
  return { version: 1, hash: t.hash, lineCount: typeof t.lineCount === 'number' ? t.lineCount : lines.length, lines };
}

/** True when the timing was made for this exact lyric text. */
export function timingMatches(t: LyricTiming, doc: LyricsDoc): boolean {
  return t.hash === doc.hash && t.lines.length === doc.lines.length;
}

export function timingComplete(t: LyricTiming): boolean {
  return t.lines.length > 0 && t.lines.every((l) => Number.isFinite(l.start));
}

/** Serialized form, with NaN written as null so the file stays valid JSON. */
export function timingToJSON(t: LyricTiming): string {
  const lines = t.lines.map((l) => ({
    start: Number.isFinite(l.start) ? Number(l.start.toFixed(3)) : null,
    end: Number.isFinite(l.end) ? Number(l.end.toFixed(3)) : null,
    ...(l.words ? { words: l.words.map((w) => ({ start: Number(w.start.toFixed(3)), end: Number(w.end.toFixed(3)) })) } : {}),
  }));
  return JSON.stringify({ version: 1, hash: t.hash, lineCount: t.lineCount, lines }, null, 1);
}

/**
 * Index of the line showing at song time `t`: the last line that has started. Returns -1
 * before the first line. Unset lines are skipped. Lines are assumed to be in song order.
 */
export function lineAt(t: LyricTiming, time: number): number {
  let idx = -1;
  for (let i = 0; i < t.lines.length; i++) {
    const s = t.lines[i]!.start;
    if (Number.isFinite(s) && s <= time) idx = i;
    else if (Number.isFinite(s) && s > time) break;
  }
  return idx;
}

/** Index of the word being sung at `time` within line `i`, or -1 without word timing. */
export function wordAt(t: LyricTiming, i: number, time: number): number {
  const w = t.lines[i]?.words;
  if (!w) return -1;
  let idx = -1;
  for (let k = 0; k < w.length; k++) if (w[k]!.start <= time) idx = k;
  return idx;
}

/** Fill line ends from the next line's start (or `songEnd`) wherever an end is unset. */
export function fillEnds(t: LyricTiming, songEnd: number, gap = 0.05): LyricTiming {
  const lines = t.lines.map((l, i) => {
    if (Number.isFinite(l.end)) return l;
    let next = songEnd;
    for (let k = i + 1; k < t.lines.length; k++) {
      if (Number.isFinite(t.lines[k]!.start)) {
        next = t.lines[k]!.start;
        break;
      }
    }
    return { ...l, end: Number.isFinite(l.start) ? Math.max(l.start + 0.2, next - gap) : NaN };
  });
  return { ...t, lines };
}

/** Snap a tapped time to the nearest onset within `window` seconds, else keep it. */
export function snapToOnset(time: number, onsets: readonly number[], window = 0.3): number {
  let best = time;
  let bd = window;
  for (const o of onsets) {
    const d = Math.abs(o - time);
    if (d < bd) {
      bd = d;
      best = o;
    }
  }
  return best;
}

/**
 * Pre-fill timing from detected vocal phrases when there is exactly one phrase per line.
 * Returns null when the counts differ: a guess would be wrong somewhere, which is worse
 * than tapping.
 */
export function timingFromPhrases(doc: LyricsDoc, phrases: readonly { t: number; e: number }[]): LyricTiming | null {
  if (!doc.lines.length || phrases.length !== doc.lines.length) return null;
  return {
    version: 1,
    hash: doc.hash,
    lineCount: doc.lines.length,
    lines: phrases.map((p) => ({ start: p.t, end: p.e })),
  };
}
