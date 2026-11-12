import { idb } from './idb';
import { parseLyrics, parseTiming, timingMatches, type LyricTiming, type LyricsDoc } from './lyrics';
import { parseMelody, type MelodyData } from './melody';
import { baseUrl, fetchStaticText, songFileUrl, type ReferenceKind, type SongDef } from './songs';

/**
 * A song's files. Each is looked up in two places: the static folder `public/songs/<id>/`
 * (served by Vite in development; the media and lyric text are git-ignored so they never
 * reach the public site) and IndexedDB, where the "Song files" card stores what the user
 * picks on the deployed site. Timing can come from either; the newer one wins so an in-app
 * sync edit is not shadowed by an older committed file.
 */

export type PackFileKey = 'instrumental' | 'reference' | 'melody' | 'lyrics' | 'timing';
export type FileSource = 'static' | 'local' | 'missing';

export interface PackFileSpec {
  key: PackFileKey;
  /** File name inside the song folder. */
  name: string;
  kind: 'audio' | 'json' | 'text';
  required: boolean;
  label: string;
  hint: string;
}

/** The file slots the app uses for a song, in display order. */
export function packFiles(song: SongDef): PackFileSpec[] {
  const f = song.files;
  const out: PackFileSpec[] = [{ key: 'instrumental', name: f.instrumental, kind: 'audio', required: true, label: 'Instrumental (karaoke) track', hint: 'the track you sing over' }];
  if (f.reference !== null) {
    out.push(
      song.referenceKind === 'vocal'
        ? { key: 'reference', name: f.reference, kind: 'audio', required: false, label: 'Isolated vocal (reference)', hint: 'plays over the instrumental with Reference vocal on' }
        : { key: 'reference', name: f.reference, kind: 'audio', required: false, label: 'Reference track with vocals', hint: 'the full song; plays with Reference vocal on' },
    );
  }
  out.push(
    { key: 'melody', name: f.melody, kind: 'json', required: true, label: 'Target melody (melody.json)', hint: `made by ${song.targetSource === 'mix-subtraction' ? 'tools/extract_melody.py' : 'npm run prepare-song'}; committed in the repo` },
    { key: 'lyrics', name: f.lyrics, kind: 'text', required: false, label: 'Lyrics text (lyrics.txt)', hint: 'one lyric line per line; [Section] headers allowed' },
    { key: 'timing', name: f.timing, kind: 'json', required: false, label: 'Lyric timing (timing.json)', hint: 'made with Settings → Sync lyrics' },
  );
  return out;
}

export interface SongPack {
  song: SongDef;
  melody: MelodyData;
  instrumentalUrl: string;
  referenceUrl: string | null;
  referenceKind: ReferenceKind;
  lyrics: LyricsDoc | null;
  timing: LyricTiming | null;
  sources: Record<PackFileKey, FileSource>;
}

export interface PackStatus {
  song: SongDef;
  /** Null until the required files (instrumental + melody) are available. */
  pack: SongPack | null;
  sources: Record<PackFileKey, FileSource>;
  missing: PackFileKey[];
  errors: string[];
}

/** IndexedDB key of a picked file. The format predates multiple songs and must not change. */
const LOCAL_KEY = (songId: string, k: PackFileKey) => `${songId}/${k}`;

/** True when the static file exists (dev servers answer unknown paths with index.html). */
async function staticExists(url: string): Promise<boolean> {
  try {
    let res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    if (res.status === 405 || res.status === 501) res = await fetch(url, { method: 'GET', cache: 'no-store' });
    if (!res.ok) return false;
    const ct = res.headers.get('content-type') ?? '';
    return !ct.includes('text/html');
  } catch {
    return false;
  }
}

const objectUrls = new Map<string, string>();

function blobUrl(songId: string, key: PackFileKey, blob: Blob): string {
  const id = LOCAL_KEY(songId, key);
  const old = objectUrls.get(id);
  if (old) URL.revokeObjectURL(old);
  const url = URL.createObjectURL(blob);
  objectUrls.set(id, url);
  return url;
}

const cached = new Map<string, Promise<PackStatus>>();

