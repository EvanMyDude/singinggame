import type { Chord, ChordQuality, Song } from './song';

/**
 * Generates the backing arrangement (bass, keys, pad, light drums) from a song's chord
 * track. Pure and deterministic so it can be unit tested and re-run after transposition.
 */

export type TonePart = 'bass' | 'keys' | 'pad';
export type DrumKind = 'kick' | 'snare' | 'hat' | 'click' | 'clickAccent';

export interface ToneEvent {
  beat: number;
  beats: number;
  midi: number;
  part: TonePart;
  vel: number;
}

export interface DrumEvent {
  beat: number;
  kind: DrumKind;
  vel: number;
}

export interface Arrangement {
  tones: ToneEvent[];
  drums: DrumEvent[];
}

const INTERVALS: Record<ChordQuality, number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  '7': [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  dim: [0, 3, 6],
  sus4: [0, 5, 7],
  none: [],
};

/** Closed-position voicing nearest the previous one (smooth voice leading), kept in 53..72. */
export function voiceChord(root: number, quality: ChordQuality, prevCenter: number): number[] {
  const ints = INTERVALS[quality];
  if (!ints.length || root < 0) return [];
  let best: number[] = [];
  let bestScore = Infinity;
  for (let inv = 0; inv < ints.length; inv++) {
    const pcs = ints.map((iv) => (root + iv) % 12);
    const rotated = [...pcs.slice(inv), ...pcs.slice(0, inv)];
    for (const base of [48, 60]) {
      const voicing: number[] = [];
      let prev = base - 1;
      for (const pc of rotated) {
        let m = base + pc;
        while (m <= prev) m += 12;
        voicing.push(m);
        prev = m;
      }
      if (voicing[0]! < 53 || voicing[voicing.length - 1]! > 72) continue;
      const center = voicing.reduce((s, v) => s + v, 0) / voicing.length;
      const score = Math.abs(center - prevCenter) + 0.3 * Math.abs(center - 62);
      if (score < bestScore) {
        bestScore = score;
        best = voicing;
      }
    }
  }
  return best;
}

export function bassNote(root: number): number {
  return 40 + ((root - 4 + 12) % 12); // E2..D#3
}

function chordAt(chords: readonly Chord[], beat: number): Chord | null {
  for (const c of chords) if (beat >= c.start - 1e-9 && beat < c.start + c.beats - 1e-9) return c;
  return null;
}

