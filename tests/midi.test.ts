import { describe, expect, it } from 'vitest';
import { estimateTonic, midiToSong, parseMidi } from '../src/core/midi';

/** Tiny SMF writer for tests. Events: [deltaTicks, ...bytes]. */
function vlq(n: number): number[] {
  const out = [n & 0x7f];
  while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80);
  return out;
}
function track(events: number[][]): number[] {
  const body: number[] = [];
  for (const [delta, ...bytes] of events) body.push(...vlq(delta!), ...bytes);
  body.push(0, 0xff, 0x2f, 0);
  const len = body.length;
  return [0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, ...body];
}
function text(type: number, s: string): number[] {
  const b = [...new TextEncoder().encode(s)];
  return [0xff, type, ...vlq(b.length), ...b];
}
function smf(tracks: number[][], ppq = 480): ArrayBuffer {
  const head = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, tracks.length, (ppq >> 8) & 255, ppq & 255];
  return new Uint8Array([...head, ...tracks.flat()]).buffer;
}

const PPQ = 480;
// C D E F G (quarters) with lyrics, using running status for the note-offs.
const melody = track([
  [0, ...text(0x03, 'Lead')],
  [0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20], // 120 BPM
  [0, 0xff, 0x58, 4, 3, 2, 24, 8], // 3/4
  [0, ...text(0x05, 'Hel')],
  [0, 0x90, 60, 90],
  [PPQ, 60, 0], // running status, velocity 0 = off
  [0, ...text(0x05, 'lo ')],
  [0, 62, 90],
  [PPQ, 0x80, 62, 0],
  [0, ...text(0x05, 'world ')],
  [0, 0x90, 64, 90],
  [PPQ, 0x80, 64, 0],
  [0, 0x90, 65, 90],
  [PPQ, 0x80, 65, 0],
  [0, 0x90, 67, 90],
  [PPQ * 2, 0x80, 67, 0],
  [0, 0x90, 64, 90],
  [PPQ, 0x80, 64, 0],
  [0, 0x90, 60, 90],
  [PPQ, 0x80, 60, 0],
  [0, 0x90, 62, 90],
  [PPQ, 0x80, 62, 0],
]);
// Block chords: polyphonic, lower register; should lose to the melody.
const chords = track([
  [0, ...text(0x03, 'Piano')],
  ...[0, 1, 2, 3].flatMap((bar) => [
    [bar === 0 ? 0 : 0, 0x91, 48, 70],
    [0, 0x91, 52, 70],
    [0, 0x91, 55, 70],
    [PPQ * 3, 0x81, 48, 0],
    [0, 0x81, 52, 0],
    [0, 0x81, 55, 0],
  ]),
]);
const drums = track([
  ...Array.from({ length: 12 }, () => [
    [0, 0x99, 36, 100],
    [PPQ, 0x89, 36, 0],
  ]).flat(),
]);

describe('MIDI import', () => {
  it('parses tracks, tempo, time signature, running status and lyrics', () => {
    const f = parseMidi(smf([melody, chords, drums], PPQ));
    expect(f.division).toBe(PPQ);
    expect(f.tracks).toHaveLength(3);
    expect(f.tempos[0]!.usPerQuarter).toBe(500000);
    expect(f.timeSig).toEqual({ num: 3, den: 4 });
    expect(f.tracks[0]!.notes.map((n) => n.pitch)).toEqual([60, 62, 64, 65, 67, 64, 60, 62]);
    expect(f.tracks[0]!.lyrics.map((l) => l.text)).toEqual(['Hel', 'lo ', 'world ']);
  });

  it('picks the melody track, keeps beats, joins syllables', () => {
    const { song } = midiToSong(parseMidi(smf([chords, melody, drums], PPQ)), { id: 'x', title: 'Test' });
    expect(song.notes.map((n) => n.midi)).toEqual([60, 62, 64, 65, 67, 64, 60, 62]);
    expect(song.notes.map((n) => n.start)).toEqual([0, 1, 2, 3, 4, 6, 7, 8]);
    expect(song.notes[4]!.beats).toBe(2);
    expect(song.bpm).toBe(120);
    expect(song.beatsPerBar).toBe(3);
    expect(song.notes.slice(0, 3).map((n) => n.lyric)).toEqual(['Hel-', 'lo', 'world']);
    expect(song.imported).toBe(true);
    expect(song.sections.length).toBeGreaterThan(0);
  });

  it('rejects files that are not MIDI', () => {
    expect(() => parseMidi(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]).buffer)).toThrow(/Not a MIDI/);
  });

  it('estimates a major tonic', () => {
    const scale = [62, 64, 66, 67, 69, 71, 73, 74].map((midi) => ({ midi, beats: 1 }));
    expect(estimateTonic(scale)).toBe(2); // D major
  });
});
