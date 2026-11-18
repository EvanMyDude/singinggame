import { idb } from './idb';
import type { TakeAudio } from './take';

/**
 * Recorded takes, stored in this browser's IndexedDB next to the song files:
 *
 *   rec:<id>:meta    JSON description (written last, so a failed save is never listed)
 *   rec:<id>:mic     the voice, 16-bit mono PCM
 *   rec:<id>:music   the music as heard, 16-bit interleaved PCM (absent for a mic-only take)
 *   rec:<id>:frames  per voice frame: take time, song time, pitch (three float32 columns)
 *
 * Song ids cannot contain ":", so these keys never collide with a song's `<id>/<slot>` keys.
 * Nothing is uploaded; the download buttons are the way out.
 */

export interface TakeMeta {
  version: 1;
  id: string;
  createdAt: string;
  name: string;
  mode: 'sing' | 'practice' | 'monitor';
  songId: string | null;
  songTitle: string | null;
  sampleRate: number;
  /** 0 for a microphone-only take. */
  musicChannels: number;
  duration: number;
  /** Round-trip latency removed when lining the voice up with the music (s). */
  latency: number;
  frameCount: number;
  /** Practice speeds used during the take. */
  speeds: number[];
  result?: { score: number; accuracy: number; grade: string };
  /** Voice level for playback and the mix download; null until chosen. */
  vocalGain: number | null;
  bytes: number;
}

const KEY = (id: string, part: 'meta' | 'mic' | 'music' | 'frames') => `rec:${id}:${part}`;

function newId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function storageError(e: unknown): Error {
  if ((e as { name?: string })?.name === 'QuotaExceededError') return new Error('This browser is out of storage space. Delete recordings you no longer need, then try again.');
  return e instanceof Error ? e : new Error(String(e));
}

export async function saveTake(take: TakeAudio, info: Pick<TakeMeta, 'mode' | 'songId' | 'songTitle' | 'latency' | 'speeds' | 'result'>): Promise<TakeMeta> {
  const id = newId();
  const created = new Date();
  const frames = new Float32Array(take.frames.t.length * 3);
  frames.set(take.frames.t, 0);
  frames.set(take.frames.song, take.frames.t.length);
  frames.set(take.frames.midi, 2 * take.frames.t.length);
  const parts: [string, Blob][] = [
    [KEY(id, 'mic'), new Blob([take.mic.slice().buffer])],
    [KEY(id, 'frames'), new Blob([frames.buffer])],
  ];
  if (take.music) parts.push([KEY(id, 'music'), new Blob([take.music.slice().buffer])]);
  const meta: TakeMeta = {
    version: 1,
    id,
    createdAt: created.toISOString(),
    name: `${info.songTitle ?? 'Pitch Monitor'} · ${created.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${created.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`,
    mode: info.mode,
    songId: info.songId,
    songTitle: info.songTitle,
    sampleRate: take.sampleRate,
    musicChannels: take.music ? take.musicChannels : 0,
    duration: take.duration,
    latency: info.latency,
    frameCount: take.frames.t.length,
    speeds: info.speeds,
    ...(info.result ? { result: info.result } : {}),
    vocalGain: null,
    bytes: parts.reduce((s, [, b]) => s + b.size, 0),
  };
  try {
    void navigator.storage?.persist?.().catch(() => false);
    for (const [k, b] of parts) await idb.put(k, b);
    await idb.put(KEY(id, 'meta'), JSON.stringify(meta));
  } catch (e) {
    await Promise.all(parts.map(([k]) => idb.delete(k).catch(() => undefined)));
    throw storageError(e);
  }
  return meta;
}

/** Every take, newest first. */
export async function listTakes(): Promise<TakeMeta[]> {
  let keys: string[];
  try {
    keys = await idb.keys();
  } catch {
    return [];
  }
  const metas = await Promise.all(
    keys
      .filter((k) => k.startsWith('rec:') && k.endsWith(':meta'))
      .map(async (k) => {
        try {
          return JSON.parse(String(await idb.get<string>(k))) as TakeMeta;
        } catch {
          return null;
        }
      }),
  );
  return metas.filter((m): m is TakeMeta => m !== null && m.version === 1).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getTakeMeta(id: string): Promise<TakeMeta | null> {
  try {
    const raw = await idb.get<string>(KEY(id, 'meta'));
    return raw ? (JSON.parse(raw) as TakeMeta) : null;
  } catch {
    return null;
  }
}

/** A take's audio and frames, as recorded. */
export async function loadTake(meta: TakeMeta): Promise<TakeAudio> {
  const read = async (part: 'mic' | 'music' | 'frames') => {
    const b = await idb.get<Blob>(KEY(meta.id, part));
    return b instanceof Blob ? b.arrayBuffer() : null;
  };
  const [mic, music, frames] = await Promise.all([read('mic'), meta.musicChannels ? read('music') : Promise.resolve(null), read('frames')]);
  if (!mic) throw new Error('The recording’s audio is missing from this browser.');
  const f = frames ? new Float32Array(frames) : new Float32Array(0);
  const n = meta.frameCount;
  return {
    sampleRate: meta.sampleRate,
    mic: new Int16Array(mic),
    music: music ? new Int16Array(music) : null,
    musicChannels: meta.musicChannels,
    duration: meta.duration,
    frames: { t: f.subarray(0, n), song: f.subarray(n, 2 * n), midi: f.subarray(2 * n, 3 * n) },
  };
}

export async function updateTake(id: string, patch: Partial<Pick<TakeMeta, 'name' | 'vocalGain' | 'result'>>): Promise<TakeMeta | null> {
  const meta = await getTakeMeta(id);
  if (!meta) return null;
  const next = { ...meta, ...patch };
  await idb.put(KEY(id, 'meta'), JSON.stringify(next));
  return next;
}

export async function deleteTake(id: string): Promise<void> {
  await idb.delete(KEY(id, 'meta'));
  for (const part of ['mic', 'music', 'frames'] as const) await idb.delete(KEY(id, part));
}
