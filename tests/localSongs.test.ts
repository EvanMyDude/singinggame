import { describe, expect, it } from 'vitest';
import { titleFromFileName } from '../src/core/songpack';
import { mergeSongLists, parseSongDef, songIdFor } from '../src/core/songs';
import { crc32, zipStore } from '../src/core/zip';

const def = (id: string, title = id) => parseSongDef({ version: 1, id, title });

describe('songs added in the browser', () => {
  it('follow the project songs, and a committed copy replaces the browser one', () => {
    const project = [def('old-town-road'), def('love-yourself')];
    const local = [{ ...def('my-song'), origin: 'local' as const }, { ...def('love-yourself', 'Local copy'), origin: 'local' as const }];
    const merged = mergeSongLists(project, local);
    expect(merged.map((s) => s.id)).toEqual(['old-town-road', 'love-yourself', 'my-song']);
    expect(merged[1]!.origin).toBeUndefined();
  });

  it('get an id from the title that no other song has', () => {
    expect(songIdFor('Love Yourself', [])).toBe('love-yourself');
    expect(songIdFor('Love Yourself', ['love-yourself'])).toBe('love-yourself-2');
    expect(songIdFor('Love Yourself', ['love-yourself', 'love-yourself-2'])).toBe('love-yourself-3');
    expect(songIdFor('  Café del Mar!! ', [])).toBe('cafe-del-mar');
    expect(songIdFor('???', [])).toBe('song');
    expect(parseSongDef({ version: 1, id: songIdFor("Don't Stop Me Now (Live)", []), title: 'x' }).id).toBe('don-t-stop-me-now-live');
  });

  it('get a title from a stem file name', () => {
    expect(titleFromFileName('Love Yourself Instrumental.mp3')).toBe('Love Yourself');
    expect(titleFromFileName('Love Yourself (Vocals Only).mp3')).toBe('Love Yourself');
    expect(titleFromFileName('Old Town Road - Karaoke.MP3')).toBe('Old Town Road');
    expect(titleFromFileName('artist_song_acapella.wav')).toBe('artist song');
    expect(titleFromFileName('Back on Track full mix.m4a')).toBe('Back on Track');
  });
});

describe('song package zip', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789')).toString(16)).toBe('cbf43926');
  });

  it('stores each file with a matching local header, central directory and end record', () => {
    const files = [
      { name: 'my-song/song.json', data: '{"version":1}\n' },
      { name: 'my-song/melody.json', data: '{"notes":[]}' },
    ];
    const z = zipStore(files, new Date(2026, 10, 18, 12, 30, 0));
    const dv = new DataView(z.buffer);
    const dec = new TextDecoder();
    let pos = 0;
    for (const f of files) {
      expect(dv.getUint32(pos, true)).toBe(0x04034b50);
      const size = dv.getUint32(pos + 18, true);
      const nameLen = dv.getUint16(pos + 26, true);
      expect(dec.decode(z.subarray(pos + 30, pos + 30 + nameLen))).toBe(f.name);
      const data = z.subarray(pos + 30 + nameLen, pos + 30 + nameLen + size);
      expect(dec.decode(data)).toBe(f.data);
      expect(dv.getUint32(pos + 14, true)).toBe(crc32(data));
      pos += 30 + nameLen + size;
    }
    expect(dv.getUint32(pos, true)).toBe(0x02014b50);
    const end = z.length - 22;
    expect(dv.getUint32(end, true)).toBe(0x06054b50);
    expect(dv.getUint16(end + 10, true)).toBe(files.length);
    expect(dv.getUint32(end + 16, true)).toBe(pos);
  });
});
