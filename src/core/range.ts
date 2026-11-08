import type { Song } from './song';

export interface VocalRange {
  /** Comfortable low and high notes, MIDI (may be fractional from measurement). */
  low: number;
  high: number;
}

export const RANGE_PRESETS: { id: string; label: string; detail: string; range: VocalRange }[] = [
  { id: 'low', label: 'Low voice', detail: 'Bass / baritone', range: { low: 45, high: 62 } },
  { id: 'midlow', label: 'Mid-low voice', detail: 'Tenor', range: { low: 48, high: 67 } },
  { id: 'midhigh', label: 'Mid-high voice', detail: 'Alto / mezzo', range: { low: 53, high: 72 } },
  { id: 'high', label: 'High voice', detail: 'Soprano', range: { low: 57, high: 77 } },
];

const VOICE_TYPES: { name: string; center: number }[] = [
  { name: 'Bass', center: 51 },
  { name: 'Baritone', center: 55 },
  { name: 'Tenor', center: 59 },
  { name: 'Alto', center: 63 },
  { name: 'Mezzo-soprano', center: 66 },
  { name: 'Soprano', center: 69 },
];

/** Rough voice-type label from the center of a comfortable range. Informational only. */
export function voiceTypeFor(range: VocalRange): string {
  const c = (range.low + range.high) / 2;
  let best = VOICE_TYPES[0]!;
  for (const v of VOICE_TYPES) if (Math.abs(v.center - c) < Math.abs(best.center - c)) best = v;
  return best.name;
}

export interface TranspositionChoice {
  semitones: number;
  /** True when the written key already sits comfortably and was kept. */
  keptOriginal: boolean;
  /** Largest distance (semitones) any note falls outside the range after shifting. */
  maxOutside: number;
}

/**
 * Pick the shift that keeps every note inside the comfortable range and puts the song's
 * tessitura slightly below the middle of that range (where sustained singing is easiest).
 * The written key wins when it already fits with its tessitura within 3 semitones of ideal.
 */
export function chooseTransposition(song: Pick<Song, 'notes' | 'tessitura'>, range: VocalRange): TranspositionChoice {
  const ideal = range.low + 0.45 * (range.high - range.low);
  const totalBeats = song.notes.reduce((s, n) => s + n.beats, 0) || 1;
  const evalShift = (k: number) => {
    let maxOut = 0;
    let weighted = 0;
    for (const n of song.notes) {
      const m = n.midi + k;
      const out = Math.max(0, range.low - m, m - range.high);
      if (out > maxOut) maxOut = out;
      weighted += out * n.beats;
    }
    const cost = 3 * maxOut + 6 * (weighted / totalBeats) + Math.abs(song.tessitura + k - ideal) + 0.15 * Math.abs(k);
    return { maxOut, cost };
  };
  const original = evalShift(0);
  if (original.maxOut === 0 && Math.abs(song.tessitura - ideal) <= 3) {
    return { semitones: 0, keptOriginal: true, maxOutside: 0 };
  }
  let best = { k: 0, ...original };
  for (let k = -24; k <= 24; k++) {
    const e = evalShift(k);
    if (e.cost < best.cost - 1e-9) best = { k, ...e };
  }
  return { semitones: best.k, keptOriginal: best.k === 0, maxOutside: best.maxOut };
}
