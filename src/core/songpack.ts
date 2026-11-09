import { idb } from './idb';
import { parseLyrics, parseTiming, timingMatches, type LyricTiming, type LyricsDoc } from './lyrics';
import { parseMelody, type MelodyData } from './melody';

/**
 * The one song and its files. Files are looked up in two places: the static folder
 * `public/songs/<id>/` (served by Vite in development; the media and lyric text are
 * git-ignored so they never reach the public site) and IndexedDB, where the "Load song files"
 * card stores what the user picks on the deployed site. Timing can come from either; the
 * newer one wins so an in-app sync edit is not shadowed by an older committed file.
 */

export const SONG = { id: 'old-town-road', title: 'Old Town Road', artist: 'Lil Nas X' } as const;

export type PackFileKey = 'instrumental' | 'reference' | 'melody' | 'lyrics' | 'timing';
export type FileSource = 'static' | 'local' | 'missing';

export interface PackFileSpec {
  name: string;
  kind: 'audio' | 'json' | 'text';
  required: boolean;
  label: string;
  hint: string;
}

export const PACK_FILES: Record<PackFileKey, PackFileSpec> = {
  instrumental: { name: 'instrumental.mp3', kind: 'audio', required: true, label: 'Instrumental (karaoke) track', hint: 'Old Town Road - Karaoke.mp3' },
  reference: { name: 'reference.mp3', kind: 'audio', required: false, label: 'Reference track with vocals', hint: 'Old Town Road with Vocals.mp3' },
  melody: { name: 'melody.json', kind: 'json', required: true, label: 'Target melody (melody.json)', hint: 'made by tools/extract_melody.py; committed in the repo' },
  lyrics: { name: 'lyrics.txt', kind: 'text', required: false, label: 'Lyrics text (lyrics.txt)', hint: 'one lyric line per line; [Section] headers allowed' },
  timing: { name: 'timing.json', kind: 'json', required: false, label: 'Lyric timing (timing.json)', hint: 'made with Settings → Sync lyrics' },
};

export interface SongPack {
  melody: MelodyData;
  instrumentalUrl: string;
  referenceUrl: string | null;
  lyrics: LyricsDoc | null;
  timing: LyricTiming | null;
  sources: Record<PackFileKey, FileSource>;
}

export interface PackStatus {
  /** Null until the required files (instrumental + melody) are available. */
  pack: SongPack | null;
  sources: Record<PackFileKey, FileSource>;
  missing: PackFileKey[];
  errors: string[];
}

const LOCAL_KEY = (k: PackFileKey) => `${SONG.id}/${k}`;

function staticUrl(key: PackFileKey): string {
  const base = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
  return `${base}songs/${SONG.id}/${PACK_FILES[key].name}`;
}

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

async function fetchStaticText(url: string): Promise<string | null> {
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

const objectUrls = new Map<PackFileKey, string>();

function blobUrl(key: PackFileKey, blob: Blob): string {
  const old = objectUrls.get(key);
  if (old) URL.revokeObjectURL(old);
  const url = URL.createObjectURL(blob);
  objectUrls.set(key, url);
  return url;
}

let cached: Promise<PackStatus> | null = null;

export function loadPack(force = false): Promise<PackStatus> {
  if (!cached || force) cached = loadPackUncached();
  return cached;
}

async function localBlob(key: PackFileKey): Promise<Blob | null> {
  try {
    const v = await idb.get<Blob | string>(LOCAL_KEY(key));
    if (v instanceof Blob) return v;
    if (typeof v === 'string') return new Blob([v], { type: PACK_FILES[key].kind === 'json' ? 'application/json' : 'text/plain' });
    return null;
  } catch {
    return null;
  }
}

async function loadPackUncached(): Promise<PackStatus> {
  const sources: Record<PackFileKey, FileSource> = { instrumental: 'missing', reference: 'missing', melody: 'missing', lyrics: 'missing', timing: 'missing' };
  const errors: string[] = [];

  // Audio: static first (dev), then local.
  const audioUrl = async (key: 'instrumental' | 'reference'): Promise<string | null> => {
    const url = staticUrl(key);
    if (await staticExists(url)) {
      sources[key] = 'static';
      return url;
    }
    const blob = await localBlob(key);
    if (blob) {
      sources[key] = 'local';
      return blobUrl(key, blob);
    }
    return null;
  };

  const textOf = async (key: 'melody' | 'lyrics' | 'timing'): Promise<{ text: string; source: FileSource }[]> => {
    const out: { text: string; source: FileSource }[] = [];
    const st = await fetchStaticText(staticUrl(key));
    if (st !== null) out.push({ text: st, source: 'static' });
    const blob = await localBlob(key);
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

  const missing = (Object.keys(PACK_FILES) as PackFileKey[]).filter((k) => sources[k] === 'missing');
  const pack: SongPack | null =
    instrumentalUrl && melody ? { melody, instrumentalUrl, referenceUrl, lyrics, timing, sources } : null;
  return { pack, sources, missing, errors };
}

/** Guess which slot a picked file belongs to from its name and type. */
export function classifyFile(file: File): PackFileKey | null {
  const n = file.name.toLowerCase();
  const isAudio = file.type.startsWith('audio/') || /\.(mp3|m4a|wav|ogg|aac|flac)$/.test(n);
  if (isAudio) {
    if (/karaoke|instrumental|inst\b|backing|minus/.test(n)) return 'instrumental';
    if (/vocal|reference|original|with/.test(n)) return 'reference';
    return null;
  }
  if (n === 'melody.json' || /melody.*\.json$/.test(n)) return 'melody';
  if (n === 'timing.json' || /timing.*\.json$/.test(n)) return 'timing';
  if (/\.(txt|lrc|md)$/.test(n)) return 'lyrics';
  return null;
}

/** Validate and store a picked file for a slot. Throws with a readable message. */
export async function importFile(key: PackFileKey, file: File): Promise<void> {
  const spec = PACK_FILES[key];
  if (spec.kind === 'audio') {
    if (!(file.type.startsWith('audio/') || /\.(mp3|m4a|wav|ogg|aac|flac)$/i.test(file.name))) throw new Error(`${file.name} is not an audio file.`);
    if (file.size < 100_000) throw new Error(`${file.name} is too small to be the full track.`);
    await idb.put(LOCAL_KEY(key), file);
  } else {
    const text = await file.text();
    if (spec.kind === 'json') {
      const json = JSON.parse(text) as unknown;
      if (key === 'melody') parseMelody(json);
      else parseTiming(json);
    } else if (!parseLyrics(text).lines.length) {
      throw new Error('No lyric lines found in the text file.');
    }
    await idb.put(LOCAL_KEY(key), text);
  }
  cached = null;
}

export async function removeLocal(key: PackFileKey): Promise<void> {
  await idb.delete(LOCAL_KEY(key));
  cached = null;
}

/** Save lyric timing from the sync tool (local store) and return the downloadable JSON. */
export async function saveTimingLocal(json: string): Promise<void> {
  await idb.put(LOCAL_KEY('timing'), json);
  cached = null;
}

export async function saveLyricsLocal(text: string): Promise<void> {
  if (!parseLyrics(text).lines.length) throw new Error('No lyric lines found.');
  await idb.put(LOCAL_KEY('lyrics'), text);
  cached = null;
}
