import { buildSong, type Song, type SongSource } from './song';

/**
 * Built-in songs. Every melody and lyric here is in the public domain; see each `pdNote`
 * and docs/SONG_SOURCES.md for the verification sources. Accompaniment is generated in the
 * browser from the chord symbols, so no recordings or arrangements are reproduced.
 */
export const SOURCES: SongSource[] = [
  {
    id: 'twinkle',
    title: 'Twinkle, Twinkle, Little Star',
    credit: 'French melody (1761) · words Jane Taylor (1806)',
    pdNote: 'Public domain: melody "Ah! vous dirai-je, maman" published 1761; poem "The Star" by Jane Taylor, 1806.',
    bpm: 96,
    beatsPerBar: 4,
    tonic: 'C',
    mode: 'major',
    difficulty: 1,
    style: 'gentle',
    melody: `
      C4:1 C4 G4 G4 | A4 A4 G4:2 | F4:1 F4 E4 E4 | D4 D4 C4:2 |
      G4:1 G4 F4 F4 | E4 E4 D4:2 | G4:1 G4 F4 F4 | E4 E4 D4:2 |
      C4:1 C4 G4 G4 | A4 A4 G4:2 | F4:1 F4 E4 E4 | D4 D4 C4:2`,
    lyrics: `
      Twin- kle twin- kle lit- tle star, How I won- der what you are.
      Up a- bove the world so high, Like a dia- mond in the sky.
      Twin- kle twin- kle lit- tle star, How I won- der what you are.`,
    chords: `
      C:4 | F:2 C:2 | F:2 C:2 | G:2 C:2 |
      C:2 F:2 | C:2 G:2 | C:2 F:2 | C:2 G:2 |
      C:4 | F:2 C:2 | F:2 C:2 | G:2 C:2`,
    sections: [
      { name: 'Twinkle, twinkle', from: 1, to: 4 },
      { name: 'Up above the world', from: 5, to: 8 },
      { name: 'Twinkle (ending)', from: 9, to: 12 },
    ],
  },
];

export const LIBRARY: Song[] = SOURCES.map(buildSong);
