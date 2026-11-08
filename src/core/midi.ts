import { songFromNotes, type Note, type Song } from './song';

/**
 * Minimal Standard MIDI File reader (formats 0 and 1, PPQ timing) and a converter that pulls
 * a singable monophonic melody out of it. Drum channel 10 is ignored; tempo changes are
 * flattened to the first tempo because playback is resynthesized at one tempo.
 */

export interface RawNote {
  tick: number;
  end: number;
  pitch: number;
  vel: number;
  channel: number;
}

export interface MidiTrack {
  index: number;
  name: string;
  notes: RawNote[];
  lyrics: { tick: number; text: string }[];
}

export interface MidiFile {
  format: number;
  division: number;
  tracks: MidiTrack[];
  tempos: { tick: number; usPerQuarter: number }[];
  timeSig: { num: number; den: number } | null;
}

class Reader {
  pos = 0;
  constructor(private readonly d: DataView) {}
  get length() {
    return this.d.byteLength;
  }
  u8() {
    if (this.pos >= this.d.byteLength) throw new Error('Unexpected end of MIDI data');
    return this.d.getUint8(this.pos++);
  }
  u16() {
    const v = this.d.getUint16(this.pos);
    this.pos += 2;
    return v;
  }
  u32() {
    const v = this.d.getUint32(this.pos);
    this.pos += 4;
    return v;
  }
  str(n: number) {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.u8());
    return s;
  }
  vlq() {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const b = this.u8();
      v = (v << 7) | (b & 0x7f);
      if (!(b & 0x80)) return v;
    }
    throw new Error('Bad variable-length value');
  }
  bytes(n: number) {
    const out = new Uint8Array(this.d.buffer, this.d.byteOffset + this.pos, n);
    this.pos += n;
    return out;
  }
}

function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('latin1').decode(bytes);
  }
}

export function parseMidi(buf: ArrayBuffer): MidiFile {
  const r = new Reader(new DataView(buf));
  if (r.length < 14 || r.str(4) !== 'MThd') throw new Error('Not a MIDI file');
  const hlen = r.u32();
  const format = r.u16();
  const ntrks = r.u16();
  const division = r.u16();
  r.pos = 8 + hlen;
  if (division & 0x8000) throw new Error('SMPTE-timed MIDI files are not supported');
  if (format > 1) throw new Error('MIDI format 2 is not supported');

  const tracks: MidiTrack[] = [];
  const tempos: MidiFile['tempos'] = [];
  let timeSig: MidiFile['timeSig'] = null;

  for (let t = 0; t < ntrks && r.pos + 8 <= r.length; t++) {
    const id = r.str(4);
    const len = r.u32();
    const end = Math.min(r.length, r.pos + len);
    if (id !== 'MTrk') {
      r.pos = end;
      continue;
    }
    const track: MidiTrack = { index: tracks.length, name: '', notes: [], lyrics: [] };
    const open = new Map<number, { tick: number; vel: number }[]>();
    let tick = 0;
    let status = 0;
    while (r.pos < end) {
      tick += r.vlq();
      let b = r.u8();
      if (b === 0xff) {
        const type = r.u8();
        const l = r.vlq();
        const data = r.bytes(l);
        if (type === 0x03 && !track.name) track.name = decodeText(data).trim();
        else if (type === 0x05 || (type === 0x01 && !(data[0] === 0x40))) {
          // 0x05 lyric; 0x01 text is used for lyrics in .kar files ("@" lines are metadata).
          track.lyrics.push({ tick, text: decodeText(data) });
        } else if (type === 0x51 && l === 3) tempos.push({ tick, usPerQuarter: (data[0]! << 16) | (data[1]! << 8) | data[2]! });
        else if (type === 0x58 && l >= 2 && !timeSig) timeSig = { num: data[0]!, den: 2 ** data[1]! };
        else if (type === 0x2f) break;
        continue;
      }
      if (b === 0xf0 || b === 0xf7) {
        r.pos += r.vlq();
        continue;
      }
      let first: number;
      if (b < 0x80) {
        if (!status) throw new Error('Running status without a status byte');
        first = b;
        b = status;
      } else {
        status = b;
        first = r.u8();
      }
      const kind = b & 0xf0;
      const ch = b & 0x0f;
      const second = kind === 0xc0 || kind === 0xd0 ? 0 : r.u8();
      if (kind === 0x90 && second > 0) {
        const key = (ch << 8) | first;
        const list = open.get(key) ?? [];
        list.push({ tick, vel: second });
        open.set(key, list);
      } else if (kind === 0x80 || (kind === 0x90 && second === 0)) {
        const key = (ch << 8) | first;
        const list = open.get(key);
        const on = list?.shift();
        if (on && tick > on.tick) track.notes.push({ tick: on.tick, end: tick, pitch: first, vel: on.vel, channel: ch });
      }
    }
    r.pos = end;
    track.notes.sort((a, b) => a.tick - b.tick || b.pitch - a.pitch);
    tracks.push(track);
  }
  return { format, division, tracks, tempos, timeSig };
}

/** How melody-like a track is: many notes, mostly one at a time, in a singing register. */
export function melodyScore(t: MidiTrack): number {
  const notes = t.notes.filter((n) => n.channel !== 9);
  if (notes.length < 8) return 0;
  let overlapped = 0;
  for (let i = 1; i < notes.length; i++) {
    const prev = notes[i - 1]!;
    if (notes[i]!.tick < prev.end - (prev.end - prev.tick) * 0.25) overlapped++;
  }
  const mono = 1 - overlapped / notes.length;
  const mean = notes.reduce((s, n) => s + n.pitch, 0) / notes.length;
  const register = Math.exp(-(((mean - 67) / 12) ** 2));
  const lyricBonus = t.lyrics.length > 4 ? 1.5 : 1;
  return Math.log(notes.length + 1) * mono * mono * register * lyricBonus;
}