export function loadPack(song: SongDef, force = false): Promise<PackStatus> {
  let p = force ? undefined : cached.get(song.id);
  if (!p) {
    p = loadPackUncached(song);
    cached.set(song.id, p);
  }
  return p;
}

async function localBlob(song: SongDef, spec: PackFileSpec): Promise<Blob | null> {
  try {
    const v = await idb.get<Blob | string>(LOCAL_KEY(song.id, spec.key));
    if (v instanceof Blob) return v;
    if (typeof v === 'string') return new Blob([v], { type: spec.kind === 'json' ? 'application/json' : 'text/plain' });
    return null;
  } catch {
    return null;
  }
}

async function loadPackUncached(song: SongDef): Promise<PackStatus> {
  const sources: Record<PackFileKey, FileSource> = { instrumental: 'missing', reference: 'missing', melody: 'missing', lyrics: 'missing', timing: 'missing' };
  const errors: string[] = [];
  const specs = new Map(packFiles(song).map((s) => [s.key, s]));
  const base = baseUrl();

  // Audio: static first (dev), then local.
  const audioUrl = async (key: 'instrumental' | 'reference'): Promise<string | null> => {
    const spec = specs.get(key);
    if (!spec) return null;
    const url = songFileUrl(base, song.id, spec.name);
    if (await staticExists(url)) {
      sources[key] = 'static';
      return url;
    }
    const blob = await localBlob(song, spec);
    if (blob) {
      sources[key] = 'local';
      return blobUrl(song.id, key, blob);
    }
    return null;
  };

  const textOf = async (key: 'melody' | 'lyrics' | 'timing'): Promise<{ text: string; source: FileSource }[]> => {
    const spec = specs.get(key)!;
    const out: { text: string; source: FileSource }[] = [];
    const st = await fetchStaticText(songFileUrl(base, song.id, spec.name));
    if (st !== null) out.push({ text: st, source: 'static' });
    const blob = await localBlob(song, spec);
    if (blob) out.push({ text: await blob.text(), source: 'local' });
    return out;
  };

  const [instrumentalUrl, referenceUrl, melodyTexts, lyricTexts, timingTexts] = await Promise.all([
    audioUrl('instrumental'),
    audioUrl('reference'),
    textOf('melody'),
    textOf('lyrics'),
    textOf('timing'),
  ]);

  let melody: MelodyData | null = null;
  for (const m of melodyTexts) {
    try {
      melody = parseMelody(JSON.parse(m.text));
      sources.melody = m.source;
      break;
    } catch (e) {
      errors.push(`melody.json (${m.source}): ${(e as Error).message}`);
    }
  }

  let lyrics: LyricsDoc | null = null;
  for (const l of lyricTexts) {
    const doc = parseLyrics(l.text);
    if (doc.lines.length) {
      lyrics = doc;
      sources.lyrics = l.source;
      break;
    }
    errors.push(`lyrics.txt (${l.source}) has no lyric lines`);
  }

  let timing: LyricTiming | null = null;
  if (lyrics) {
    const candidates: { t: LyricTiming; source: FileSource; savedAt: number }[] = [];
    for (const t of timingTexts) {
      try {
        const raw = JSON.parse(t.text) as { savedAt?: string };
        const parsed = parseTiming(raw);
        if (!timingMatches(parsed, lyrics)) {
          errors.push(`timing.json (${t.source}) was made for a different lyrics.txt; re-sync in Settings`);
          continue;
        }
        candidates.push({ t: parsed, source: t.source, savedAt: raw.savedAt ? Date.parse(raw.savedAt) || 0 : 0 });
      } catch (e) {
        errors.push(`timing.json (${t.source}): ${(e as Error).message}`);
      }
    }
    candidates.sort((a, b) => b.savedAt - a.savedAt);
    if (candidates[0]) {
      timing = candidates[0].t;
      sources.timing = candidates[0].source;
    }
  }

  const missing = [...specs.keys()].filter((k) => sources[k] === 'missing');
  const pack: SongPack | null =
    instrumentalUrl && melody ? { song, melody, instrumentalUrl, referenceUrl, referenceKind: referenceUrl ? song.referenceKind : 'none', lyrics, timing, sources } : null;
  return { song, pack, sources, missing, errors };
}

const AUDIO_NAME = /\.(mp3|m4a|wav|ogg|aac|flac)$/;

