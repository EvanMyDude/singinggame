/// <reference types="node" />
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { hashLines, parseLyrics, parseTiming } from '../src/core/lyrics';
import { parseMelody } from '../src/core/melody';
import { audioRole, classifyFile, packFiles } from '../src/core/songpack';
import { parseRegistry, parseSongDef, songFileUrl, type SongDef } from '../src/core/songs';
import audioRoles from './fixtures/audio-roles.json';
import lyricHashes from './fixtures/lyrics-hash.json';

const SONGS = join(__dirname, '..', 'public', 'songs');
const readJson = (...p: string[]): unknown => JSON.parse(readFileSync(join(SONGS, ...p), 'utf8'));

const LOVE = {
  version: 1,
  id: 'love-yourself',
  title: 'Love Yourself',
  artist: 'Someone',
  files: { instrumental: 'Love Yourself Instrumental.mp3', reference: 'Love Yourself Full.mp3', vocal: 'Love Yourself (Vocals Only).mp3', lyrics: 'lyrics.txt', timing: 'timing.json', melody: 'melody.json' },
  referenceKind: 'mix',
  targets: { source: 'isolated-vocal' },
};
const STEMS = { ...LOVE, id: 'stems-only', files: { ...LOVE.files, reference: 'Love Yourself (Vocals Only).mp3' }, referenceKind: 'vocal' };
const audio = (name: string) => ({ name, type: 'audio/mpeg' });

describe('song definition', () => {
  it('parses a full definition', () => {
    const d = parseSongDef(LOVE, 'love-yourself');
    expect(d).toMatchObject({ id: 'love-yourself', title: 'Love Yourself', artist: 'Someone', referenceKind: 'mix', targetSource: 'isolated-vocal' });
    expect(d.files.reference).toBe('Love Yourself Full.mp3');
    expect(d.files.vocal).toBe('Love Yourself (Vocals Only).mp3');
  });

  it('fills conventional file names and has no reference unless one is named', () => {
    const d = parseSongDef({ version: 1, id: 'x', title: 'X' });
    expect(d.files).toEqual({ instrumental: 'instrumental.mp3', reference: null, vocal: null, lyrics: 'lyrics.txt', timing: 'timing.json', melody: 'melody.json' });
    expect(d.referenceKind).toBe('none');
    expect(d.artist).toBe('');
    expect(parseSongDef({ version: 1, id: 'x', title: 'X', files: { reference: 'reference.mp3' } }).referenceKind).toBe('mix');
    expect(parseSongDef({ version: 1, id: 'x', title: 'X', files: { reference: 'r.mp3' }, referenceKind: 'none' }).files.reference).toBeNull();
  });

  it('rejects what it cannot use, with a reason', () => {
    expect(() => parseSongDef(null)).toThrow(/not an object/);
    expect(() => parseSongDef({ ...LOVE, version: 2 })).toThrow(/unknown format/);
    expect(() => parseSongDef({ ...LOVE, id: 'Love Yourself' })).toThrow(/id/);
    expect(() => parseSongDef(LOVE, 'old-town-road')).toThrow(/does not match its folder/);
    expect(() => parseSongDef({ ...LOVE, title: ' ' })).toThrow(/title/);
    expect(() => parseSongDef({ ...LOVE, referenceKind: 'both' })).toThrow(/referenceKind/);
    for (const bad of ['../secret.mp3', 'a/b.mp3', 'a\\b.mp3', '..', '']) {
      expect(() => parseSongDef({ ...LOVE, files: { ...LOVE.files, instrumental: bad } })).toThrow(/file name/);
    }
  });

  it('parses the registry in order, without duplicates', () => {
    expect(parseRegistry({ version: 1, songs: ['old-town-road', 'love-yourself', 'old-town-road'] })).toEqual(['old-town-road', 'love-yourself']);
    expect(() => parseRegistry({ version: 1, songs: ['Bad Id'] })).toThrow(/not a song id/);
    expect(() => parseRegistry({ songs: [] })).toThrow(/unknown format/);
  });

  it('builds file URLs that survive spaces and punctuation', () => {
    expect(songFileUrl('./', 'love-yourself', 'Love Yourself (Vocals Only).mp3')).toBe('./songs/love-yourself/Love%20Yourself%20(Vocals%20Only).mp3');
    expect(songFileUrl('/base', 'x', 'a#b?.mp3')).toBe('/base/songs/x/a%23b%3F.mp3');
  });
});