const MAJOR = [0, 2, 4, 5, 7, 9, 11];

/** Rough major-key estimate from a duration-weighted pitch-class histogram. */
export function estimateTonic(notes: { midi: number; beats: number }[]): number {
  const hist = new Array<number>(12).fill(0);
  for (const n of notes) hist[((n.midi % 12) + 12) % 12]! += n.beats;
  let best = 0;
  let bestScore = -1;
  for (let t = 0; t < 12; t++) {
    const s = MAJOR.reduce((acc, iv) => acc + hist[(t + iv) % 12]!, 0) + 0.5 * hist[t]! + 0.25 * hist[(t + 7) % 12]!;
    if (s > bestScore) {
      bestScore = s;
      best = t;
    }
  }
  return best;
}

export interface ImportResult {
  song: Song;
  note: string;
}

export function midiToSong(file: MidiFile, meta: { id: string; title: string }): ImportResult {
  const candidates = file.tracks.filter((t) => t.notes.some((n) => n.channel !== 9));
  if (!candidates.length) throw new Error('No melodic notes found in this MIDI file');
  const track = [...candidates].sort((a, b) => melodyScore(b) - melodyScore(a))[0]!;
  const ppq = file.division;
  const q = 48; // quantize to 1/48 beat (covers 16ths and triplets)
  const toBeat = (tick: number) => Math.round((tick / ppq) * q) / q;

  // Monophonize: highest note wins on shared onsets; each note ends where the next begins.
  const raw = track.notes.filter((n) => n.channel !== 9).map((n) => ({ start: toBeat(n.tick), end: toBeat(n.end), midi: n.pitch, tick: n.tick }));
  raw.sort((a, b) => a.start - b.start || b.midi - a.midi);
  const mono: typeof raw = [];
  for (const n of raw) {
    const prev = mono[mono.length - 1];
    if (prev && Math.abs(prev.start - n.start) < 1 / 32) continue;
    if (prev && prev.end > n.start) prev.end = n.start;
    mono.push({ ...n });
  }
  let notes = mono.filter((n) => n.end - n.start >= 1 / 16);
  const notesNote: string[] = [];
  if (notes.length > 1500) {
    notes = notes.slice(0, 1500);
    notesNote.push('trimmed to the first 1500 notes');
  }
  if (!notes.length) throw new Error('The melody track has no usable notes');

  // Shift so the first note starts in the first bar, keeping its position within the bar.
  const bpb = file.timeSig ? Math.max(1, Math.round((file.timeSig.num * 4) / file.timeSig.den)) : 4;
  const offset = Math.floor(notes[0]!.start / bpb) * bpb;

  // Lyrics (karaoke files): attach each syllable to the nearest note onset.
  const lyricEvents = (track.lyrics.length ? track.lyrics : file.tracks.flatMap((t) => t.lyrics))
    .map((l) => ({ beat: toBeat(l.tick), text: l.text.replace(/[\\/]/g, '').replace(/\r|\n/g, '') }))
    .filter((l) => l.text.trim());
  const lyricFor = new Map<number, string>();
  for (let i = 0; i < lyricEvents.length; i++) {
    const l = lyricEvents[i]!;
    let bestIdx = -1;
    let bestD = 0.26;
    for (let k = 0; k < notes.length; k++) {
      const d = Math.abs(notes[k]!.start - l.beat);
      if (d < bestD) {
        bestD = d;
        bestIdx = k;
      }
      if (notes[k]!.start > l.beat + 1) break;
    }
    if (bestIdx < 0 || lyricFor.has(bestIdx)) continue;
    const next = lyricEvents[i + 1];
    const joins = !/\s$/.test(l.text) && next !== undefined && !/^\s/.test(next.text);
    lyricFor.set(bestIdx, l.text.trim() + (joins ? '-' : ''));
  }

  const finalNotes: Note[] = notes.map((n, i) => ({
    index: i,
    midi: n.midi,
    start: n.start - offset,
    beats: n.end - n.start,
    lyric: lyricFor.get(i) ?? '',
  }));

  const firstTempo = file.tempos[0]?.usPerQuarter ?? 500000;
  const bpm = Math.round(60_000_000 / firstTempo);
  if (new Set(file.tempos.map((t) => t.usPerQuarter)).size > 1) notesNote.push(`tempo changes flattened to ${bpm} BPM`);

  const lastEnd = Math.max(...finalNotes.map((n) => n.start + n.beats));
  const bars = Math.ceil(lastEnd / bpb - 1e-9);
  const sections: { name: string; from: number; to: number }[] = [];
  for (let b = 1; b <= bars; b += 4) sections.push({ name: `Bars ${b}–${Math.min(bars, b + 3)}`, from: b, to: Math.min(bars, b + 3) });

  const song = songFromNotes(
    {
      id: meta.id,
      title: meta.title,
      credit: track.name ? `Track: ${track.name}` : 'Imported MIDI',
      pdNote: 'Imported from your own file; it stays in this browser.',
      bpm: Math.max(30, Math.min(240, bpm)),
      beatsPerBar: bpb,
      tonicPc: estimateTonic(finalNotes),
      mode: 'major',
      difficulty: 2,
      style: 'none',
    },
    finalNotes,
    [],
    sections,
  );
  song.imported = true;
  return { song, note: notesNote.join(', ') };
}
