/** Pitch math and naming. MIDI 69 = A4 = 440 Hz. */

export const A4_HZ = 440;

export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / A4_HZ);
}

export function midiToHz(midi: number): number {
  return A4_HZ * Math.pow(2, (midi - 69) / 12);
}

/** Signed cents from `targetMidi` to `midi` (positive = sharp). */
export function centsBetween(midi: number, targetMidi: number): number {
  return (midi - targetMidi) * 100;
}

/**
 * Signed cents error, optionally folded to the octave nearest the target so that
 * singing the right note in another octave counts. Result is in (-600, 600] when folded.
 */
export function centsError(midi: number, targetMidi: number, foldOctaves: boolean): number {
  let c = (midi - targetMidi) * 100;
  if (foldOctaves) {
    c = c - 1200 * Math.round(c / 1200);
  }
  return c;
}

/** Shift `midi` by whole octaves so it lands as close as possible to `targetMidi`. */
export function foldToOctaveOf(midi: number, targetMidi: number): number {
  return midi - 12 * Math.round((midi - targetMidi) / 12);
}

const SHARP_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const FLAT_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];

export function pitchClass(midi: number): number {
  return ((Math.round(midi) % 12) + 12) % 12;
}

export function noteName(midi: number, preferFlats = false): string {
  const pc = pitchClass(midi);
  return (preferFlats ? FLAT_NAMES : SHARP_NAMES)[pc]!;
}

export function noteNameWithOctave(midi: number, preferFlats = false): string {
  const m = Math.round(midi);
  return `${noteName(m, preferFlats)}${Math.floor(m / 12) - 1}`;
}

/** Major keys conventionally spelled with flats (by tonic pitch class). */
const FLAT_MAJOR_TONICS = new Set([5, 10, 3, 8, 1]); // F Bb Eb Ab Db
/** Minor keys conventionally spelled with flats. */
const FLAT_MINOR_TONICS = new Set([2, 7, 0, 5, 10, 3]); // D G C F Bb Eb

export type Mode = 'major' | 'minor';

export function keyPrefersFlats(tonicPc: number, mode: Mode): boolean {
  return mode === 'major' ? FLAT_MAJOR_TONICS.has(tonicPc) : FLAT_MINOR_TONICS.has(tonicPc);
}

export function keyName(tonicPc: number, mode: Mode): string {
  const pc = ((tonicPc % 12) + 12) % 12;
  const flats = keyPrefersFlats(pc, mode);
  // F# major reads better than Gb major for most people; keep sharps for 6.
  return `${noteName(pc, flats)} ${mode}`;
}

/** Parse "C4", "F#3", "Bb5", "Eb4" into MIDI. Throws on malformed input. */
export function parseNote(token: string): number {
  const m = /^([A-Ga-g])([#b♯♭]?)(-?\d)$/.exec(token);
  if (!m) throw new Error(`Bad note "${token}"`);
  const base: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  let pc = base[m[1]!.toUpperCase()]!;
  if (m[2] === '#' || m[2] === '♯') pc += 1;
  if (m[2] === 'b' || m[2] === '♭') pc -= 1;
  const octave = Number(m[3]);
  return (octave + 1) * 12 + pc;
}

const INTERVAL_NAMES = [
  'Unison',
  'Minor 2nd',
  'Major 2nd',
  'Minor 3rd',
  'Major 3rd',
  'Perfect 4th',
  'Tritone',
  'Perfect 5th',
  'Minor 6th',
  'Major 6th',
  'Minor 7th',
  'Major 7th',
  'Octave',
];

export function intervalName(semitones: number): string {
  const s = Math.abs(Math.round(semitones));
  if (s <= 12) return INTERVAL_NAMES[s]!;
  return `${s} semitones`;
}