describe('song files', () => {
  const love = parseSongDef(LOVE);
  const stems = parseSongDef(STEMS);

  it('lists the slots the app uses, named from the definition', () => {
    const specs = packFiles(love);
    expect(specs.map((s) => s.key)).toEqual(['instrumental', 'reference', 'melody', 'lyrics', 'timing']);
    expect(specs.filter((s) => s.required).map((s) => s.key)).toEqual(['instrumental', 'melody']);
    expect(specs[1]!.name).toBe('Love Yourself Full.mp3');
    expect(packFiles(stems)[1]!.label).toMatch(/Isolated vocal/);
    expect(packFiles(parseSongDef({ version: 1, id: 'x', title: 'X' })).map((s) => s.key)).toEqual(['instrumental', 'melody', 'lyrics', 'timing']);
  });

  it('reads the role of an audio file from its name like the Python tool does', () => {
    expect(audioRoles.cases.length).toBeGreaterThan(10);
    for (const [name, role] of audioRoles.cases as [string, string | null][]) expect(audioRole(name), name).toBe(role);
  });

  it('sorts picked files into the slots of a song whose reference is the full mix', () => {
    expect(classifyFile(audio('Love Yourself Instrumental.mp3'), love)).toBe('instrumental');
    expect(classifyFile(audio('Love Yourself Full.mp3'), love)).toBe('reference');
    // The isolated vocal is not the full-mix reference: it must not be played as one.
    expect(classifyFile(audio('Love Yourself (Vocals Only).mp3'), love)).toBeNull();
    expect(classifyFile({ name: 'lyrics.txt', type: 'text/plain' }, love)).toBe('lyrics');
    expect(classifyFile({ name: 'timing.json', type: 'application/json' }, love)).toBe('timing');
    expect(classifyFile({ name: 'melody (1).json', type: 'application/json' }, love)).toBe('melody');
    expect(classifyFile(audio('unrelated.mp3'), love)).toBeNull();
  });

  it('uses the isolated vocal as the reference only when the song says so', () => {
    expect(classifyFile(audio('Love Yourself (Vocals Only).mp3'), stems)).toBe('reference');
    expect(classifyFile(audio('Some Acapella.mp3'), stems)).toBe('reference');
    expect(classifyFile(audio('Love Yourself Full.mp3'), stems)).toBeNull();
  });

  it('still sorts the Old Town Road file names', () => {
    const otr = parseSongDef(readJson('old-town-road', 'song.json'), 'old-town-road');
    expect(classifyFile(audio('Old Town Road - Karaoke.mp3'), otr)).toBe('instrumental');
    expect(classifyFile(audio('Old Town Road with Vocals.mp3'), otr)).toBe('reference');
    expect(classifyFile(audio('instrumental.mp3'), otr)).toBe('instrumental');
    expect(classifyFile(audio('reference.mp3'), otr)).toBe('reference');
  });
});

describe('lyric hash', () => {
  it('matches the vectors shared with tools/prepare_song.py', () => {
    expect(lyricHashes.cases.length).toBeGreaterThan(3);
    for (const c of lyricHashes.cases) {
      const doc = parseLyrics(c.text);
      expect(doc.lines.map((l) => l.text)).toEqual(c.lines);
      expect(doc.hash).toBe(c.hash);
      expect(hashLines(c.lines)).toBe(c.hash);
    }
  });
});

describe('registered songs', () => {
  const ids = parseRegistry(readJson('index.json'));

  it('includes Old Town Road', () => {
    expect(ids).toContain('old-town-road');
  });

  it.each(ids)('%s has a valid definition and committed data', (id) => {
    const def: SongDef = parseSongDef(readJson(id, 'song.json'), id);
    const melody = parseMelody(readJson(id, def.files.melody));
    expect(melody.notes.length).toBeGreaterThan(0);
    expect(melody.duration).toBeGreaterThan(0);
    for (const n of melody.notes) expect(n.t + n.d).toBeLessThanOrEqual(melody.duration + 0.5);
    if (existsSync(join(SONGS, id, def.files.timing))) {
      const timing = parseTiming(readJson(id, def.files.timing));
      expect(timing.lines.length).toBeGreaterThan(0);
      const starts = timing.lines.map((l) => l.start).filter(Number.isFinite);
      expect([...starts].sort((a, b) => a - b)).toEqual(starts);
      expect(Math.max(...starts)).toBeLessThan(melody.duration);
    }
  });
});