export function arrange(song: Song): Arrangement {
  const tones: ToneEvent[] = [];
  const drums: DrumEvent[] = [];
  const bpb = song.beatsPerBar;
  const style = song.style;
  let center = 62;
  const voicings = new Map<Chord, number[]>();
  for (const c of song.chords) {
    const v = voiceChord(c.root, c.quality, center);
    if (v.length) center = v.reduce((s, x) => s + x, 0) / v.length;
    voicings.set(c, v);
  }

  if (style !== 'none') {
    for (let b = 0; b < song.totalBeats; b++) {
      const c = chordAt(song.chords, b);
      if (!c || c.root < 0) continue;
      const v = voicings.get(c)!;
      const inBar = b % bpb;
      const chordStartsHere = Math.abs(c.start - b) < 1e-9 || inBar === 0;
      const remaining = c.start + c.beats - b;
      const bass = bassNote(c.root);
      const fifth = bass + 7 <= 52 ? bass + 7 : bass - 5;

      switch (style) {
        case 'gentle': {
          if (chordStartsHere) tones.push({ beat: b, beats: Math.min(remaining, bpb), midi: bass, part: 'bass', vel: 0.55 });
          if (chordStartsHere) for (const m of v) tones.push({ beat: b, beats: Math.min(remaining, bpb), midi: m, part: 'pad', vel: 0.32 });
          // Broken chord on every beat: low, high, middle, high.
          const order = [0, v.length - 1, 1, v.length - 1];
          tones.push({ beat: b, beats: 0.9, midi: v[order[inBar % 4]!]! + 12, part: 'keys', vel: 0.28 });
          break;
        }
        case 'hymn': {
          if (chordStartsHere) for (const m of v) tones.push({ beat: b, beats: Math.min(remaining, bpb), midi: m, part: 'pad', vel: 0.36 });
          if (chordStartsHere || inBar === 2) tones.push({ beat: b, beats: Math.min(remaining, 2), midi: inBar === 2 && !chordStartsHere ? fifth : bass, part: 'bass', vel: 0.6 });
          for (const m of v) tones.push({ beat: b, beats: 0.6, midi: m, part: 'keys', vel: inBar === 0 ? 0.24 : 0.16 });
          break;
        }
        case 'waltz': {
          if (inBar === 0 || chordStartsHere) {
            tones.push({ beat: b, beats: Math.min(remaining, 1.5), midi: bass, part: 'bass', vel: 0.62 });
          }
          if (inBar !== 0) for (const m of v) tones.push({ beat: b, beats: 0.55, midi: m, part: 'keys', vel: 0.22 });
          if (chordStartsHere) for (const m of v) tones.push({ beat: b, beats: Math.min(remaining, bpb), midi: m, part: 'pad', vel: 0.18 });
          break;
        }
        case 'march': {
          if (inBar % 2 === 0) tones.push({ beat: b, beats: 0.9, midi: inBar === 2 ? fifth : bass, part: 'bass', vel: 0.66 });
          else for (const m of v) tones.push({ beat: b, beats: 0.45, midi: m, part: 'keys', vel: 0.26 });
          break;
        }
        case 'ballad': {
          if (chordStartsHere) {
            tones.push({ beat: b, beats: Math.min(remaining, bpb), midi: bass, part: 'bass', vel: 0.55 });
            for (const m of v) tones.push({ beat: b, beats: Math.min(remaining, bpb), midi: m, part: 'pad', vel: 0.26 });
          }
          // Eighth-note arpeggio up through the chord and back.
          const arp = [...v, v[0]! + 12];
          for (let h = 0; h < 2; h++) {
            const step = (inBar * 2 + h) % (arp.length * 2 - 2);
            const idx = step < arp.length ? step : arp.length * 2 - 2 - step;
            tones.push({ beat: b + h * 0.5, beats: 0.9, midi: arp[idx]!, part: 'keys', vel: 0.2 });
          }
          break;
        }
      }
    }
  }

  // Imported songs have no chords: keep a soft pulse so the beat is still felt.
  if (style === 'none') {
    for (let b = 0; b < song.totalBeats; b++) {
      drums.push({ beat: b, kind: b % bpb === 0 ? 'kick' : 'hat', vel: b % bpb === 0 ? 0.35 : 0.14 });
    }
  }

  // Light timekeeping so the beat is always felt, quieter than the instruments.
  if (style !== 'none') {
    for (let b = 0; b < song.totalBeats; b++) {
      const inBar = b % bpb;
      const hasChord = !!chordAt(song.chords, b) && chordAt(song.chords, b)!.root >= 0;
      if (!hasChord) continue;
      if (inBar === 0) drums.push({ beat: b, kind: 'kick', vel: 0.5 });
      if (style === 'march') {
        if (inBar === 2) drums.push({ beat: b, kind: 'kick', vel: 0.38 });
        if (inBar % 2 === 1) drums.push({ beat: b, kind: 'snare', vel: 0.3 });
        drums.push({ beat: b, kind: 'hat', vel: 0.16 }, { beat: b + 0.5, kind: 'hat', vel: 0.1 });
      } else {
        drums.push({ beat: b, kind: 'hat', vel: inBar === 0 ? 0.14 : 0.09 });
      }
    }
  }
  return { tones, drums };
}

/**
 * Count-in clicks: one full bar before `fromBeat`, continuing through any leading rest
 * (pickup) beats so the first sung note is always cued.
 */
export function countIn(song: Song, fromBeat = 0): DrumEvent[] {
  const bpb = song.beatsPerBar;
  const firstNote = song.notes.find((n) => n.start >= fromBeat - 1e-9);
  const first = firstNote ? firstNote.start : fromBeat;
  const out: DrumEvent[] = [];
  for (let b = fromBeat - bpb; b < Math.floor(first + 1e-9); b++) {
    const inBar = ((b % bpb) + bpb) % bpb;
    out.push({ beat: b, kind: inBar === 0 ? 'clickAccent' : 'click', vel: 0.7 });
  }
  return out;
}
