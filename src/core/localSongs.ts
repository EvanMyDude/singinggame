import { idb } from './idb';
import { parseSongDef, type ReferenceKind, type SongDef } from './songs';
import { zipStore } from './zip';

/**
 * Songs added in this browser with Add song. Every file lives in IndexedDB under the same
 * `<id>/<slot>` keys the Song files card uses for project songs (core/songpack.ts), plus:
 *
 *   <id>/song    the definition, in song.json's format (written last, so a song whose save
 *                failed half way is never listed)
 *   <id>/vocal   the isolated vocal when it is not also the reference track; kept so the
 *                targets can be made again
 *
 * Nothing here leaves the browser except through the package download, which holds only the
 * derived files a project song commits (song.json, melody.json, timing.json).
 */

const KEY = (id: string, slot: string) => `${id}/${slot}`;

/** song.json as Add song writes it; `createdAt` orders the picker and is not exported. */
export interface LocalSongDoc {
  version: 1;
  id: string;
  title: string;
  artist: string;
  files: { instrumental: string; reference?: string; vocal: string; lyrics: string; timing: string; melody: string };
  referenceKind: Exclude<ReferenceKind, 'none'>;
  targets: { source: 'isolated-vocal' };
  createdAt?: string;
}

export interface NewLocalSong {
  doc: LocalSongDoc;
  melodyJson: string;
  instrumental: Blob;
  vocal: Blob;
  mix: Blob | null;
  lyrics: string | null;
}

function asLocal(def: SongDef): SongDef {
  return { ...def, origin: 'local' };
}

function storageMessage(e: unknown): Error {
  const name = (e as { name?: string })?.name;
  if (name === 'QuotaExceededError') return new Error('This browser is out of storage space for song files. Remove a song you no longer need, then try again.');
  return e instanceof Error ? e : new Error(String(e));
}

/** Stores a new (or re-analyzed) song. Returns its definition as the app reads it. */
export async function saveLocalSong(s: NewLocalSong): Promise<SongDef> {
  const { doc } = s;
  const def = asLocal(parseSongDef(doc, doc.id));
  const writes: [string, unknown][] = [
    [KEY(doc.id, 'instrumental'), s.instrumental],
    [KEY(doc.id, 'melody'), s.melodyJson],
  ];
  if (doc.referenceKind === 'mix') {
    if (!s.mix) throw new Error('A song whose reference is the full mix needs the full mix file.');
    writes.push([KEY(doc.id, 'reference'), s.mix], [KEY(doc.id, 'vocal'), s.vocal]);
  } else {
    writes.push([KEY(doc.id, 'reference'), s.vocal]);
  }
  if (s.lyrics !== null) writes.push([KEY(doc.id, 'lyrics'), s.lyrics]);
  try {
    void navigator.storage?.persist?.().catch(() => false);
    for (const [k, v] of writes) await idb.put(k, v);
    await idb.put(KEY(doc.id, 'song'), JSON.stringify({ ...doc, createdAt: doc.createdAt ?? new Date().toISOString() }));
  } catch (e) {
    // Leave nothing half saved behind.
    await Promise.all(writes.map(([k]) => idb.delete(k).catch(() => undefined)));
    throw storageMessage(e);
  }
  return def;
}

/** Replaces only the targets of a stored song (re-analysis). */
export async function saveLocalMelody(id: string, melodyJson: string): Promise<void> {
  try {
    await idb.put(KEY(id, 'melody'), melodyJson);
  } catch (e) {
    throw storageMessage(e);
  }
}

/** The songs added in this browser, oldest first. A broken entry is reported, not fatal. */
export async function listLocalSongs(): Promise<{ songs: SongDef[]; errors: string[] }> {
  let keys: string[];
  try {
    keys = await idb.keys();
  } catch {
    return { songs: [], errors: [] };
  }
  const errors: string[] = [];
  const rows = await Promise.all(
    keys
      .filter((k) => k.endsWith('/song'))
      .map(async (k) => {
        const id = k.slice(0, -'/song'.length);
        try {
          const raw = await idb.get<string>(k);
          const json = JSON.parse(String(raw)) as { createdAt?: string };
          return { def: asLocal(parseSongDef(json, id)), at: Date.parse(json.createdAt ?? '') || 0 };
        } catch (e) {
          errors.push(`${id} (added in this browser): ${(e as Error).message}`);
          return null;
        }
      }),
  );
  const songs = rows.filter((r): r is { def: SongDef; at: number } => r !== null).sort((a, b) => a.at - b.at).map((r) => r.def);
  return { songs, errors };
}

/** The stored definition document of a browser song. */
export async function localSongDoc(id: string): Promise<LocalSongDoc | null> {
  try {
    const raw = await idb.get<string>(KEY(id, 'song'));
    return raw ? (JSON.parse(raw) as LocalSongDoc) : null;
  } catch {
    return null;
  }
}

/** A source recording of a browser song, for re-analysis: the instrumental, vocal or full mix. */
export async function localSource(song: SongDef, role: 'instrumental' | 'vocal' | 'mix'): Promise<Blob | null> {
  const slot = role === 'instrumental' ? 'instrumental' : role === 'mix' ? (song.referenceKind === 'mix' ? 'reference' : null) : song.referenceKind === 'mix' ? 'vocal' : 'reference';
  if (!slot) return null;
  try {
    const v = await idb.get<Blob>(KEY(song.id, slot));
    return v instanceof Blob ? v : null;
  } catch {
    return null;
  }
}

/** Removes every file stored for a browser song. */
export async function deleteLocalSong(id: string): Promise<void> {
  const keys = await idb.keys();
  // The definition goes first: if a later delete fails, no half-deleted song is listed.
  await idb.delete(KEY(id, 'song'));
  for (const k of keys) if (k.startsWith(`${id}/`) && k !== KEY(id, 'song')) await idb.delete(k);
}

/**
 * A zip with `<id>/song.json`, `<id>/melody.json` and, when synced, `<id>/timing.json`: what
 * `public/songs/<id>/` commits for a project song. Audio and lyric text are left out, as the
 * project's .gitignore leaves them out.
 */
export async function songPackage(song: SongDef): Promise<{ name: string; blob: Blob; files: string[] }> {
  const doc = await localSongDoc(song.id);
  const melody = await idb.get<string>(KEY(song.id, 'melody'));
  if (!doc || typeof melody !== 'string') throw new Error(`${song.title} has no stored definition or targets.`);
  const songJson: LocalSongDoc = { ...doc };
  delete songJson.createdAt;
  const entries = [
    { name: `${song.id}/song.json`, data: `${JSON.stringify(songJson, null, 2)}\n` },
    { name: `${song.id}/melody.json`, data: melody },
  ];
  const timing = await idb.get<string | Blob>(KEY(song.id, 'timing')).catch(() => undefined);
  if (typeof timing === 'string') entries.push({ name: `${song.id}/timing.json`, data: timing });
  else if (timing instanceof Blob) entries.push({ name: `${song.id}/timing.json`, data: await timing.text() });
  const bytes = zipStore(entries);
  return { name: `${song.id}-song-package.zip`, blob: new Blob([bytes], { type: 'application/zip' }), files: entries.map((e) => e.name) };
}