/**
 * What an audio file is, from its name: the track to sing over, an isolated vocal, or the
 * full mix. Checked in this order because "vocals only" also contains "vocal" and "no
 * vocals" is an instrumental. Kept in step with `classify` in tools/prepare_song.py.
 */
export function audioRole(fileName: string): 'instrumental' | 'vocal' | 'mix' | null {
  const stem = fileName.toLowerCase().replace(AUDIO_NAME, '');
  if (stem === 'instrumental') return 'instrumental';
  if (stem === 'vocal' || stem === 'vocals') return 'vocal';
  if (stem === 'reference' || stem === 'mix' || stem === 'full') return 'mix';
  if (/karaoke|instrumental|\binst\b|backing|minus|\bno[ _-]?vocals?|without[ _-]vocals?/.test(stem)) return 'instrumental';
  if (/vocals?[ _-]?only|only[ _-]?vocals?|a[ _-]?cap+el+a|isolated|lead[ _-]?vocals?|vocal[ _-]?stem|^vocals?\b|\(vocals?\)/.test(stem)) return 'vocal';
  if (/\bfull\b|with[ _-]vocals?|original|\bmix\b|reference/.test(stem)) return 'mix';
  return null;
}

/**
 * Which slot of this song a picked file belongs to: the definition's own file names first,
 * then the name's wording. An isolated vocal is not the reference of a song whose reference
 * is the full mix, so it is left unassigned rather than played as one.
 */
export function classifyFile(file: { name: string; type: string }, song: SongDef): PackFileKey | null {
  const n = file.name.toLowerCase();
  const specs = packFiles(song);
  const exact = specs.find((s) => s.name.toLowerCase() === n);
  if (exact) return exact.key;
  const isAudio = file.type.startsWith('audio/') || AUDIO_NAME.test(n);
  if (isAudio) {
    const role = audioRole(n);
    if (role === 'instrumental') return 'instrumental';
    if (song.referenceKind === 'none') return null;
    if (role !== null) return role === song.referenceKind ? 'reference' : null;
    return /vocal/.test(n) ? 'reference' : null;
  }
  if (n === 'melody.json' || /melody.*\.json$/.test(n)) return 'melody';
  if (n === 'timing.json' || /timing.*\.json$/.test(n)) return 'timing';
  if (/\.(txt|lrc|md)$/.test(n)) return 'lyrics';
  return null;
}

/** Validate and store a picked file for a slot. Throws with a readable message. */
export async function importFile(song: SongDef, key: PackFileKey, file: File): Promise<void> {
  const spec = packFiles(song).find((s) => s.key === key);
  if (!spec) throw new Error(`${song.title} has no ${key} file.`);
  if (spec.kind === 'audio') {
    if (!(file.type.startsWith('audio/') || /\.(mp3|m4a|wav|ogg|aac|flac)$/i.test(file.name))) throw new Error(`${file.name} is not an audio file.`);
    if (file.size < 100_000) throw new Error(`${file.name} is too small to be the full track.`);
    await idb.put(LOCAL_KEY(song.id, key), file);
  } else {
    const text = await file.text();
    if (spec.kind === 'json') {
      const json = JSON.parse(text) as unknown;
      if (key === 'melody') parseMelody(json);
      else parseTiming(json);
    } else if (!parseLyrics(text).lines.length) {
      throw new Error('No lyric lines found in the text file.');
    }
    await idb.put(LOCAL_KEY(song.id, key), text);
  }
  cached.delete(song.id);
}

export async function removeLocal(song: SongDef, key: PackFileKey): Promise<void> {
  await idb.delete(LOCAL_KEY(song.id, key));
  cached.delete(song.id);
}

/** Save lyric timing from the sync tool (local store). */
export async function saveTimingLocal(song: SongDef, json: string): Promise<void> {
  await idb.put(LOCAL_KEY(song.id, 'timing'), json);
  cached.delete(song.id);
}

export async function saveLyricsLocal(song: SongDef, text: string): Promise<void> {
  if (!parseLyrics(text).lines.length) throw new Error('No lyric lines found.');
  await idb.put(LOCAL_KEY(song.id, 'lyrics'), text);
  cached.delete(song.id);
}
