import { buildSong, type Song, type SongSource } from './song';

/**
 * Built-in songs. Every melody and lyric here is in the public domain; see each `pdNote`
 * and docs/SONG_SOURCES.md for the sources used to verify status and notes. Accompaniment is
 * generated in the browser from the chord symbols, so no recordings or arrangements are
 * reproduced. Melodies are re-keyed from the cited scores into this project's own format.
 */
export const SOURCES: SongSource[] = [
  {
    id: 'twinkle',
    title: 'Twinkle, Twinkle, Little Star',
    credit: 'French melody (1761) · words Jane Taylor (1806)',
    pdNote: 'Public domain: melody "Ah! vous dirai-je, maman" first published 1761; poem "The Star" by Jane Taylor, 1806.',
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
      Twin- kle twin- kle lit- tle star, / How I won- der what you are! /
      Up a- bove the world so high, / Like a dia- mond in the sky. /
      Twin- kle twin- kle lit- tle star, / How I won- der what you are!`,
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
  {
    id: 'frere-jacques',
    title: 'Are You Sleeping? (Frère Jacques)',
    credit: 'French traditional (c. 1780) · traditional English words',
    pdNote: 'Public domain: tune in a French manuscript c. 1780, first published 1811; traditional English words "Are you sleeping, Brother John?".',
    bpm: 100,
    beatsPerBar: 4,
    tonic: 'F',
    mode: 'major',
    difficulty: 1,
    style: 'hymn',
    melody: `
      F4:1 G4 A4 F4 | F4 G4 A4 F4 | A4 Bb4 C5:2 | A4:1 Bb4 C5:2 |
      C5:0.5 D5 C5 Bb4 A4:1 F4 | C5:0.5 D5 C5 Bb4 A4:1 F4 | F4 C4 F4:2 | F4:1 C4 F4:2`,
    lyrics: `
      Are you sleep- ing? Are you sleep- ing? / Broth- er John, Broth- er John, /
      Morn- ing bells are ring- ing! / Morn- ing bells are ring- ing! / Ding, dang, dong. Ding, dang, dong.`,
    chords: `
      F:4 | F:4 | F:4 | F:4 |
      F:1 C7:1 F:2 | F:1 C7:1 F:2 | F:1 C:1 F:2 | F:1 C:1 F:2`,
    sections: [
      { name: 'Are you sleeping, Brother John', from: 1, to: 4 },
      { name: 'Morning bells are ringing', from: 5, to: 8 },
    ],
  },
  {
    id: 'ode-to-joy',
    title: 'Ode to Joy (Joyful, Joyful)',
    credit: 'Beethoven (1824) · words Henry van Dyke (1907)',
    pdNote:
      'Public domain: theme from Beethoven\'s Symphony No. 9 (1824), sung here in the common hymn form without the bar-12 syncopation; words "Joyful, Joyful, We Adore Thee" by Henry van Dyke, 1907 (published 1911).',
    bpm: 104,
    beatsPerBar: 4,
    tonic: 'D',
    mode: 'major',
    difficulty: 1,
    style: 'hymn',
    melody: `
      F#4:1 F#4 G4 A4 | A4 G4 F#4 E4 | D4 D4 E4 F#4 | F#4:1.5 E4:0.5 E4:2 |
      F#4:1 F#4 G4 A4 | A4 G4 F#4 E4 | D4 D4 E4 F#4 | E4:1.5 D4:0.5 D4:2 |
      E4:1 E4 F#4 D4 | E4:1 F#4:0.5 G4 F#4:1 D4 | E4:1 F#4:0.5 G4 F#4:1 E4 | D4:1 E4 A3:2 |
      F#4:1 F#4 G4 A4 | A4 G4 F#4 E4 | D4 D4 E4 F#4 | E4:1.5 D4:0.5 D4:2`,
    lyrics: `
      Joy- ful, joy- ful, we a- dore Thee, / God of glo- ry, Lord of love; /
      Hearts un- fold like flow'rs be- fore Thee, / Op'- ning to the sun a- bove. /
      Melt the clouds of sin and ~ sad- ness; / Drive the ~ dark of doubt a- way; /
      Giv- er of im- mor- tal glad- ness, / Fill us with the light of day!`,
    chords: `
      D:4 | A:4 | D:4 | D:2 A:2 |
      D:4 | A:4 | D:4 | A:2 D:2 |
      A:2 D:2 | A:2 D:2 | A:2 D:1 A:1 | Bm:1 E:1 A:2 |
      D:4 | A:4 | D:4 | A:2 D:2`,
    sections: [
      { name: 'Joyful, joyful', from: 1, to: 4 },
      { name: 'Hearts unfold', from: 5, to: 8 },
      { name: 'Melt the clouds', from: 9, to: 12 },
      { name: 'Giver of immortal gladness', from: 13, to: 16 },
    ],
  },
  {
    id: 'saints',
    title: 'When the Saints Go Marching In',
    credit: 'African-American spiritual · traditional',
    pdNote:
      'Traditional spiritual, first recorded 1923; widely accepted as public domain (no known copyrighted original). Later published arrangements are copyrighted and are not used here.',
    bpm: 116,
    beatsPerBar: 4,
    tonic: 'C',
    mode: 'major',
    difficulty: 2,
    style: 'march',
    melody: `
      R:1 C4:1 E4 F4 | G4:4 | R:1 C4:1 E4 F4 | G4:4 |
      R:1 C4:1 E4 F4 | G4:2 E4:2 | C4:2 E4:2 | D4:4 |
      R:1 E4:1 E4 D4 | C4:4 | E4:2 G4:2 | G4:1 F4:3 |
      R:2 E4:1 F4:1 | G4:2 E4:2 | C4:2 D4:2 | C4:4`,
    lyrics: `
      Oh when the saints go march- ing in, / Oh when the saints go march- ing in, /
      I want to be in that num- ber, / When the saints go march- ing in.`,
    chords: `
      C:4 | C:4 | C:4 | C:4 |
      C:4 | C:4 | C:4 | G7:4 |
      C:4 | C:4 | C7:4 | F:4 |
      C:4 | C:4 | C:2 G7:2 | C:4`,
    sections: [
      { name: 'Oh when the saints', from: 1, to: 8 },
      { name: 'I want to be in that number', from: 9, to: 16 },
    ],
  },
  {
    id: 'amazing-grace',
    title: 'Amazing Grace',
    credit: 'Tune NEW BRITAIN (1829) · words John Newton (1779)',
    pdNote: 'Public domain: words by John Newton, Olney Hymns 1779; tune NEW BRITAIN (1829), in the standard hymnal form arranged by E. O. Excell (1900).',
    bpm: 84,
    beatsPerBar: 3,
    tonic: 'G',
    mode: 'major',
    difficulty: 2,
    style: 'waltz',
    melody: `
      R:2 D4:1 | G4:2 B4:0.5 G4 | B4:2 A4:1 | G4:2 E4:1 | D4:2 D4:1 |
      G4:2 B4:0.5 G4 | B4:2 A4:1 | D5:2 B4:1 |
      D5:1.5 B4:0.5 D5 B4 | G4:2 D4:1 | E4:1.5 G4:0.5 G4 E4 | D4:2 D4:1 |
      G4:2 B4:0.5 G4 | B4:2 A4:1 | G4:3`,
    lyrics: `
      A- maz- ing ~ grace! how sweet the sound, / That saved a ~ wretch like me! /
      I once ~ was ~ lost, but now ~ am ~ found, / Was blind, but ~ now I see.`,
    chords: `
      N:3 | G:3 | G7:3 | C:3 | G:3 |
      G:3 | G:2 D:1 | D:2 G:1 |
      G:3 | G7:3 | C:3 | G:3 |
      Em:3 | G:2 D7:1 | G:3`,
    sections: [
      { name: 'Amazing grace, how sweet the sound', beats: [0, 14] },
      { name: 'That saved a wretch like me', beats: [14, 23] },
      { name: 'I once was lost, but now am found', beats: [23, 35] },
      { name: 'Was blind, but now I see', beats: [35, 45] },
    ],
  },
  {
    id: 'auld-lang-syne',
    title: 'Auld Lang Syne',
    credit: 'Scottish air (1799) · words Robert Burns (1788)',
    pdNote: 'Public domain: words by Robert Burns, 1788; the traditional Scottish air first printed with these words in 1799.',
    bpm: 76,
    beatsPerBar: 4,
    tonic: 'F',
    mode: 'major',
    difficulty: 3,
    style: 'ballad',
    melody: `
      R:3 C4:1 |
      F4:1.5 F4:0.5 F4:1 A4:1 | G4:1.5 F4:0.5 G4:1 A4:1 | F4:1.5 F4:0.5 A4:1 C5:1 | D5:3 D5:1 |
      C5:1.5 A4:0.5 A4:1 F4:1 | G4:1.5 F4:0.5 G4:1 A4:1 | F4:1.5 D4:0.5 D4:1 C4:1 | F4:3 D5:1 |
      C5:1.5 A4:0.5 A4:1 F4:1 | G4:1.5 F4:0.5 G4:1 D5:1 | C5:1.5 A4:0.5 A4:1 C5:1 | D5:3 D5:1 |
      C5:1.5 A4:0.5 A4:1 F4:1 | G4:1.5 F4:0.5 G4:1 A4:1 | F4:1.5 D4:0.5 D4:1 C4:1 | F4:3`,
    lyrics: `
      Should auld ac- quain- tance be for- got, / and nev- er brought to mind? /
      Should auld ac- quain- tance be for- got, / and auld ~ lang ~ syne? /
      For auld ~ lang ~ syne, my dear, / for auld ~ lang ~ syne, /
      we'll tak' a cup o' kind- ness yet, / for auld ~ lang ~ syne.`,
    chords: `
      N:3 C:1 |
      F:4 | C7:4 | F:4 | Bb:4 |
      F:4 | C7:4 | Dm:2 Bb:1 C7:1 | F:3 Bb:1 |
      F:4 | C7:3 Bb:1 | F:4 | Bb:4 |
      F:4 | C7:4 | Dm:2 Bb:1 C7:1 | F:4`,
    sections: [
      { name: 'Should auld acquaintance… mind', beats: [0, 19] },
      { name: 'Should auld acquaintance… syne', beats: [19, 35] },
      { name: 'For auld lang syne, my dear', beats: [35, 51] },
      { name: "We'll tak a cup o' kindness", beats: [51, 68] },
    ],
  },
];

export const LIBRARY: Song[] = SOURCES.map(buildSong);
