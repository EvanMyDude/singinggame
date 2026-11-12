/**
 * Song definitions and the song registry.
 *
 * Each song is a folder `public/songs/<id>/` with a `song.json` that names its files, and
 * `public/songs/index.json` lists the ids the app offers. Both are written by
 * `tools/prepare_song.py` (see docs/SONG_PACK.md); nothing about a song lives in code.
 */

/**
 * What the Reference vocal toggle plays: the full mix in place of the instrumental, the
 * isolated vocal on top of the instrumental, or nothing.
 */
export type ReferenceKind = 'mix' | 'vocal' | 'none';

export interface SongFiles {
  /** The track you sing over. */
  instrumental: string;
  /** The reference track, per `referenceKind`; null when the song has none. */
  reference: string | null;
  /** The isolated lead vocal the target was made from (used by the tools, not the app). */
  vocal: string | null;
  lyrics: string;
  timing: string;
  melody: string;
}

export interface SongDef {
  id: string;
  title: string;
  artist: string;
  /** File names inside the song folder. */
  files: SongFiles;
  referenceKind: ReferenceKind;
  /** How melody.json was made, e.g. "isolated-vocal" or "mix-subtraction"; informational. */
  targetSource: string | null;
}

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isSongId(v: unknown): v is string {
  return typeof v === 'string' && ID.test(v);
}

/** A plain file name: no folders, so a definition cannot point outside its song folder. */
function fileName(v: unknown, what: string, fallback: string | null): string | null {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'string' || !v.trim() || /[/\\]/.test(v) || v === '.' || v === '..') throw new Error(`song.json: "${what}" must be a file name inside the song folder`);
  return v;
}

/** Parses and validates a song.json document; throws with a readable message. */
export function parseSongDef(json: unknown, expectedId?: string): SongDef {
  if (!json || typeof json !== 'object') throw new Error('song.json is not an object');
  const j = json as Record<string, unknown>;
  if (j.version !== 1) throw new Error('song.json has an unknown format');
  if (!isSongId(j.id)) throw new Error('song.json: "id" must be lowercase letters, digits and dashes');
  if (expectedId !== undefined && j.id !== expectedId) throw new Error(`song.json: id "${j.id}" does not match its folder "${expectedId}"`);
  if (typeof j.title !== 'string' || !j.title.trim()) throw new Error('song.json: "title" is missing');
  const f = (j.files && typeof j.files === 'object' ? j.files : {}) as Record<string, unknown>;
  const reference = fileName(f.reference, 'files.reference', null);
  const kind = j.referenceKind;
  if (kind !== undefined && kind !== 'mix' && kind !== 'vocal' && kind !== 'none') throw new Error('song.json: "referenceKind" must be "mix", "vocal" or "none"');
  const referenceKind: ReferenceKind = reference === null ? 'none' : kind === 'vocal' ? 'vocal' : kind === 'none' ? 'none' : 'mix';
  const targets = j.targets && typeof j.targets === 'object' ? (j.targets as Record<string, unknown>) : {};
  return {
    id: j.id,
    title: j.title.trim(),
    artist: typeof j.artist === 'string' ? j.artist.trim() : '',
    files: {
      instrumental: fileName(f.instrumental, 'files.instrumental', 'instrumental.mp3')!,
      reference: referenceKind === 'none' ? null : reference,
      vocal: fileName(f.vocal, 'files.vocal', null),
      lyrics: fileName(f.lyrics, 'files.lyrics', 'lyrics.txt')!,
      timing: fileName(f.timing, 'files.timing', 'timing.json')!,
      melody: fileName(f.melody, 'files.melody', 'melody.json')!,
    },
    referenceKind,
    targetSource: typeof targets.source === 'string' ? targets.source : null,
  };
}

/** Song ids from songs/index.json, in display order, without duplicates. */
export function parseRegistry(json: unknown): string[] {
  if (!json || typeof json !== 'object') throw new Error('songs/index.json is not an object');
  const j = json as { version?: unknown; songs?: unknown };
  if (j.version !== 1 || !Array.isArray(j.songs)) throw new Error('songs/index.json has an unknown format');
  const out: string[] = [];
  for (const id of j.songs) {
    if (!isSongId(id)) throw new Error(`songs/index.json: "${String(id)}" is not a song id`);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** URL of a file in a song folder. File names may contain spaces and punctuation. */
export function songFileUrl(base: string, songId: string, name: string): string {
  const b = base.endsWith('/') ? base : `${base}/`;
  return `${b}songs/${songId}/${encodeURIComponent(name)}`;
}

export function baseUrl(): string {
  return import.meta.env.BASE_URL;
}

/** Text of a static file, or null when it is absent (dev servers answer unknown paths with index.html). */
export async function fetchStaticText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('text/html')) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export interface Registry {
  songs: SongDef[];
  /** Problems worth showing: a missing index, or a listed song whose song.json is absent or invalid. */
  errors: string[];
}

/** Loads the registry and every listed song definition. A bad song is skipped, not fatal. */
export async function loadRegistry(): Promise<Registry> {
  const base = baseUrl();
  const b = base.endsWith('/') ? base : `${base}/`;
  const text = await fetchStaticText(`${b}songs/index.json`);
  if (text === null) return { songs: [], errors: ['Could not load the song list (songs/index.json).'] };
  let ids: string[];
  try {
    ids = parseRegistry(JSON.parse(text));
  } catch (e) {
    return { songs: [], errors: [(e as Error).message] };
  }
  const errors: string[] = [];
  const defs = await Promise.all(
    ids.map(async (id) => {
      const t = await fetchStaticText(songFileUrl(base, id, 'song.json'));
      if (t === null) {
        errors.push(`${id}: song.json is missing`);
        return null;
      }
      try {
        return parseSongDef(JSON.parse(t), id);
      } catch (e) {
        errors.push(`${id}: ${(e as Error).message}`);
        return null;
      }
    }),
  );
  return { songs: defs.filter((d): d is SongDef => d !== null), errors };
}
